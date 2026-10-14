import { describe, expect, test } from 'vitest';

import {
  BUILTIN_OPENCODE_DESCRIPTOR,
  EngineDescriptorError,
  describeEngineForApi,
  normalizeEngineDescriptor,
  parseEngineDescriptor,
} from './descriptor.js';

const valid = (overrides = {}) => ({
  apiVersion: 1,
  id: 'fake-engine',
  name: 'Fake Engine',
  protocol: 'opencode-v1',
  endpoint: { healthPath: '/global/health' },
  capabilities: ['sessions', 'streaming'],
  ...overrides,
});

describe('engine descriptor — accepted shapes', () => {
  test('a minimal valid descriptor', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(valid());
    expect(descriptor.id).toBe('fake-engine');
    expect(descriptor.protocol).toBe('opencode-v1');
    expect(warnings).toEqual([]);
  });

  test('the built-in descriptor passes its own validation (pins the built-in contract)', () => {
    const { descriptor } = normalizeEngineDescriptor({ ...BUILTIN_OPENCODE_DESCRIPTOR });
    expect(descriptor.id).toBe('opencode');
    expect(descriptor.capabilities).toContain('sessions');
    expect(descriptor.capabilities).toContain('diffs');
  });

  test('unknown fields are ignored (matching guests: extra keys drop, not forward)', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ futureField: { a: 1 }, whatever: true }));
    expect(descriptor.id).toBe('fake-engine');
    expect(descriptor.futureField).toBeUndefined();
    expect(descriptor.whatever).toBeUndefined();
  });

  test('name defaults to the id when omitted', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ name: undefined }));
    expect(descriptor.name).toBe('fake-engine');
  });
});

describe('engine descriptor — capability handling', () => {
  test('unknown capabilities are dropped and warned about, known ones survive', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(
      valid({ capabilities: ['sessions', 'streamingg', 'streaming'] }),
    );
    expect(descriptor.capabilities).toEqual(['sessions', 'streaming']);
    expect(warnings.join(' ')).toContain('streamingg');
    expect(warnings.join(' ')).toContain('Unknown capabilities');
  });

  test('no capabilities declared is a warning, not a failure', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(valid({ capabilities: undefined }));
    expect(descriptor.capabilities).toEqual([]);
    expect(warnings.join(' ')).toContain('No capabilities declared');
  });
});

describe('engine descriptor — surface semantics', () => {
  test('surface follows capabilities when not declared: chat-capable engines join the chat', () => {
    const { descriptor } = normalizeEngineDescriptor(valid());
    expect(descriptor.surface).toBe('chat');
  });

  test('an engine missing chat capabilities lands on the panel surface', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ capabilities: ['todos'] }));
    expect(descriptor.surface).toBe('panel');
  });

  test('surface=chat contradicted by capabilities is reported, the verdict still walks capabilities', () => {
    const { descriptor, warnings } = normalizeEngineDescriptor(
      valid({ surface: 'chat', capabilities: ['todos'] }),
    );
    expect(descriptor.surface).toBe('chat');
    expect(warnings.join(' ')).toContain('surface=chat declared but');
  });
});

