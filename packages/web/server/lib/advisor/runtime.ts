// The post-turn advisor runs once per idle session: it re-reads the turn's
// file-changing tool calls, runs the deterministic rules (`rules.js`) and
// anchor checks (`anchors.js`), optionally asks the Small Model to review the
// changed text, and stores the findings under session metadata
// `openchamber.advisor`. The payload is a note that sits under the answer,
// the same placement the recap uses; the advisor never messages the session,
// so it cannot loop the agent it just reviewed.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenCode } from '@opencode/client';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import { newestContentId } from '../session-assist/context.js';
import { collectTurnEdits } from './records.js';
import type { AdvisorFinding, TurnEdits } from './records.js';
import { applyRules, compileUserRules } from './rules.js';
import type { CompiledRule } from './rules.js';
import { verifyAnchors } from './anchors.js';
import { buildAdvisorPrompt, parseModelFindings } from './prompt.js';
import type { describeSmallModel, generateSmallModelText } from '../small-model/index.js';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const USER_RULES_FILE = path.join(OPENCHAMBER_DATA_DIR, 'advisor-rules.json');

const FETCH_TIMEOUT_MS = 5_000;
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_TOTAL_FINDINGS = 12;
// Enough records to look past the idle marker and a couple of switches.
const TAIL_RECHECK_LIMIT = 8;
const QUIET_FAILURE_CODES = new Set(['context-too-small', 'output-exhausted']);

/** Хранимый ревью: метаданные сессии `openchamber.advisor`, та же форма, что у рикапа. */
export interface AdvisorPayload {
  at: number;
  forMessageID: string;
  findings: AdvisorFinding[];
}

interface FailureFields {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
}

const hasFailureFields = (value: unknown): value is FailureFields => value != null;

// Off by default: every turn with file changes costs a Small Model call once
// enabled, so the toggle is a decision the operator makes once.
const getAdvisorEnabled = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return settings.sessionAdvisorEnabled === true;
};

