import { describe, expect, test } from 'vitest';

import {
  ENGINE_CAPABILITY_IDS,
  REQUIRED_FOR_CHAT,
  canServeChat,
  isKnownEngineCapability,
  missingForChat,
  splitEngineCapabilities,
} from './capabilities.js';

describe('engine capability vocabulary', () => {
  test('the vocabulary is a closed set without duplicates', () => {
    expect(ENGINE_CAPABILITY_IDS.length).toBeGreaterThan(0);
    expect(new Set(ENGINE_CAPABILITY_IDS).size).toBe(ENGINE_CAPABILITY_IDS.length);
  });

  test('the chat surface requires exactly "can create sessions + can stream"', () => {
    // Set the bar higher and no second engine ever qualifies; pin it here.
    expect([...REQUIRED_FOR_CHAT]).toEqual(['sessions', 'streaming']);
  });

  test('known ids are kept and unknown ids are reported (neither silent nor an error)', () => {
    const { known, unknown } = splitEngineCapabilities([
      'sessions', 'streamingg', 'streaming', 'sessions', '', 'tools',
    ]);
    expect(known).toEqual(['sessions', 'streaming', 'tools']);
    expect(unknown).toEqual(['streamingg']);
  });

  test('empty entries do not count as unknown (an empty id is not a mistyped capability)', () => {
    expect(splitEngineCapabilities(['', 'tools'])).toEqual({ known: ['tools'], unknown: [] });
  });

  test('a missing list is treated as "nothing declared", not an error', () => {
    expect(splitEngineCapabilities()).toEqual({ known: [], unknown: [] });
    expect(splitEngineCapabilities([])).toEqual({ known: [], unknown: [] });
  });

  test('duplicate known ids collapse', () => {
    expect(splitEngineCapabilities(['tools', 'tools', 'tools'])).toEqual({ known: ['tools'], unknown: [] });
  });

  test('canServeChat / missingForChat pin the chat verdict', () => {
    expect(canServeChat(['sessions', 'streaming', 'tools'])).toBe(true);
    expect(canServeChat(['streaming'])).toBe(false);
    expect(canServeChat()).toBe(false);
    expect(missingForChat(['streaming', 'tools'])).toEqual(['sessions']);
  });

  test('isKnownEngineCapability answers vocabulary membership', () => {
    expect(isKnownEngineCapability('sessions')).toBe(true);
    expect(isKnownEngineCapability('streamingg')).toBe(false);
    expect(isKnownEngineCapability('')).toBe(false);
  });
});
