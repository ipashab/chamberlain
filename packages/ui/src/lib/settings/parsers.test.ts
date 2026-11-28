import { describe, expect, test } from 'bun:test';
import { parseCustomProviderLogos, parseFallbackChain, parseProjects } from './parsers';

describe('parseCustomProviderLogos', () => {
  test('keeps well-formed entries and drops the rest one by one', () => {
    const raw = {
      acme: { mime: 'image/png', updatedAt: 1794114747809 },
      ' campus-llm ': { mime: 'image/svg+xml', updatedAt: 2 },
      gif: { mime: 'image/gif', updatedAt: 3 },
      stale: { mime: 'image/webp', updatedAt: 0 },
      '  ': { mime: 'image/png', updatedAt: 4 },
      broken: 'image/png',
    };

    expect(parseCustomProviderLogos(raw, {})).toEqual({
      acme: { mime: 'image/png', updatedAt: 1794114747809 },
      'campus-llm': { mime: 'image/svg+xml', updatedAt: 2 },
    });
    expect(parseCustomProviderLogos(['acme'], {})).toBeUndefined();
    expect(parseCustomProviderLogos(null, {})).toBeUndefined();
  });
});

describe('parseProjects', () => {
  test('keeps per-project agent, model and thinking defaults across a settings round trip', () => {
    const projects = [
      { path: '/repo/app', label: 'App', defaultAgent: ' reviewer ', defaultModel: 'openai/gpt-5.6', defaultVariant: 'low' },
      { path: '/repo/lib', defaultAgent: ' ', defaultModel: '  ', defaultVariant: 42 },
      { path: '/repo/legacy' },
    ];
    const parsed = parseProjects(projects, { projects });

    expect(parsed?.map((project) => [project.path, project.defaultAgent, project.defaultModel, project.defaultVariant])).toEqual([
      ['/repo/app', 'reviewer', 'openai/gpt-5.6', 'low'],
      ['/repo/lib', undefined, undefined, undefined],
      ['/repo/legacy', undefined, undefined, undefined],
    ]);
    expect(parseProjects(parsed, { projects: parsed })).toEqual(parsed);
  });
});

describe('parseFallbackChain', () => {
  test('keeps trimmed entries in order, drops invalid and duplicate models, and caps at 8', () => {
    const ninth = { providerID: 'p9', modelID: 'm9' };
    const entries = [
      { providerID: ' p1 ', modelID: ' m1 ', variant: ' high ' },
      { providerID: '', modelID: 'm' },
      { providerID: 'p2', modelID: 'm2', variant: '   ' },
      { providerID: 'p1', modelID: 'm1' },
      'not-an-entry',
      { providerID: 'p3', modelID: 'm3' },
      { providerID: 'p4', modelID: 'm4' },
      { providerID: 'p5', modelID: 'm5' },
      { providerID: 'p6', modelID: 'm6' },
      { providerID: 'p7', modelID: 'm7' },
      { providerID: 'p8', modelID: 'm8' },
      ninth,
    ];
    const parsed = parseFallbackChain(entries, {});

    expect(parsed).toHaveLength(8);
    expect(parsed?.[0]).toEqual({ providerID: 'p1', modelID: 'm1', variant: 'high' });
    expect(parsed?.[1]).toEqual({ providerID: 'p2', modelID: 'm2' });
    expect(parsed?.some((entry) => entry.providerID === 'p9')).toBe(false);
  });

  test('preserves an empty list and rejects non-arrays', () => {
    expect(parseFallbackChain([], {})).toEqual([]);
    expect(parseFallbackChain('nope', {})).toBeUndefined();
  });

  test('seeds one entry from the legacy single fallback model while the list is absent', () => {
    expect(parseFallbackChain(undefined, { fallbackModel: 'openai/gpt-5.6', fallbackVariant: 'high' }))
      .toEqual([{ providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' }]);
    expect(parseFallbackChain(undefined, { fallbackModel: 'openai/gpt-5.6' }))
      .toEqual([{ providerID: 'openai', modelID: 'gpt-5.6' }]);
    // The saved list wins over the legacy pair, and no legacy pair means no chain.
    expect(parseFallbackChain(undefined, {})).toBeUndefined();
    expect(parseFallbackChain([], { fallbackModel: 'openai/gpt-5.6' })).toEqual([]);
  });
});
