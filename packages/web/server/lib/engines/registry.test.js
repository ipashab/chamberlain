import { describe, expect, test } from 'vitest';

import { BUILTIN_OPENCODE_DESCRIPTOR, parseEngineDescriptor } from './descriptor.js';
import { probeEngine } from './probe.js';
import { asNonEmptyString, loadEngineDescriptors, resolveActiveEngine } from './registry.js';

/** In-memory filesystem stand-in — the registry's fault tolerance gets pinned per file. */
const io = (files) => ({
  readdir: async (dir) => {
    if (files === null) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    if (files instanceof Error) throw files;
    return Object.keys(files);
  },
  readFile: async (file) => {
    const text = files[file.replace(/^\/etc\/oc-engines\//, '')];
    if (text === undefined) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return text;
  },
});

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const warnings = [];
const recording = { warn: (line) => warnings.push(line), log: () => {}, error: () => {} };

const validJson = (overrides = {}) => JSON.stringify({
  apiVersion: 1,
  id: 'fake-engine',
  name: 'Fake',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...overrides,
});

const load = async (files, { logger = quiet, dir = '/etc/oc-engines' } = {}) =>
  loadEngineDescriptors({ dir, ...io(files), logger });

describe('engine registry — directory fault tolerance', () => {
  test('a missing directory is the normal state: built-in only, no warnings', async () => {
    const result = await load(null);
    expect(result.descriptors.map((d) => d.id)).toEqual(['opencode']);
    expect(result.warnings).toEqual([]);
    expect(result.dirReadable).toBe(false);
  });

  test('an unreadable directory (other than ENOENT) is a warning, not a crash', async () => {
    const error = new Error('EACCES: permission denied');
    error.code = 'EACCES';
    warnings.length = 0;
    const result = await load(error, { logger: recording });
    expect(result.descriptors.map((d) => d.id)).toEqual(['opencode']);
    expect(result.warnings[0]).toContain('EACCES');
    expect(warnings.length).toBeGreaterThan(0);
  });

  test('an invalid JSON file is skipped and reported; valid siblings survive', async () => {
    const result = await load({ 'broken.json': '{ nope', 'codex.json': validJson({ id: 'codex', name: 'Codex' }) });
    expect(result.descriptors.map((d) => d.id).sort()).toEqual(['codex', 'opencode']);
    expect(result.warnings.join(' ')).toContain('broken.json');
    expect(result.dirReadable).toBe(true);
  });

  test('an invalid descriptor (schema-level) is skipped with its reason', async () => {
    const result = await load({ 'codex.json': validJson({ protocol: 'smolagents-v1' }) });
    expect(result.descriptors.map((d) => d.id)).toEqual(['opencode']);
    expect(result.warnings.join(' ')).toContain('codex.json');
  });

  test('two files fighting over one id: the first (sorted) wins and the loser is reported', async () => {
    const result = await load({
      'a-codex.json': validJson({ id: 'codex', name: 'From A' }),
      'b-codex.json': validJson({ id: 'codex', name: 'From B' }),
    });
    expect(result.descriptors.find((d) => d.id === 'codex')?.name).toBe('From A');
    expect(result.warnings.join(' ')).toContain('b-codex.json');
    expect(result.warnings.join(' ')).toContain('codex');
  });

  test('a file may override the builtin (explicit config beats implicit default)', async () => {
    const result = await load({
      'opencode.json': validJson({ id: 'opencode', name: 'Custom OpenCode', endpoint: { healthPath: '/probe', url: 'http://elsewhere:1' } }),
    });
    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0].name).toBe('Custom OpenCode');
    expect(result.descriptors[0].builtin).toBe(false);
  });

  test('non-JSON files are ignored without any noise', async () => {
    const result = await load({
      'README.md': 'hello',
      'subdir.json.bak': '{}',
      'codex.json': validJson({ id: 'codex' }),
    });
    expect(result.descriptors.map((d) => d.id).sort()).toEqual(['codex', 'opencode']);
    expect(result.warnings).toEqual([]);
  });

  test('unknown-capability warnings from a descriptor are prefixed with its file name', async () => {
    const result = await load({ 'codex.json': validJson({ capabilities: ['sessions', 'streaming', 'vibes'] }) });
    expect(result.warnings.join(' ')).toContain('codex.json: Unknown capabilities');
    expect(result.warnings.join(' ')).toContain('vibes');
  });
});

