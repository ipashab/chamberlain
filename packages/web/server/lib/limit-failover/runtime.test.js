import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLimitFailoverRuntime } from './runtime.js';
import {
  classifyFailure,
  DEFAULT_EXHAUSTION_MS,
  FALLBACK_RETURN_MS,
  GENERIC_EXHAUSTION_MS,
  parseLimitResetAt,
  parseModelChain,
  parseModelSetting,
} from './policy.js';

const NOW = Date.parse('2026-10-20T10:00:00.000Z');
const ACCOUNT_A = { id: 'cred_a', label: 'Work' };
const ACCOUNT_B = { id: 'cred_b', label: 'Personal' };
const ACCOUNT_C = { id: 'cred_c', label: 'Spare' };

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createRuntime = ({ settings = { accountSwitchProviders: ['anthropic'] }, now = () => NOW } = {}) => {
  const broadcastUiEvent = vi.fn();
  const runtime = createLimitFailoverRuntime({
    fsPromises: fs,
    path,
    instanceDir: os.tmpdir(),
    readSettings: async () => settings,
    authorizeRequest: (req) => req.headers.authorization === 'Bearer token',
    broadcastUiEvent,
    now,
  });
  return { runtime, broadcastUiEvent };
};

const quotaReport = (overrides = {}) => ({
  sessionID: 'ses_1',
  providerID: 'anthropic',
  modelID: 'claude-opus',
  error: { type: 'provider.quota', message: 'usage limit reached', body: null },
  proposed: { retry: false },
  credentials: [ACCOUNT_A, ACCOUNT_B],
  activeCredentialID: ACCOUNT_A.id,
  ...overrides,
});

