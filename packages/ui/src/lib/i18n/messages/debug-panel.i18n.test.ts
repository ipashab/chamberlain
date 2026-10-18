import { describe, expect, test } from 'bun:test';

import { debugPanelI18n } from './debug-panel.i18n';

const locales = ['en', 'ru', 'de', 'es', 'fr', 'he', 'ar', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'] as const;

// Values that are the correct word in every language they appear in:
// shared technical vocabulary (Variables, Breakpoints) and literal paths and
// commands that no translation should touch.
const SAME_AS_ENGLISH = new Set([
  'Arguments',
  'Breakpoints',
  'Stack',
  'Variables',
  // Shared technical vocabulary: German, French and Dutch write the English
  // word for a software test, Spanish writes Error.
  'Tests',
  'Error',
  'python3',
  'pytest',
  '/absolute/path/to/file.py',
  '/absolute/path/to/python',
]);

describe('debug panel translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = debugPanelI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = debugPanelI18n[locale];
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
