/**
 * The Bitbucket Data Center REST client: one authenticated request per
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
 * Failures classify into kinds the routes and the summary layer can answer
 * without guessing: `unauthorized` for a rejected token, `not-found` for a
 * pull request the user cannot see, `unreachable` for network and TLS
 * trouble, and `server-error` for everything else.
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

export class BitbucketError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export const classifyBitbucketFailure = (error) => {
  if (error instanceof BitbucketError) return error.kind;
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
 * One GET for binary answers — avatars. JSON answers decode the body as
 * UTF-8 on arrival; PNG bytes would not survive that, so this transport
 * keeps the buffer and the content type the instance swore to.
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
 * One GET against a configured instance. `ref` is a parsed pull-request
 * URL; `suffix` extends the pull's API path (`/diff`, `/activities`…), and
 * `search` appends query parameters when the resource pages.
 */
export const createBitbucketRequest = ({ fetchImpl = nativeRequest } = {}) => {
  return async ({ config, path, search = '' }) => {
    const { origin, context = '', token, verifySsl } = config ?? {};
    if (!origin || !token) throw new BitbucketError('unconfigured', 'no Bitbucket instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${context}${path}${search}`,
        token,
        verifySsl,
      });
    } catch (error) {
      throw Object.assign(new BitbucketError(classifyBitbucketFailure(error), 'Bitbucket request failed', null), { cause: error });
    }
    const { status, body } = response;
    if (status === 401 || status === 403) throw new BitbucketError('unauthorized', 'the access token was rejected', status);
    if (status === 404) throw new BitbucketError('not-found', 'the pull request was not found', status);
    if (status < 200 || status >= 300) throw new BitbucketError('server-error', `Bitbucket answered ${status}`, status);
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      throw new BitbucketError('server-error', 'Bitbucket answered with invalid JSON', status);
    }
    return parsed;
  };
};

/**
 * One mutation — a POST with a JSON body — against a configured instance.
 * Reads stay the JSON client above; this one answers write statuses: 201
 * carries the created resource, a bodyless 2xx is null, a 409 is `conflict`
 * with the instance's own message when it parsed, and a 400 is `invalid`
 * the same way. The injected fetch answers `{ status, body }` exactly like
 * the native one, plus the `method` and `json` it received.
 */
export const createBitbucketMutation = ({ fetchImpl = nativeRequest } = {}) => {
  return async ({ config, path, json = null }) => {
    const { origin, context = '', token, verifySsl } = config ?? {};
    if (!origin || !token) throw new BitbucketError('unconfigured', 'no Bitbucket instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${context}${path}`,
        token,
        verifySsl,
        method: 'POST',
        json,
      });
    } catch (error) {
      throw Object.assign(new BitbucketError(classifyBitbucketFailure(error), 'Bitbucket request failed', null), { cause: error });
    }
    const { status, body } = response;
    if (status === 401 || status === 403) throw new BitbucketError('unauthorized', 'the access token was rejected', status);
    if (status === 404) throw new BitbucketError('not-found', 'the pull request was not found', status);
    if (status === 400) {
      throw new BitbucketError('invalid', responseMessage(body) ?? `Bitbucket rejected the request`, status);
    }
    if (status === 409) {
      throw new BitbucketError('conflict', responseMessage(body) ?? 'Bitbucket answered 409 conflict', status);
    }
    if (status < 200 || status >= 300) throw new BitbucketError('server-error', `Bitbucket answered ${status}`, status);
    if (!body) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BitbucketError('server-error', 'Bitbucket answered with invalid JSON', status);
    }
    return parsed;
  };
};

/**
 * The message a DC error body carries, when it carries one: the errors
 * list of a 400/409 names the conflict in the instance's own words, and a
 * caller wording it for an agent quotes rather than invents.
 */
const responseMessage = (body) => {
  try {
    const parsed = body ? JSON.parse(body) : null;
    const message = parsed?.errors?.[0]?.message;
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
export const createBitbucketAvatarRequest = ({ fetchImpl = nativeImageRequest } = {}) => {
  return async ({ config, path, search = '' }) => {
    const { origin, context = '', token, verifySsl } = config ?? {};
    if (!origin || !token) throw new BitbucketError('unconfigured', 'no Bitbucket instance is configured');
    let response;
    try {
      response = await fetchImpl({
        url: `${origin}${context}${path}${search}`,
        token,
        verifySsl,
      });
    } catch (error) {
      throw Object.assign(new BitbucketError(classifyBitbucketFailure(error), 'Bitbucket request failed', null), { cause: error });
    }
    const { status, contentType, body } = response;
    if (status === 401 || status === 403) throw new BitbucketError('unauthorized', 'the access token was rejected', status);
    if (status === 404) throw new BitbucketError('not-found', 'the avatar was not found', status);
    if (status < 200 || status >= 300) throw new BitbucketError('server-error', `Bitbucket answered ${status}`, status);
    if (!body || body.length === 0) throw new BitbucketError('server-error', 'Bitbucket answered with an empty avatar', status);
    return { contentType: contentType || 'image/png', bytes: body };
  };
};