const defaultReadUserRulesFile = async () => {
  try {
    return await fs.promises.readFile(USER_RULES_FILE, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

const defaultResolvePath = (sessionDirectory: string | undefined | null, filePath: string) =>
  path.isAbsolute(filePath) ? filePath : path.join(sessionDirectory ?? '', filePath);

const defaultReadFile = async (resolvedPath: string) => {
  try {
    return await fs.promises.readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

// Each observing runtime keeps its own copy of these two readers (the event
// hub translates wire events once; the consumers were written against that
// vocabulary and stay unaware of the wire shape).
const extractSessionStatus = (payload: unknown) => {
  if (!isRecord(payload) || payload.type !== 'session.status') return null;
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const status = isRecord(properties.status) ? properties.status : {};
  const info = isRecord(properties.info) ? properties.info : {};
  const sessionId = asNonEmptyString(properties.sessionID) ?? '';
  const type = asNonEmptyString(status.type) ?? asNonEmptyString(info.type) ?? '';
  if (!sessionId || !type) return null;
  const directory = asNonEmptyString(properties.directory) ?? asNonEmptyString(info.directory) ?? '';
  return { sessionId, type, directory };
};

const extractUserMessage = (payload: unknown) => {
  if (!isRecord(payload) || payload.type !== 'message.updated') return null;
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const info = properties.info;
  if (!isRecord(info) || info.role !== 'user') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  const time = isRecord(info.time) ? info.time : {};
  const created = Number.isFinite(time.created) ? time.created : 0;
  return { sessionId, createdAt: typeof created === 'number' ? created : 0 };
};

const describeGenerationFailure = (error: unknown) => {
  const failure = hasFailureFields(error) ? error : undefined;
  const parts: string[] = [];
  const status = Number(failure?.statusCode);
  if (Number.isFinite(status)) parts.push(`status ${status}`);
  const code = isString(failure?.code) ? failure.code.trim() : '';
  if (code) parts.push(`code ${code}`);
  const message = isString(failure?.message) ? failure.message.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
  if (message) parts.push(message);
  return parts.join(' | ');
};

/**
 * `persistAdvisor(sessionID, directory, advisor)` writes the payload through
 * the session metadata store, the same seam the recap uses (`null` deletes the
 * stored payload); without that seam the runtime stays inert rather than
 * reviewing turns whose findings could not be shown.
 */
export interface AdvisorLineage {
  remember: (sessionId: string, parentId: string | null) => void;
  isChild: (sessionId: string) => boolean | undefined;
}

export interface AdvisorRuntimeOptions {
  buildOpenCodeUrl: (route: string, prefixOverride?: string | null) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getSmallModelService: () => Promise<{
    describeSmallModel: typeof describeSmallModel;
    generateSmallModelText: typeof generateSmallModelText;
  }>;
  /** Пишет ревью через хранилище метаданных сессии; `null` удаляет сохранённое. */
  persistAdvisor?: ((sessionId: string, directory: string | undefined, advisor: AdvisorPayload | null) => unknown) | null;
  isSessionArchived?: (sessionId: string) => boolean | Promise<boolean>;
  lineage?: AdvisorLineage | null;
  getEnabled?: () => boolean;
  readUserRulesFile?: () => Promise<string | null>;
  readFile?: (resolvedPath: string) => Promise<string | null>;
  resolvePath?: (sessionDirectory: string | undefined | null, filePath: string) => string;
}

interface AdvisorRun {
  controller: AbortController;
  armedAt: number;
}

export const createAdvisorRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  persistAdvisor = null,
  isSessionArchived = async () => false,
  // `../session-lineage.js`: a known subsession is another session's turn, so
  // its own end arms nothing and reads nothing.
  lineage = null,
  getEnabled = getAdvisorEnabled,
  readUserRulesFile = defaultReadUserRulesFile,
  readFile = defaultReadFile,
  resolvePath = defaultResolvePath,
}: AdvisorRuntimeOptions) => {
  const runs = new Map<string, AdvisorRun>();
  const persisted = new Map<string, string>();
  let stopped = false;
  let userRulesNoticeLogged = false;
  let parkedNoticeLogged = false;

  const invalidate = (sessionId: string) => {
    const run = runs.get(sessionId);
    runs.delete(sessionId);
    run?.controller.abort();
  };

  // A new turn makes the stored findings describe an older turn: delete them
  // so a fresh payload in metadata means the newest turn everywhere.
  const retireStored = (sessionId: string, directory: string) => {
    if (!persistAdvisor || !persisted.has(sessionId)) return;
    const storedDirectory = persisted.get(sessionId);
    persisted.delete(sessionId);
    Promise.resolve(persistAdvisor(sessionId, directory || storedDirectory, null))
      .catch(() => console.warn('[advisor] failed to retire a stale review'));
  };

  // The user's rules land whole-file, read once per turn: the file is small
  // and a per-process cache would serve yesterday's rules after an edit.
  const loadUserRules = async (): Promise<CompiledRule[]> => {
    let text: string | null = null;
    try {
      text = await readUserRulesFile();
    } catch {
      return [];
    }
    if (text === null) return [];
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!userRulesNoticeLogged) {
        userRulesNoticeLogged = true;
        console.warn('[advisor] advisor-rules.json is not valid JSON; the default rules stay on');
      }
      return [];
    }
    const { compiled, rejected } = compileUserRules(parsed);
    if (rejected.length && !userRulesNoticeLogged) {
      userRulesNoticeLogged = true;
      console.warn(`[advisor] skipped malformed advisor-rules.json entries: ${rejected.join('; ')}`);
    }
    return compiled;
  };

  const reviewWithSmallModel = async ({ directory, turn, signal }: {
    directory: string;
    turn: TurnEdits;
    signal: AbortSignal;
  }): Promise<AdvisorFinding[] | null> => {
    const { describeSmallModel, generateSmallModelText } = await getSmallModelService();
    const described = await describeSmallModel({
      directory,
      preferredProviderID: turn.preferred?.providerID,
      preferredModelID: turn.preferred?.modelID,
    });
    if (!described) return null;
    // A local server keeps one prompt cache per slot: a side request on the
    // session's own model evicts it, and the next turn reprocesses the whole
    // history, so only a different model may do the reviewing.
    if (described.localEndpoint
      && turn.preferred?.providerID === described.providerID
      && turn.preferred?.modelID === described.modelID) return null;
    const prompt = buildAdvisorPrompt({ records: turn.records, humanText: turn.humanText });
    if (!prompt) return null;
    let generated;
    try {
      generated = await generateSmallModelText({
        prompt: prompt.prompt, system: prompt.system, directory,
        preferredProviderID: turn.preferred?.providerID,
        preferredModelID: turn.preferred?.modelID,
        onOverflow: 'error', timeoutMs: GENERATION_TIMEOUT_MS, signal,
      });
    } catch (error) {
      const failure = hasFailureFields(error) ? error : undefined;
      if (!signal.aborted && Number(failure?.statusCode) !== 404
        && !(isString(failure?.code) && QUIET_FAILURE_CODES.has(failure.code))) {
        console.warn('[advisor] model review failed:', describeGenerationFailure(error));
      }
      return null;
    }
    return parseModelFindings(generated?.text) ?? [];
  };

  const runReview = async (sessionId: string, directory: string, signal: AbortSignal) => {
    if (!getEnabled()) return;
    if (!persistAdvisor) return;
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    // v2 scopes by header and rejects non-ASCII header values.
    const headers: Record<string, string> = { ...getOpenCodeAuthHeaders() };
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    const client = OpenCode.make({ baseUrl, headers });
    const requestOptions = () => ({ signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    const checkCurrent = () => {
      signal.throwIfAborted();
      if (buildOpenCodeUrl('/', '').replace(/\/$/, '') !== baseUrl) throw new Error('Advisor runtime changed');
    };
    const session = await client.session.get({ sessionID: sessionId }, requestOptions());
    checkCurrent();
    // Reverted history is not the active conversation.
    if (session?.id === sessionId) lineage?.remember(sessionId, session.parentID ?? null);
    if (session?.id !== sessionId || session.parentID || session.revert?.messageID) return;
    // An archived session is put away: no review is generated for it.
    if (await isSessionArchived(sessionId)) return;
    const turn = await collectTurnEdits({
      signal,
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        requestOptions(),
      ),
    });
    checkCurrent();
    if (!turn) return;

    const findings: AdvisorFinding[] = applyRules(turn.records, await loadUserRules());
    findings.push(...await verifyAnchors({
      records: turn.records,
      readFile: (resolvedPath) => readFile(resolvedPath),
      resolvePath: (filePath) => resolvePath(session.location?.directory || directory, filePath),
      signal,
    }));
    checkCurrent();
    const modelFindings = await reviewWithSmallModel({ directory, turn, signal });
    if (modelFindings) findings.push(...modelFindings);
    const capped = findings.slice(0, MAX_TOTAL_FINDINGS);
    if (!capped.length) return;

    // The newest content record must still close the same turn: when a user
    // message raced in, its own run replaces everything this run found.
    const latestPage = await client.message.list({ sessionID: sessionId, limit: TAIL_RECHECK_LIMIT, order: 'desc' }, requestOptions());
    checkCurrent();
    if (newestContentId(latestPage?.data) !== turn.lastAssistantId) return;

    await persistAdvisor(sessionId, directory, {
      at: Date.now(),
      forMessageID: turn.lastAssistantId,
      findings: capped,
    });
    persisted.set(sessionId, directory);
  };

  const onTurnEnd = (sessionId: string, directory: string) => {
    invalidate(sessionId);
    const controller = new AbortController();
    const run: AdvisorRun = { controller, armedAt: Date.now() };
    runs.set(sessionId, run);
    Promise.resolve()
      .then(() => runReview(sessionId, directory, controller.signal))
      .catch((error: unknown) => {
        const detail = hasFailureFields(error) ? error.message : undefined;
        if (!controller.signal.aborted) console.warn('[advisor] review failed:', detail ?? error);
      })
      .finally(() => {
        if (runs.get(sessionId) === run) runs.delete(sessionId);
      });
  };

  const processPayload = (payload: unknown, directoryHint = '') => {
    if (stopped) return;
    if (!persistAdvisor) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[advisor] parked: no session metadata store is wired, so a review could not be saved');
      }
      return;
    }
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'idle') {
        if (lineage?.isChild(status.sessionId) !== true) onTurnEnd(status.sessionId, status.directory || directoryHint);
      } else {
        invalidate(status.sessionId);
        retireStored(status.sessionId, status.directory || directoryHint);
      }
      return;
    }
    const userMessage = extractUserMessage(payload);
    // Ignore old message.updated events re-emitted after completion.
    if (userMessage) {
      const run = runs.get(userMessage.sessionId);
      if (run && userMessage.createdAt >= run.armedAt) invalidate(userMessage.sessionId);
    }
  };

  const stop = () => {
    stopped = true;
    for (const { controller } of runs.values()) controller.abort();
    runs.clear();
  };

  return { processPayload, stop };
};