describe('engine descriptor — rejections', () => {
  const rejects = (raw, messagePart, code = null) => {
    let caught = null;
    try {
      normalizeEngineDescriptor(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineDescriptorError);
    expect(caught.message).toContain(messagePart);
    if (code) expect(caught.code).toBe(code);
  };

  test('apiVersion other than the known one is rejected', () => {
    rejects(valid({ apiVersion: 99 }), 'apiVersion');
  });

  test('an unknown protocol is rejected outright (the host cannot drive it)', () => {
    rejects(valid({ protocol: 'smolagents-v1' }), 'protocol');
  });

  test('a non-kebab-case id is rejected', () => {
    rejects(valid({ id: 'Fake Engine' }), 'id');
  });

  test('opencode-v1 requires endpoint.healthPath', () => {
    rejects(valid({ endpoint: {} }), 'endpoint.healthPath', 'MISSING_HEALTH_PATH');
  });

  test('endpoint.url must be a full http(s) URL', () => {
    rejects(valid({ endpoint: { healthPath: '/global/health', url: 'codex:4096' } }), 'endpoint.url');
    rejects(
      valid({ endpoint: { healthPath: '/global/health', url: 'ftp://codex:4096' } }),
      'endpoint.url',
    );
  });

  test('parseEngineDescriptor wraps JSON syntax errors with the file name in source', () => {
    let caught = null;
    try {
      parseEngineDescriptor('{ not json', { source: '/etc/oc-engines/broken.json' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineDescriptorError);
    expect(caught.code).toBe('INVALID_JSON');
    expect(caught.source).toBe('/etc/oc-engines/broken.json');
    expect(caught.message).toContain('Not valid JSON');
  });

  test('parseEngineDescriptor parses a valid file and carries the source path', () => {
    const { descriptor } = parseEngineDescriptor(JSON.stringify(valid()), {
      source: '/etc/oc-engines/fake-engine.json',
    });
    expect(descriptor.source).toBe('/etc/oc-engines/fake-engine.json');
  });
});

describe('engine descriptor — normalization details', () => {
  test('basic auth picks up its defaults; anything else normalizes to none', () => {
    const basic = normalizeEngineDescriptor(valid({
      auth: { type: 'basic', passwordEnv: 'CODEX_PASSWORD' },
    })).descriptor;
    expect(basic.auth).toEqual({ type: 'basic', username: 'opencode', passwordEnv: 'CODEX_PASSWORD' });

    const none = normalizeEngineDescriptor(valid({ auth: { type: 'none' } })).descriptor;
    expect(none.auth).toEqual({ type: 'none' });

    const fallback = normalizeEngineDescriptor(valid({ auth: {} })).descriptor;
    expect(fallback.auth).toEqual({ type: 'none' });
  });

  test('endpoint.url trailing slashes are trimmed, healthPath survives', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({
      endpoint: { healthPath: '/global/health', url: 'http://codex-engine:4096///' },
    }));
    expect(descriptor.endpoint.url).toBe('http://codex-engine:4096');
    expect(descriptor.endpoint.healthPath).toBe('/global/health');
  });

  test('versionProbe fields are present-when-present, not empty-object noise', () => {
    const withProbe = normalizeEngineDescriptor(valid({
      versionProbe: { path: '/global/health', field: 'engineVersion' },
    })).descriptor;
    expect(withProbe.versionProbe).toEqual({ path: '/global/health', field: 'engineVersion' });

    const withoutProbe = normalizeEngineDescriptor(valid({ versionProbe: {} })).descriptor;
    expect(withoutProbe.versionProbe).toBeUndefined();
  });
});

describe('describeEngineForApi — the public shape', () => {
  test('chat verdict and missing list are precomputed for the UI', () => {
    const { descriptor } = normalizeEngineDescriptor(valid());
    const api = describeEngineForApi(descriptor);
    expect(api.canServeChat).toBe(true);
    expect(api.missingForChat).toEqual([]);
    expect(api.endpointUrl).toBe(null);
    expect(api.authType).toBe('none');
  });

  test('a panel engine reports what it is missing for chat', () => {
    const { descriptor } = normalizeEngineDescriptor(valid({ capabilities: ['todos', 'diffs'] }));
    const api = describeEngineForApi(descriptor);
    expect(api.canServeChat).toBe(false);
    expect(api.missingForChat).toEqual(['sessions', 'streaming']);
    expect(api.builtin).toBe(false);
  });

  test('the builtin descriptor keeps its endpoint and auth in the API shape', () => {
    const api = describeEngineForApi(BUILTIN_OPENCODE_DESCRIPTOR);
    expect(api.id).toBe('opencode');
    expect(api.builtin).toBe(true);
    expect(api.healthPath).toBe('/global/health');
    expect(api.authType).toBe('basic');
  });
});
