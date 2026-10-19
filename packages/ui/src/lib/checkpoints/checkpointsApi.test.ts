import { describe, expect, test } from 'bun:test';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { checkpointsApi } from './checkpointsApi';

// The API client is the wire boundary: a shape the server did not send must
// fail the fetch, and a graded error must keep the server's own words.

const entry = {
  id: 'u_1',
  userMessageID: 'u_1',
  directory: '/repo',
  tree: 'f'.repeat(40),
  baseRefName: 'refs/openchamber/checkpoints/ses_1/100/base',
  createdAt: 100,
  files: ['a.py'],
  truncated: false,
  restored: null,
};

type FetchLog = { url: string; init?: RequestInit };

const fetchAnswering = (responses: Record<string, { status?: number; body: unknown }>) => {
  const log: FetchLog[] = [];
  const fetchImpl: typeof runtimeFetch = async (rawInput, init) => {
    const path = String(rawInput);
    log.push({ url: path, init });
    const answer = responses[path];
    if (!answer) {
      return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 404 });
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetchImpl, log };
};

describe('checkpointsApi', () => {
  test('lists the registry of a session', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/checkpoints?sessionID=ses_1': { body: { sessionID: 'ses_1', checkpoints: [entry] } },
    });
    const entries = await checkpointsApi.list('ses_1', fetchImpl);
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual(['a.py']);
    expect(entries[0].baseRefName).toBe('refs/openchamber/checkpoints/ses_1/100/base');
  });

  test('fails a list answer that does not match the contract', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/checkpoints?sessionID=ses_1': { body: { sessionID: 'ses_1' } },
    });
    await expect(checkpointsApi.list('ses_1', fetchImpl)).rejects.toThrow('expected shape');
  });

  test('carries the server message from a graded failure', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/checkpoints?sessionID=ses_1': { status: 500, body: { error: 'The checkpoint registry could not be read' } },
    });
    await expect(checkpointsApi.list('ses_1', fetchImpl)).rejects.toThrow('registry could not be read');
  });

  test('restores a checkpoint and parses the outcome', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/checkpoints/restore': {
        body: {
          sessionID: 'ses_1',
          checkpointID: 'u_1',
          restored: ['a.py'],
          removed: ['b.txt'],
          skipped: [{ path: 'dist/x', reason: 'ignored' }],
        },
      },
    });
    const outcome = await checkpointsApi.restore('ses_1', 'u_1', false, fetchImpl);
    expect(log[0].url).toBe('/api/openchamber/checkpoints/restore');
    expect(outcome.removed).toEqual(['b.txt']);
    expect(outcome.skipped[0].reason).toBe('ignored');
  });

  test('trims an undo failure to the server words', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/checkpoints/restore': { status: 400, body: { error: 'Nothing to undo yet: this checkpoint was never restored' } },
    });
    await expect(checkpointsApi.restore('ses_1', 'u_1', true, fetchImpl)).rejects.toThrow('Nothing to undo yet');
  });
});
