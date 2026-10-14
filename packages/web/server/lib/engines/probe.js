/**
 * Engine probing: ask one engine, described by its own DESCRIPTOR, "are you
 * alive and what version are you".
 *
 * Versus network-runtime's waitForReady: that one is part of the lifecycle
 * (waiting after a spawn) with opencode semantics hard-coded; this one is a
 * read-only single probe where path, field and auth all come from the
 * descriptor, feeding the registry and the UI. The two coexist on purpose
 * (behavior preservation while only one engine is driven); merging is a
 * conversation for when a second engine actually lands.
 *
 * Every external input (descriptor fields, base URL, auth headers, the
 * response body) is parsed into shape HERE once; the code below handles
 * domain values only, with no per-use type checks.
 */

import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 5000;

/** A health body must be a JSON object; fields are up to the engine. */
const healthBodySchema = z.record(z.string(), z.unknown());

const nonEmptyString = () => z.string().trim().min(1);

const asNonEmptyStringOrNull = (value) => {
  const parsed = nonEmptyString().safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Version field fallback order: the descriptor's field first, then common names. */
const pickVersion = (body, field) => {
  const candidates = [field, 'version', 'openCodeVersion', 'openchamberVersion'].filter(Boolean);
  for (const key of candidates) {
    const parsed = nonEmptyString().safeParse(body[key]);
    if (parsed.success) return parsed.data;
  }
  return null;
};

/**
 * @returns {Promise<{
 *   ok: boolean, status: number|null, version: string|null,
 *   latencyMs: number, healthPath: string|null, error: string|null, body: object|null
 * }>}
 */
export const probeEngine = async ({
  descriptor,
  baseUrl,
  authHeaders,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) => {
  const startedAt = now();
  const healthPath = asNonEmptyStringOrNull(descriptor?.endpoint?.healthPath);
  const base = z.string().catch('').parse(baseUrl).replace(/\/+$/, '');
  const versionField = asNonEmptyStringOrNull(descriptor?.versionProbe?.field);
  const headers = z.record(z.string(), z.string()).catch({}).parse(authHeaders);

  const fail = (error, status = null) => ({
    ok: false,
    status,
    version: null,
    latencyMs: Math.max(0, now() - startedAt),
    healthPath,
    error: error instanceof Error ? error.message : String(error),
    body: null,
  });

  if (!base) return fail('No engine URL is available (engine not ready or not configured)');
  if (!healthPath) return fail('The descriptor has no endpoint.healthPath to probe');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${healthPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, now() - startedAt);
    let raw = null;
    try {
      raw = await response.json();
    } catch {
      raw = null;
    }
    const parsedBody = healthBodySchema.safeParse(raw);
    const body = parsedBody.success ? parsedBody.data : null;
    if (!response.ok) {
      return { ok: false, status: response.status, version: null, latencyMs, healthPath, error: `HTTP ${response.status}`, body };
    }
    return {
      ok: true,
      status: response.status,
      version: body ? pickVersion(body, versionField) : null,
      latencyMs,
      healthPath,
      error: null,
      body,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return fail(aborted ? `Probe timed out (${timeoutMs}ms)` : error);
  } finally {
    clearTimeout(timer);
  }
};