describe('limit failure classification', () => {
  it('counts a quota error and a rate limit that waits a minute or more', () => {
    expect(classifyFailure(quotaReport(), NOW)).not.toBeNull();
    const rateLimit = (delay) => quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay } });
    expect(classifyFailure(rateLimit(15 * 60_000), NOW)).not.toBeNull();
    expect(classifyFailure(rateLimit(8_000), NOW)).toBeNull();
  });

  it('acts on any other error only once OpenCode has given up retrying it', () => {
    const other = (proposed) => quotaReport({ error: { type: 'provider.auth', message: '', body: null }, proposed });
    expect(classifyFailure(other({ retry: false }), NOW)).toEqual({ resetAt: NOW + GENERIC_EXHAUSTION_MS });
    expect(classifyFailure(other({ retry: true, delay: 30_000 }), NOW)).toBeNull();
    expect(classifyFailure(quotaReport({ error: { type: 'server.overloaded', message: '', body: null }, proposed: { retry: true, delay: 5_000 } }), NOW)).toBeNull();
    expect(classifyFailure(quotaReport({ error: { type: 'server.overloaded', message: '', body: null }, proposed: { retry: false } }), NOW))
      .toEqual({ resetAt: NOW + GENERIC_EXHAUSTION_MS });
    // A report without a usable proposed decision counts as "still retrying":
    // guessing "given up" would fail the session over on every transient error.
    const withoutDecision = quotaReport({ error: { type: 'provider.auth', message: '', body: null } });
    delete withoutDecision.proposed;
    expect(classifyFailure(withoutDecision, NOW)).toBeNull();
  });

  it('reads the reset from the body, and skips an account an hour when the body says nothing', () => {
    const body = (value) => ({ type: 'provider.quota', message: '', body: JSON.stringify(value) });
    expect(parseLimitResetAt(body({ error: { resets_in_seconds: 7200 } }), NOW)).toBe(NOW + 7_200_000);
    expect(parseLimitResetAt(body({ error: { type: 'rate_limit', resets_at: '2026-10-20T12:20:00.000Z' } }), NOW)).toBe(Date.parse('2026-10-20T12:20:00.000Z'));
    expect(parseLimitResetAt(body({ resets_at: Math.floor(NOW / 1000) + 600 }), NOW)).toBe(NOW + 600_000);
    expect(parseLimitResetAt(body({ resets_at: '2026-10-19T00:00:00.000Z' }), NOW)).toBeNull();
    expect(classifyFailure(quotaReport(), NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS });
  });

  it('counts OpenCode free-tier exhaustion and Console spend limits as quota errors', () => {
    for (const type of ['provider.free-limit', 'provider.budget-limit', 'provider.model-budget-limit']) {
      const report = quotaReport({ providerID: 'opencode', error: { type, message: '', body: null } });
      expect(classifyFailure(report, NOW)).toEqual({ resetAt: NOW + DEFAULT_EXHAUSTION_MS });
    }
  });

  it('takes the reset from retryAfterMs before the body, and ignores a zero wait', () => {
    const error = (retryAfterMs) => ({ type: 'provider.quota', message: '', body: JSON.stringify({ resets_in_seconds: 7200 }), retryAfterMs });
    expect(parseLimitResetAt(error(5 * 60_000), NOW)).toBe(NOW + 300_000);
    expect(parseLimitResetAt(error(0), NOW)).toBe(NOW + 7_200_000);
    const longRateLimit = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null, retryAfterMs: 10 * 60_000 },
      proposed: { retry: true, delay: 10_000 },
    });
    expect(classifyFailure(longRateLimit, NOW)).toEqual({ resetAt: NOW + 600_000 });
  });

  it('treats a short rate limit as a throttle even when the body names a near reset', () => {
    const report = quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: JSON.stringify({ retry_after: 20 }) },
      proposed: { retry: true, delay: 20_000 },
    });
    expect(classifyFailure(report, NOW)).toBeNull();
  });

  it('parses the stored fallback model, keeping slashes in the model id', () => {
    expect(parseModelSetting('openrouter/anthropic/claude-sonnet')).toEqual({ providerID: 'openrouter', id: 'anthropic/claude-sonnet' });
    expect(parseModelSetting('openai/gpt-5.6', 'high')).toEqual({ providerID: 'openai', id: 'gpt-5.6', variant: 'high' });
    expect(parseModelSetting('openai/gpt-5.6', '')).toEqual({ providerID: 'openai', id: 'gpt-5.6' });
    expect(parseModelSetting('nomodel')).toBeNull();
    expect(parseModelSetting('')).toBeNull();
  });

  it('parses the fallback chain, and falls back to the single model pair until the list was saved', () => {
    expect(parseModelChain({ fallbackModels: [] })).toEqual([]);
    expect(parseModelChain({})).toEqual([]);
    expect(parseModelChain({ fallbackModel: 'openai/gpt-5.6', fallbackVariant: 'high' })).toEqual([
      { providerID: 'openai', id: 'gpt-5.6', variant: 'high' },
    ]);
    expect(parseModelChain({
      fallbackModels: [
        { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
        { providerID: 'google', modelID: 'gemini-3/pro' },
        { providerID: 'openai', modelID: 'gpt-5.6' },
        'not-an-entry',
      ],
    })).toEqual([
      { providerID: 'openai', id: 'gpt-5.6', variant: 'high' },
      { providerID: 'google', id: 'gemini-3/pro' },
    ]);
  });
});