describe('engine registry — active engine resolution', () => {
  test('an explicit requested id wins', () => {
    const { engine, reason } = resolveActiveEngine({
      descriptors: [BUILTIN_OPENCODE_DESCRIPTOR, { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'codex' }],
      requestedId: 'codex',
    });
    expect(engine.id).toBe('codex');
    expect(reason).toBe('requested');
  });

  test('OC_ENGINE selects too, and the direct request outranks it', () => {
    const list = [BUILTIN_OPENCODE_DESCRIPTOR, { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'codex' }];
    expect(resolveActiveEngine({ descriptors: list, env: { OC_ENGINE: 'codex' } }).engine.id).toBe('codex');
    const both = resolveActiveEngine({ descriptors: [...list, { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'gemini' }], requestedId: 'gemini', env: { OC_ENGINE: 'codex' } });
    expect(both.engine.id).toBe('gemini');
  });

  test('an unknown requested id never selects: fall back, do not guess', () => {
    const { engine } = resolveActiveEngine({
      descriptors: [BUILTIN_OPENCODE_DESCRIPTOR],
      requestedId: 'does-not-exist',
    });
    expect(engine.id).toBe('opencode');
  });

  test('a single descriptor is the engine (only-one), even when it is the builtin', () => {
    expect(resolveActiveEngine({ descriptors: [BUILTIN_OPENCODE_DESCRIPTOR] }).reason).toBe('only-one');
    const solo = resolveActiveEngine({
      descriptors: [{ ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'codex', builtin: false }],
    });
    expect(solo.engine.id).toBe('codex');
    expect(solo.reason).toBe('only-one');
  });

  test('builtin opencode plus exactly one external engine: still the builtin, and the reason says so', () => {
    const { engine, reason } = resolveActiveEngine({
      descriptors: [BUILTIN_OPENCODE_DESCRIPTOR, { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'codex', builtin: false }],
    });
    expect(engine.id).toBe('opencode');
    expect(reason).toBe('builtin-default-with-alternatives');
  });

  test('several external engines: the builtin serves, alphabetical order never decides', () => {
    const { engine, reason } = resolveActiveEngine({
      descriptors: [
        BUILTIN_OPENCODE_DESCRIPTOR,
        { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'aaa', builtin: false },
        { ...BUILTIN_OPENCODE_DESCRIPTOR, id: 'zzz', builtin: false },
      ],
    });
    expect(engine.id).toBe('opencode');
    expect(reason).toBe('builtin-default');
  });

  test('asNonEmptyString trims and rejects empties (the I/O boundary for ids)', () => {
    expect(asNonEmptyString('  codex ')).toBe('codex');
    expect(asNonEmptyString('')).toBe('');
    expect(asNonEmptyString(null)).toBe('');
  });
});

describe('engine probe', () => {
  const descriptor = parseEngineDescriptor(validJson({
    endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096' },
    versionProbe: { field: 'engineVersion' },
  })).descriptor;

  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  test('a healthy engine reports version and latency', async () => {
    let requestedUrl = '';
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096/',
      authHeaders: { Authorization: 'Basic x' },
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        expect(options.headers.Authorization).toBe('Basic x');
        return jsonResponse({ engineVersion: '1.2.3' });
      },
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
    });
    expect(probe.ok).toBe(true);
    expect(requestedUrl).toBe('http://codex-engine:4096/global/health');
    expect(probe.version).toBe('1.2.3');
    expect(probe.latencyMs).toBeGreaterThan(0);
    expect(probe.error).toBe(null);
  });

  test('version falls back to common field names when the declared one is empty', async () => {
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096',
      fetchImpl: async () => jsonResponse({ version: '9.9.9' }),
    });
    expect(probe.version).toBe('9.9.9');
  });

  test('a non-2xx probe answers with the HTTP status, not a crash', async () => {
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096',
      fetchImpl: async () => jsonResponse({ error: 'nope' }, 503),
    });
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(503);
    expect(probe.error).toBe('HTTP 503');
  });

  test('a non-JSON body degrades to a healthy probe without a version', async () => {
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    });
    expect(probe.ok).toBe(true);
    expect(probe.version).toBe(null);
  });

  test('a missing base URL fails with a readable reason, not a throw', async () => {
    const probe = await probeEngine({ descriptor, baseUrl: '', fetchImpl: async () => jsonResponse({}) });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('No engine URL');
  });

  test('a timeout aborts and is reported as a timeout', async () => {
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096',
      timeoutMs: 5,
      fetchImpl: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('timed out');
  });

  test('a network-level failure is reported with its message', async () => {
    const probe = await probeEngine({
      descriptor,
      baseUrl: 'http://codex-engine:4096',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('ECONNREFUSED');
  });

  test('a descriptor without healthPath cannot be probed and says so', async () => {
    const noPath = { ...descriptor, endpoint: { url: 'http://codex-engine:4096' } };
    const probe = await probeEngine({ descriptor: noPath, baseUrl: 'http://x', fetchImpl: async () => jsonResponse({}) });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('endpoint.healthPath');
  });
});
