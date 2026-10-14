/**
 * Engines runtime: assembles registry + probe into the three actions the host
 * needs — snapshot, active engine, probe.
 *
 * Two deliberate performance/stability calls:
 *   1) /health is a hot path (probed every ~30s, polled by the UI), so its
 *      snapshot reads DESCRIPTORS ONLY and never probes — the declarations
 *      already carry everything the UI needs;
 *   2) the directory read and the network probe each keep a short cache
 *      (10s / 5s by default) so a request never touches disk or an engine
 *      more often than that. Two separate TTLs: descriptors barely change,
 *      probe answers change fast.
 *
 * Selection knob: the OC_ENGINE environment variable. The settings registry
 * owns what the UI can persist, so a settings field for engine selection
 * belongs to that registry's process, not to this module.
 */

import { z } from 'zod';
import { DEFAULT_ENGINES_DIR, asNonEmptyString, loadEngineDescriptors, resolveActiveEngine } from './registry.js';
import { BUILTIN_OPENCODE_DESCRIPTOR, describeEngineForApi } from './descriptor.js';
import { probeEngine } from './probe.js';
import { registerEngineRoutes } from './routes.js';

const DEFAULT_REGISTRY_CACHE_MS = 10_000;
const DEFAULT_PROBE_CACHE_MS = 5_000;

