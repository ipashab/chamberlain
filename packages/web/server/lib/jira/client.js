/**
 * The Jira Data Center REST client: one authenticated request per
 * resource — GETs for every reader, POSTs for the tracker tool's writes —
 * the same contract-shaped answers for every caller.
 *
 * DC instances often sit behind a reverse proxy with a self-signed
 * certificate, so certificate verification is per-instance state, not a
 * process-wide switch: the request goes through `node:https` with the
 * instance's own `rejectUnauthorized`. The fetch is injectable for tests;
 * the injected form answers `{ status, body }` exactly like the native one,
 * so tests exercise the same code paths as production.
 *
 * Failures classify into kinds the routes and the issue view can answer
 * without guessing: `unauthorized` for a rejected personal access token,
 * `not-found` for an issue the user cannot see, `unreachable` for network
 * and TLS trouble, and `server-error` for everything else.
 */

import http from 'node:http';
import https from 'node:https';

import { z } from 'zod';

import { isString } from '../shared/guards.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One boundary helper for a thrown transport error's `code`: the modules
 * read a string, nothing else narrows the representation ad hoc.
 */
const errorCode = (error) => {
  const parsed = z.string().safeParse(error?.code);
  return parsed.success ? parsed.data : '';
};

export class JiraError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const classifyJiraFailure = (error) => {
  if (error instanceof JiraError) return error.kind;
  const code = errorCode(error);
  if (error?.name === 'AbortError'
    || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) {
    return 'unreachable';
  }
  return 'server-error';
};

const nativeRequest = async ({ url, token, verifySsl, timeoutMs = REQUEST_TIMEOUT_MS, method = 'GET', json = null }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const writeBody = method === 'GET' || method === 'HEAD' || json === null ? null : JSON.stringify(json);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };
  if (writeBody) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(writeBody);
  }
  const request = transport.request(
    target,
    {
      method,
      headers,
      rejectUnauthorized: verifySsl !== false,
      timeout: timeoutMs,
    },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    },
  );
  request.on('timeout', () => request.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
  request.on('error', reject);
  if (writeBody) request.write(writeBody);
  request.end();
});

/**
 * One GET for binary answers — avatars and icons. JSON answers decode the
 * body as UTF-8 on arrival; PNG/SVG bytes would not survive that, so this
 * transport keeps the buffer and the content type the instance swore to.
 */
const nativeImageRequest = async ({ url, token, verifySsl, timeoutMs = REQUEST_TIMEOUT_MS }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const request = transport.request(
    target,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      rejectUnauthorized: verifySsl !== false,
      timeout: timeoutMs,
    },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers['content-type'] ?? '',
        body: Buffer.concat(chunks),
      }));
    },
  );
  request.on('timeout', () => request.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
  request.on('error', reject);
  request.end();
});

/**
 * One GET for a JSON resource against a configured instance. The path is
 * the REST path (`/rest/api/2/...`); `search` appends query parameters.
 */
export const createJiraRequest = ({ fetchImpl = nativeRequest } = {}) => {
  return async ({ config, path, search = '' }) => {
    const { origin, token, verifySsl } = config ?? {};
    if (!origin || !token) throw new JiraError('unconfigured', 'no Jira instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${path}${search}`,
        token,
        verifySsl,
      });
    } catch (error) {
      throw Object.assign(new JiraError(classifyJiraFailure(error), 'Jira request failed', null), { cause: error });
    }
    const { status, body } = response;
    if (status === 401 || status === 403) throw new JiraError('unauthorized', 'the personal access token was rejected', status);
    if (status === 404) throw new JiraError('not-found', 'the issue was not found', status);
    if (status < 200 || status >= 300) throw new JiraError('server-error', `Jira answered ${status}`, status);
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      throw new JiraError('server-error', 'Jira answered with invalid JSON', status);
    }
    return parsed;
  };
};

/**
 * One mutation — a POST with a JSON body — against a configured instance.
 * Reads stay the JSON client above; this one answers write statuses: 201
 * carries the created resource, a bodyless 2xx (a transition answers 204)
 * is null, a 400 names what Jira rejected in its own message when it
 * parsed, and everything else reads like the GET client. The injected
 * fetch answers `{ status, body }` exactly like the native one, plus the
 * `method` and `json` it received.
 */
export const createJiraMutation = ({ fetchImpl = nativeRequest } = {}) => {
  return async ({ config, path, json = null }) => {
    const { origin, token, verifySsl } = config ?? {};
    if (!origin || !token) throw new JiraError('unconfigured', 'no Jira instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${path}`,
        token,
        verifySsl,
        method: 'POST',
        json,
      });
    } catch (error) {
      throw Object.assign(new JiraError(classifyJiraFailure(error), 'Jira request failed', null), { cause: error });
    }
    const { status, body } = response;
    if (status === 401 || status === 403) throw new JiraError('unauthorized', 'the personal access token was rejected', status);
    if (status === 404) throw new JiraError('not-found', 'the issue was not found', status);
    if (status === 400) throw new JiraError('invalid', responseMessage(body) ?? 'Jira rejected the request', status);
    if (status < 200 || status >= 300) throw new JiraError('server-error', `Jira answered ${status}`, status);
    if (!body) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new JiraError('server-error', 'Jira answered with invalid JSON', status);
    }
    return parsed;
  };
};

/**
 * The message a Jira error body carries, when it carries one: the
 * errorMessages of a 400 name the rejection in the instance's own words,
 * and a caller wording it for an agent quotes rather than invents.
 */
const responseMessage = (body) => {
  try {
    const parsed = body ? JSON.parse(body) : null;
    const errors = parsed?.errors;
    const message = parsed?.errorMessages?.[0] ?? (errors ? Object.values(errors)[0] : null);
    return isString(message) ? message.trim() : null;
  } catch {
    return null;
  }
};

/**
 * One GET that answers image bytes, not JSON: the avatar proxy's reader.
 * The same failure kinds as the JSON client, the same injectable fetch —
 * the injected form answers `{ status, contentType, body }` with a Buffer,
 * exactly like the native one.
 */
export const createJiraAvatarRequest = ({ fetchImpl = nativeImageRequest } = {}) => {
  return async ({ config, path, search = '' }) => {
    const { origin, token, verifySsl } = config ?? {};
    if (!origin || !token) throw new JiraError('unconfigured', 'no Jira instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${path}${search}`,
        token,
        verifySsl,
      });
    } catch (error) {
      throw Object.assign(new JiraError(classifyJiraFailure(error), 'Jira request failed', null), { cause: error });
    }
    const { status, contentType, body } = response;
    if (status === 401 || status === 403) throw new JiraError('unauthorized', 'the personal access token was rejected', status);
    if (status === 404) throw new JiraError('not-found', 'the image was not found', status);
    if (status < 200 || status >= 300) throw new JiraError('server-error', `Jira answered ${status}`, status);
    if (!body || body.length === 0) throw new JiraError('server-error', 'Jira answered with an empty image', status);
    return { contentType: contentType || 'image/png', bytes: body };
  };
};