describe('limit failover decisions', () => {
  it('switches an opted-in provider to its next account, and announces it once the plugin made the switch', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const answer = await runtime.decide(quotaReport());
    expect(answer).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(broadcastUiEvent).not.toHaveBeenCalled();

    expect(runtime.settle(answer.ticket, true)).toBe(true);
    expect(broadcastUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'account', sessionId: 'ses_1', providerId: 'anthropic', fromAccount: 'Work', toAccount: 'Personal' },
    });
    // A ticket settles once.
    expect(runtime.settle(answer.ticket, true)).toBe(false);
  });

  it('announces nothing for a switch the plugin could not make, and forgets it', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({ now: () => now });
    const answer = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(answer.ticket, false);
    expect(broadcastUiEvent).not.toHaveBeenCalled();
    now += 1_000;
    // B was never made active, so a failure on B is B's own: no grace retry.
    const onB = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(onB)).resolves.toEqual({ action: 'none' });
  });

  it('leaves a provider the user did not opt in alone', async () => {
    const { runtime } = createRuntime({ settings: { accountSwitchProviders: ['openai'] } });
    await expect(runtime.decide(quotaReport())).resolves.toEqual({ action: 'none' });
  });

  it('ignores invalid stored selections and non-array account settings', async () => {
    const { runtime } = createRuntime({
      settings: { accountSwitchProviders: 'anthropic', fallbackModel: 123, fallbackVariant: {} },
    });
    await expect(runtime.decide(quotaReport())).resolves.toEqual({ action: 'none' });
    const fallback = createRuntime({
      settings: { fallbackModel: 'openai/gpt-5.6', fallbackVariant: 123 },
    });
    await expect(fallback.runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
  });

  it('ignores a short throttle', async () => {
    const { runtime } = createRuntime();
    const report = quotaReport({ error: { type: 'provider.rate-limit', message: '', body: null }, proposed: { retry: true, delay: 4_000 } });
    await expect(runtime.decide(report)).resolves.toEqual({ action: 'none' });
  });

  it('offers every stored account when no stored account is active', async () => {
    const { runtime } = createRuntime();
    // An environment key serves the provider; the stored accounts are all candidates, the last one too.
    await expect(runtime.decide(quotaReport({ credentials: [ACCOUNT_B], activeCredentialID: undefined })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('moves to the fallback model once every account has run out', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({
      settings: { accountSwitchProviders: ['anthropic'], fallbackModel: 'openai/gpt-5.6' },
      now: () => now,
    });
    await runtime.decide(quotaReport());
    now += 2 * 60_000;
    const answer = await runtime.decide(quotaReport({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id }));
    expect(answer).toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
    runtime.settle(answer.ticket, true);
    expect(broadcastUiEvent).toHaveBeenLastCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'model', sessionId: 'ses_1', providerId: 'anthropic', modelId: 'claude-opus', toProviderId: 'openai', toModelId: 'gpt-5.6', reason: 'limit' },
    });
  });

  it('switches to the fallback model with its thinking level', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'openai/gpt-5.6', fallbackVariant: 'high' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6', variant: 'high' } });
  });

  it('uses the fallback model without account switching, and stops on the fallback itself', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'anthropic/claude-sonnet' } });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-sonnet' } });
    await expect(runtime.decide(quotaReport({ modelID: 'claude-sonnet' }))).resolves.toEqual({ action: 'none' });
  });

  it('walks the fallback chain in order as each model fails for the session', async () => {
    const { runtime } = createRuntime({
      settings: {
        fallbackModels: [
          { providerID: 'openai', modelID: 'gpt-5.6' },
          { providerID: 'google', modelID: 'gemini-3/pro', variant: 'high' },
        ],
      },
    });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
    await expect(runtime.decide(quotaReport({ providerID: 'openai', modelID: 'gpt-5.6' })))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'google', id: 'gemini-3/pro', variant: 'high' } });
    await expect(runtime.decide(quotaReport({ providerID: 'google', modelID: 'gemini-3/pro' }))).resolves.toEqual({ action: 'none' });
  });

  it('tracks the chain per session: another session on the primary still gets the top of it', async () => {
    const { runtime } = createRuntime({
      settings: {
        fallbackModels: [
          { providerID: 'openai', modelID: 'gpt-5.6' },
          { providerID: 'google', modelID: 'gemini-3/pro' },
        ],
      },
    });
    await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    await expect(runtime.decide(quotaReport({ sessionID: 'ses_2' })))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
  });

  it('a session that returned to the primary starts the chain from the top when the primary fails again', async () => {
    let now = NOW;
    const { runtime } = createRuntime({
      settings: {
        fallbackModels: [
          { providerID: 'openai', modelID: 'gpt-5.6' },
          { providerID: 'google', modelID: 'gemini-3/pro' },
        ],
      },
      now: () => now,
    });
    const first = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(first.ticket, true);
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    const back = await runtime.decideReturn({ sessionID: 'ses_1', providerID: 'openai', modelID: 'gpt-5.6' });
    expect(back).toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-opus' } });
    runtime.settle(back.ticket, true);
    // The exhausted marks from the first episode have expired, so the chain opens at the top again.
    await expect(runtime.decide(quotaReport({ sessionID: 'ses_1' })))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
  });

  it('falls back on a failure OpenCode gave up on, and lets its own backoff stand while it retries', async () => {
    const { runtime } = createRuntime({ settings: { fallbackModel: 'openai/gpt-5.6' } });
    const overloaded = (proposed) => quotaReport({ error: { type: 'server.overloaded', message: '', body: null }, proposed });
    await expect(runtime.decide(overloaded({ retry: true, delay: 5_000 }))).resolves.toEqual({ action: 'none' });
    await expect(runtime.decide(overloaded({ retry: false })))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
  });

  it('skips an account that ran out until its reset, then offers it again', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const three = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
    await runtime.decide(quotaReport({ credentials: three }));
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_C.id });
    now += 2 * 60_000;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS;
    await expect(runtime.decide(quotaReport({ credentials: three, activeCredentialID: ACCOUNT_C.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('skips an account only as long as the rate limit says to wait', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const longRateLimit = (overrides) => quotaReport({
      error: { type: 'provider.rate-limit', message: '', body: null },
      proposed: { retry: true, delay: 180_000 },
      ...overrides,
    });
    await runtime.decide(longRateLimit({}));
    now += 4 * 60_000;
    // A's three-minute wait is over, so A is the way out when B runs out.
    await expect(runtime.decide(longRateLimit({ credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id })))
      .resolves.toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_A.id });
  });

  it('gives another session one retry on the account just switched to, without blaming it', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ now: () => now });
    const first = await runtime.decide(quotaReport({ sessionID: 'ses_1' }));
    runtime.settle(first.ticket, true);
    now += 1_000;
    // ses_2's request went out with A, but the plugin reads B as active by now.
    const stale = quotaReport({ sessionID: 'ses_2', credentials: [ACCOUNT_B, ACCOUNT_A], activeCredentialID: ACCOUNT_B.id });
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'retry' });
    // A second failure on B from the same session is real: B has run out too.
    await expect(runtime.decide(stale)).resolves.toEqual({ action: 'none' });
  });

  it('switches once when two sessions report the same account together', async () => {
    const { runtime, broadcastUiEvent } = createRuntime();
    const [first, second] = await Promise.all([
      runtime.decide(quotaReport({ sessionID: 'ses_1' })),
      runtime.decide(quotaReport({ sessionID: 'ses_2' })),
    ]);
    expect(first).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    expect(second).toEqual({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
    runtime.settle(first.ticket, true);
    expect(broadcastUiEvent).toHaveBeenCalledTimes(1);
  });
});