export const createEnginesRuntime = ({
  env = process.env,
  fsPromises,
  getEngineBaseUrl = () => '',
  getEngineAuthHeaders = () => ({}),
  logger = console,
  fetchImpl,
  registryCacheMs = DEFAULT_REGISTRY_CACHE_MS,
  probeCacheMs = DEFAULT_PROBE_CACHE_MS,
  now = () => Date.now(),
} = {}) => {
  let registryCache = null; // { at, value }
  let probeCache = null; // { at, key, value }
  // /health is a synchronous handler while reading a directory is not — so a
  // second, SYNCHRONOUSLY readable copy of the latest snapshot lives here:
  // the async side refreshes it, /health just reads. Before it warms up it
  // is null, never a fabricated default — a broken registry must be visible
  // in monitoring, not masked by a plausible-looking value.
  let cachedSnapshot = null;
  let cachedSnapshotAt = 0;
  let snapshotRefreshing = false;

  const getRegistry = async ({ force = false } = {}) => {
    const at = now();
    if (!force && registryCache && at - registryCache.at < registryCacheMs) return registryCache.value;
    const loaded = await loadEngineDescriptors({
      dir: asNonEmptyString(env?.OC_ENGINES_DIR) || DEFAULT_ENGINES_DIR,
      readdir: (...args) => fsPromises.readdir(...args),
      readFile: (...args) => fsPromises.readFile(...args),
      logger,
    });
    const requestedId = asNonEmptyString(env?.OC_ENGINE) || null;
    const { engine, reason } = resolveActiveEngine({ descriptors: loaded.descriptors, requestedId, env });
    const value = {
      ...loaded,
      requestedId,
      activeEngineId: engine.id,
      activeReason: reason,
      builtinId: BUILTIN_OPENCODE_DESCRIPTOR.id,
    };
    registryCache = { at, value };
    return value;
  };

  const resolveBaseUrl = () => {
    try {
      return z.string().catch('').parse(getEngineBaseUrl()).replace(/\/+$/, '');
    } catch {
      // buildOpenCodeUrl throws while the engine is not up yet — a snapshot
      // must not fail for that.
      return '';
    }
  };

  /**
   * Which URL this engine should be probed at.
   *
   * A descriptor that declares `endpoint.url` gets probed there (REQUIRED
   * when several engines coexist); without one the probe falls back to the
   * host's single engine address — exactly how the built-in opencode works,
   * so this is backwards compatible.
   */
  const resolveBaseUrlFor = (descriptor) => {
    const own = asNonEmptyString(descriptor?.endpoint?.url);
    return own ? own.replace(/\/+$/, '') : resolveBaseUrl();
  };

  const resolveAuthHeaders = () => {
    try {
      return z.record(z.string(), z.string()).catch({}).parse(getEngineAuthHeaders());
    } catch {
      return {};
    }
  };

  /** Descriptor-only snapshot, for /health and /api/openchamber/engines. */
  const getSnapshot = async ({ force = false } = {}) => {
    const registry = await getRegistry({ force });
    const active = registry.descriptors.find((d) => d.id === registry.activeEngineId) ?? BUILTIN_OPENCODE_DESCRIPTOR;
    const snapshot = {
      dir: registry.dir,
      dirReadable: registry.dirReadable,
      warnings: registry.warnings,
      requestedId: registry.requestedId,
      activeReason: registry.activeReason,
      active: describeEngineForApi(active),
      engines: registry.descriptors.map(describeEngineForApi),
    };
    cachedSnapshot = snapshot;
    cachedSnapshotAt = now();
    return snapshot;
  };

  /**
   * Synchronously read the latest snapshot (null before warmup).
   *
   * A stale read re-computes in the background (stale-while-revalidate):
   * without that, the snapshot only refreshes when /api/openchamber/engines
   * is hit or on warmup, so /health would keep reporting the old engine until
   * someone touched that route. Stays synchronous: return the copy in hand,
   * refresh behind it, one refresh at a time.
   */
  const getCachedSnapshot = () => {
    const stale = !cachedSnapshot || now() - cachedSnapshotAt >= registryCacheMs;
    if (stale && !snapshotRefreshing) {
      snapshotRefreshing = true;
      void getSnapshot()
        .catch((error) => logger.warn?.(`[engines] registry refresh failed: ${error?.message ?? error}`))
        .finally(() => { snapshotRefreshing = false; });
    }
    return cachedSnapshot;
  };

  /** Ask the engine once for real — for /api/openchamber/engines/active, probe cached briefly. */
  const probeActive = async ({ force = false } = {}) => {
    const registry = await getRegistry({ force });
    const active = registry.descriptors.find((d) => d.id === registry.activeEngineId) ?? BUILTIN_OPENCODE_DESCRIPTOR;
    const baseUrl = resolveBaseUrlFor(active);
    const key = `${active.id}|${baseUrl}`;
    const at = now();
    if (!force && probeCache && probeCache.key === key && at - probeCache.at < probeCacheMs) {
      return { engine: describeEngineForApi(active), probe: probeCache.value, cached: true };
    }
    const probe = await probeEngine({
      descriptor: active,
      baseUrl,
      authHeaders: resolveAuthHeaders(),
      fetchImpl,
      now,
    });
    // Report WHICH address was probed — with several engines alongside,
    // that is the prerequisite for reading probe.ok at all.
    const value = { ...probe, baseUrl: baseUrl || null, source: asNonEmptyString(active?.endpoint?.url) ? 'descriptor' : 'host' };
    probeCache = { at, key, value };
    return { engine: describeEngineForApi(active), probe: value, cached: false };
  };

  /**
   * Synchronously: has the ACTIVE engine declared its own URL? (else null.)
   *
   * For the PROXY layer — called on every request, so it reads the cache
   * only and never does I/O or probing: one probe is an HTTP round trip,
   * and putting that on the request path would double latency; calling
   * getCachedSnapshot() on the way keeps a stale cache refreshing in the
   * background, so after OC_ENGINE changes the proxy target follows within
   * at most one cache period, no restart.
   *
   * null means "route the way the host always has" (the built-in opencode),
   * so the default behavior is byte-for-byte what it was before this
   * function existed.
   */
  const getActiveEngineOwnUrl = () => {
    getCachedSnapshot();
    const own = asNonEmptyString(cachedSnapshot?.active?.endpointUrl);
    return own ? own.replace(/\/+$/, '') : null;
  };

  const registerRoutes = (app) => {
    // Warm the snapshot (fire-and-forget): /health is synchronous and must
    // not answer null the first time it is probed after boot. Logging only —
    // an unreadable registry must not block startup.
    void getSnapshot().catch((error) => {
      logger.warn?.(`[engines] registry warmup failed: ${error?.message ?? error}`);
    });
    return registerEngineRoutes(app, { getSnapshot, probeActive });
  };

  return { getSnapshot, getCachedSnapshot, probeActive, getActiveEngineOwnUrl, registerRoutes };
};
