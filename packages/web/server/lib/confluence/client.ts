/**
 * The Confluence Data Center REST client: one authenticated GET per
 * resource, the same contract-shaped answers for every caller.
 *
 * DC instances often sit behind a reverse proxy with a self-signed
 * certificate, so certificate verification is per-instance state, not a
 * process-wide switch: the request goes through `node:https` with the
 * instance's own `rejectUnauthorized`. The fetch is injectable for tests;
 * the injected form answers `{ status, body }` exactly like the native one,
 * so tests exercise the same code paths as production.
 *
 * Failures classify into kinds the routes and the page view can answer
 * without guessing: `unauthorized` for a rejected personal access token,
 * `not-found` for a page the user cannot see, `unreachable` for network
 * and TLS trouble, and `server-error` for everything else.
 */

import http from 'node:http';
import https from 'node:https';

import { z } from 'zod';

import { isRecord } from '../shared/guards.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** Виды отказов, на которые отвечают маршруты и чтение страницы. */
export type ConfluenceErrorKind =
  | 'unconfigured'
  | 'unauthorized'
  | 'not-found'
  | 'unreachable'
  | 'server-error';

/** Соединение с инстансом, каким его собирают вызывающие. */
export interface ConfluenceInstanceConfig {
  origin: string;
  token: string;
  verifySsl?: boolean;
}

/** Форма одного транспорта-запроса: то, что нативный запрос читает. */
export interface ConfluenceJsonFetchInput {
  url: string;
  token: string;
  verifySsl: boolean | undefined;
  timeoutMs?: number;
}

export type ConfluenceJsonFetch = (input: ConfluenceJsonFetchInput) => Promise<{ status: number; body: string }>;

export interface ConfluenceRequestArgs {
  config?: ConfluenceInstanceConfig | null;
  path: string;
  search?: string;
}

export type ConfluenceRequestClient = (args: ConfluenceRequestArgs) => Promise<unknown>;

export type ConfluenceRequestFactory = (options?: { fetchImpl?: ConfluenceJsonFetch }) => ConfluenceRequestClient;

/**
 * One boundary helper for a thrown transport error's `code`: the modules
 * read a string, nothing else narrows the representation ad hoc.
 */
const errorCode = (error: unknown): string => {
  const parsed = z.string().safeParse(isRecord(error) ? error.code : undefined);
  return parsed.success ? parsed.data : '';
};

export class ConfluenceError extends Error {
  kind: ConfluenceErrorKind;
  status: number | null;

  constructor(kind: ConfluenceErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const classifyConfluenceFailure = (error: unknown): ConfluenceErrorKind => {
  if (error instanceof ConfluenceError) return error.kind;
  const code = errorCode(error);
  if ((isRecord(error) && error.name === 'AbortError')
    || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) {
    return 'unreachable';
  }
  return 'server-error';
};

const nativeRequest: ConfluenceJsonFetch = async ({ url, token, verifySsl, timeoutMs = REQUEST_TIMEOUT_MS }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const request = transport.request(
    target,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      rejectUnauthorized: verifySsl !== false,
      timeout: timeoutMs,
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    },
  );
  request.on('timeout', () => request.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
  request.on('error', reject);
  request.end();
});

/**
 * One GET for a JSON resource against a configured instance. The path is
 * the REST path (`/rest/api/...`); `search` appends query parameters.
 */
export const createConfluenceRequest: ConfluenceRequestFactory = ({ fetchImpl = nativeRequest } = {}) => {
  return async ({ config, path, search = '' }: ConfluenceRequestArgs) => {
    const settings: Partial<ConfluenceInstanceConfig> = config ?? {};
    const { origin, token, verifySsl } = settings;
    if (!origin || !token) throw new ConfluenceError('unconfigured', 'no Confluence instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${path}${search}`,
        token,
        verifySsl,
      });
    } catch (error) {
      throw Object.assign(new ConfluenceError(classifyConfluenceFailure(error), 'Confluence request failed', null), { cause: error });
    }
    const { status, body } = response;
    if (status === 401 || status === 403) throw new ConfluenceError('unauthorized', 'the personal access token was rejected', status);
    if (status === 404) throw new ConfluenceError('not-found', 'the page was not found', status);
    if (status < 200 || status >= 300) throw new ConfluenceError('server-error', `Confluence answered ${status}`, status);
    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      throw new ConfluenceError('server-error', 'Confluence answered with invalid JSON', status);
    }
    return parsed;
  };
};