describe('returning to the original model', () => {
  const chainSettings = { fallbackModels: [{ providerID: 'openai', modelID: 'gpt-5.6' }] };
  const probe = (overrides = {}) => ({ sessionID: 'ses_1', providerID: 'openai', modelID: 'gpt-5.6', ...overrides });

  it('returns a session to the model it came from once the cooldown and the failure window have passed', async () => {
    let now = NOW;
    const { runtime, broadcastUiEvent } = createRuntime({ settings: chainSettings, now: () => now });
    const answer = await runtime.decide(quotaReport());
    runtime.settle(answer.ticket, true);

    // The primary took a quota error an hour wide, so the return waits for it.
    await expect(runtime.decideReturn(probe())).resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    const back = await runtime.decideReturn(probe());
    expect(back).toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-opus' } });
    runtime.settle(back.ticket, true);
    expect(broadcastUiEvent).toHaveBeenLastCalledWith({
      type: 'openchamber:limit-failover',
      properties: { kind: 'model-return', sessionId: 'ses_1', providerId: 'openai', modelId: 'gpt-5.6', toProviderId: 'anthropic', toModelId: 'claude-opus' },
    });
    // The episode is over: the session is back where it started.
    await expect(runtime.decideReturn(probe({ providerID: 'anthropic', modelID: 'claude-opus' }))).resolves.toEqual({ action: 'none' });
  });

  it('keeps a session on its fallback while it reports a chain model before the cooldown', async () => {
    let now = NOW;
    const { runtime } = createRuntime({
      settings: { fallbackModels: [{ providerID: 'openai', modelID: 'gpt-5.6' }, { providerID: 'google', modelID: 'gemini-3/pro' }] },
      now: () => now,
    });
    const first = await runtime.decide(quotaReport());
    runtime.settle(first.ticket, true);
    const second = await runtime.decide(quotaReport({ providerID: 'openai', modelID: 'gpt-5.6' }));
    runtime.settle(second.ticket, true);
    now += FALLBACK_RETURN_MS + 1_000;
    // The original is still inside its failure window; the chain's next model is not a return target.
    await expect(runtime.decideReturn(probe({ providerID: 'google', modelID: 'gemini-3/pro' }))).resolves.toEqual({ action: 'none' });
  });

  it('ends the episode when the session moved to a model outside the chain', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ settings: chainSettings, now: () => now });
    const answer = await runtime.decide(quotaReport());
    runtime.settle(answer.ticket, true);
    await expect(runtime.decideReturn(probe({ providerID: 'moonshot', modelID: 'kimi-2' }))).resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    await expect(runtime.decideReturn(probe())).resolves.toEqual({ action: 'none' });
  });

  it('keeps the episode when the settle report is lost, so the session still returns', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ settings: chainSettings, now: () => now });
    // The switch decision is made but its settle report never reaches the
    // server; the plugin still applied the switch, so the probe reports the
    // chain model the session now runs on.
    await runtime.decide(quotaReport());
    await expect(runtime.decideReturn(probe())).resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    await expect(runtime.decideReturn(probe()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-opus' } });
  });

  it('retracts the episode when the switch is reported as failed', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ settings: chainSettings, now: () => now });
    const answer = await runtime.decide(quotaReport());
    runtime.settle(answer.ticket, false);
    // The session never left its model; a probe reports it where it stands.
    await expect(runtime.decideReturn(probe({ providerID: 'anthropic', modelID: 'claude-opus' }))).resolves.toEqual({ action: 'none' });
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    await expect(runtime.decideReturn(probe())).resolves.toEqual({ action: 'none' });
  });

  it('answers a plain retry for a second failure of the same session and model within the switch grace', async () => {
    const { runtime } = createRuntime({ settings: chainSettings });
    await expect(runtime.decide(quotaReport()))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } });
    await expect(runtime.decide(quotaReport())).resolves.toEqual({ action: 'retry' });
  });

  it('answers a plain retry for a duplicate report on a later chain position within the switch grace', async () => {
    let now = NOW;
    const { runtime } = createRuntime({
      settings: { fallbackModels: [{ providerID: 'openai', modelID: 'gpt-5.6' }, { providerID: 'google', modelID: 'gemini-3/pro' }] },
      now: () => now,
    });
    const first = await runtime.decide(quotaReport());
    runtime.settle(first.ticket, true);
    now += 61_000; // past the switch grace
    const second = await runtime.decide(quotaReport({ providerID: 'openai', modelID: 'gpt-5.6' }));
    expect(second).toMatchObject({ action: 'switch-model', model: { providerID: 'google', id: 'gemini-3/pro' } });
    // A retry burst on the model the session just left must not announce the same move twice.
    await expect(runtime.decide(quotaReport({ providerID: 'openai', modelID: 'gpt-5.6' }))).resolves.toEqual({ action: 'retry' });
  });

  it('keeps the episode when a later hop fails to apply and the session stays on its chain model', async () => {
    let now = NOW;
    const { runtime } = createRuntime({
      settings: { fallbackModels: [{ providerID: 'openai', modelID: 'gpt-5.6' }, { providerID: 'google', modelID: 'gemini-3/pro' }] },
      now: () => now,
    });
    const first = await runtime.decide(quotaReport());
    runtime.settle(first.ticket, true);
    now += 61_000; // past the switch grace
    const second = await runtime.decide(quotaReport({ providerID: 'openai', modelID: 'gpt-5.6' }));
    runtime.settle(second.ticket, false);
    // The switch to the second chain model never happened; the session still
    // runs on the first one, and the original model may take it back later.
    now += DEFAULT_EXHAUSTION_MS;
    await expect(runtime.decideReturn({ sessionID: 'ses_1', providerID: 'openai', modelID: 'gpt-5.6' }))
      .resolves.toMatchObject({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-opus' } });
  });

  it('does not end the episode while a switch decision is still unsettled', async () => {
    let now = NOW;
    const { runtime } = createRuntime({ settings: chainSettings, now: () => now });
    await runtime.decide(quotaReport());
    // The chat.message hook fired on the original model in the window before
    // the plugin applied the switch; the pending ticket holds the episode.
    now += DEFAULT_EXHAUSTION_MS + FALLBACK_RETURN_MS;
    await expect(runtime.decideReturn({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-opus' })).resolves.toEqual({ action: 'none' });
    now += 60_000;
    await expect(runtime.decideReturn({ sessionID: 'ses_1', providerID: 'anthropic', modelID: 'claude-opus' })).resolves.toEqual({ action: 'none' });
  });

  it('refuses a malformed probe on the route', async () => {
    const { runtime } = createRuntime({ settings: chainSettings });
    const app = express();
    runtime.registerRoutes(app, express);
    await request(app).post('/api/openchamber/limit-failover/return').set('authorization', 'Bearer token').send({ sessionID: 'ses_1' }).expect(400);
    await request(app).post('/api/openchamber/limit-failover/return').send(probe()).expect(401);
    await request(app)
      .post('/api/openchamber/limit-failover/return')
      .set('authorization', 'Bearer token')
      .send(probe())
      .expect(200)
      .expect({ action: 'none' });
  });
});

describe('limit failover route', () => {
  const createApp = () => {
    const { runtime } = createRuntime();
    const app = express();
    runtime.registerRoutes(app, express);
    return app;
  };

  it('refuses a caller without the managed child token', async () => {
    await request(createApp()).post('/api/openchamber/limit-failover').send(quotaReport()).expect(401);
  });

  it('refuses a malformed report', async () => {
    await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send({ sessionID: 'ses_1' })
      .expect(400);
  });

  it('answers a valid report', async () => {
    const response = await request(createApp())
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    expect(response.body).toMatchObject({ action: 'activate-credential', credentialID: ACCOUNT_B.id });
  });

  it('settles a ticket only for the managed child, once', async () => {
    const app = createApp();
    const decided = await request(app)
      .post('/api/openchamber/limit-failover')
      .set('authorization', 'Bearer token')
      .send(quotaReport())
      .expect(200);
    await request(app).post('/api/openchamber/limit-failover/settle').send({ ticket: decided.body.ticket, applied: true }).expect(401);
    await request(app).post('/api/openchamber/limit-failover/settle').set('authorization', 'Bearer token').send({ ticket: 1 }).expect(400);
    const settled = await request(app)
      .post('/api/openchamber/limit-failover/settle')
      .set('authorization', 'Bearer token')
      .send({ ticket: decided.body.ticket, applied: true })
      .expect(200);
    expect(settled.body).toEqual({ settled: true });
  });
});

describe('limit failover plugin', () => {
  const loadPlugin = async () => {
    const instanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-limit-failover-'));
    temporaryDirectories.push(instanceDir);
    const runtime = createLimitFailoverRuntime({ fsPromises: fs, path, instanceDir, readSettings: async () => ({}), authorizeRequest: () => true });
    const directory = await runtime.materializePlugin();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    expect(manifest.exports['.']).toBe('./index.js');
    const module = await import(`${pathToFileURL(path.join(directory, 'index.js')).href}?t=${Date.now()}`);
    return module.default;
  };

  const createContext = () => {
    const hooks = {};
    return {
      hooks,
      ctx: {
        session: {
          hook: async (name, callback) => { hooks[name] = callback; },
          switchModel: vi.fn(async () => undefined),
        },
        provider: { get: vi.fn(async () => ({ location: {}, data: { id: 'anthropic', integrationID: 'anthropic' } })) },
        integration: {
          get: vi.fn(async () => ({
            location: {},
            data: { id: 'anthropic', connections: [{ type: 'env', name: 'ANTHROPIC_API_KEY' }, { type: 'credential', ...ACCOUNT_A }, { type: 'credential', ...ACCOUNT_B }] },
          })),
          connection: { active: vi.fn(async () => ({ type: 'credential', ...ACCOUNT_A })) },
        },
        credential: { activate: vi.fn(async () => undefined) },
      },
    };
  };

  const retryEvent = (type = 'provider.quota') => ({
    sessionID: 'ses_1',
    agent: 'build',
    model: { providerID: 'anthropic', id: 'claude-opus' },
    error: { type, message: 'usage limit', response: { body: '{}' }, retryAfterMs: 90_000 },
    attempt: 2,
    decision: { retry: false },
  });

  const withCallbackEnv = async (run) => {
    const saved = { url: process.env.OPENCHAMBER_AGENT_TOOL_URL, token: process.env.OPENCHAMBER_AGENT_TOOL_TOKEN };
    process.env.OPENCHAMBER_AGENT_TOOL_URL = 'http://127.0.0.1:4100/api/openchamber/agent-tool';
    process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = 'token';
    try {
      await run();
    } finally {
      for (const [key, value] of [['OPENCHAMBER_AGENT_TOOL_URL', saved.url], ['OPENCHAMBER_AGENT_TOOL_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.unstubAllGlobals();
    }
  };

  it('reports the failure with the stored accounts and activates the account the server names', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't1' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover');
      expect(init.headers.authorization).toBe('Bearer token');
      expect(JSON.parse(init.body)).toMatchObject({
        sessionID: 'ses_1',
        providerID: 'anthropic',
        modelID: 'claude-opus',
        error: { type: 'provider.quota', body: '{}', retryAfterMs: 90_000 },
        proposed: { retry: false },
        credentials: [ACCOUNT_A, ACCOUNT_B],
        activeCredentialID: ACCOUNT_A.id,
      });
      expect(ctx.credential.activate).toHaveBeenCalledWith({ credentialID: ACCOUNT_B.id });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
      const [settleUrl, settleInit] = fetchMock.mock.calls[1];
      expect(settleUrl).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover/settle');
      expect(JSON.parse(settleInit.body)).toEqual({ ticket: 't1', applied: true });
    });
  });

  it('reports a switch that failed and keeps OpenCode\'s decision', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    ctx.credential.activate.mockRejectedValueOnce(new Error('credential removed'));
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'activate-credential', credentialID: ACCOUNT_B.id, ticket: 't2' })));
      vi.stubGlobal('fetch', fetchMock);
      const event = retryEvent();
      await hooks.retry(event);
      expect(event.decision).toEqual({ retry: false });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ticket: 't2', applied: false });
    });
  });

  it('switches the session model when told to', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'switch-model', model: { providerID: 'openai', id: 'gpt-5.6' } }))));
      const event = retryEvent();
      await hooks.retry(event);
      expect(ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'openai', id: 'gpt-5.6' } });
      expect(event.decision).toEqual({ retry: true, delay: 0 });
    });
  });

  it("reports every error and keeps OpenCode's decision for a 'none' answer or a failed call", async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'none' })));
      vi.stubGlobal('fetch', fetchMock);

      const other = retryEvent('provider.internal');
      await hooks.retry(other);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).error.type).toBe('provider.internal');
      expect(other.decision).toEqual({ retry: false });

      await hooks.retry(retryEvent('provider.free-limit'));
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).error.type).toBe('provider.free-limit');
      await hooks.retry(retryEvent('provider.model-budget-limit'));
      expect(JSON.parse(fetchMock.mock.calls[2][1].body).error.type).toBe('provider.model-budget-limit');

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      const failed = retryEvent();
      await hooks.retry(failed);
      expect(failed.decision).toEqual({ retry: false });
      expect(ctx.credential.activate).not.toHaveBeenCalled();
    });
  });

  it('returns the session to the model the server names on a new message', async () => {
    const plugin = await loadPlugin();
    const { ctx, hooks } = createContext();
    await plugin.setup(ctx);
    await withCallbackEnv(async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: 'switch-model', model: { providerID: 'anthropic', id: 'claude-opus' }, ticket: 't3' })));
      vi.stubGlobal('fetch', fetchMock);
      await hooks['chat.message']({ sessionID: 'ses_1', agent: 'build', model: { providerID: 'openai', id: 'gpt-5.6' } });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:4100/api/openchamber/limit-failover/return');
      expect(JSON.parse(init.body)).toEqual({ sessionID: 'ses_1', providerID: 'openai', modelID: 'gpt-5.6' });
      expect(ctx.session.switchModel).toHaveBeenCalledWith({ sessionID: 'ses_1', model: { providerID: 'anthropic', id: 'claude-opus' } });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ticket: 't3', applied: true });

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ action: 'none' }))));
      await hooks['chat.message']({ sessionID: 'ses_1', model: { providerID: 'openai', id: 'gpt-5.6' } });
      expect(ctx.session.switchModel).toHaveBeenCalledTimes(1);
    });
  });
});
