import { describe, expect, test } from 'bun:test';

import { mcpConsoleI18n } from './mcp-console.i18n';

const locales = ['en', 'ru', 'de', 'es', 'fr', 'he', 'ar', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'] as const;

// Values that are the correct word in every language they appear in:
// shared technical vocabulary (Tools) and the millisecond unit.
const SAME_AS_ENGLISH = new Set([
  'Tools',
  'Servers',
  '{count} tools',
  '{ms} ms',
]);

describe('MCP console translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = mcpConsoleI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = mcpConsoleI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en' && !SAME_AS_ENGLISH.has(english[key])) {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });
});
