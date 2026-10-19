import { describe, expect, test } from 'bun:test';

import { workspaceModesI18n } from './workspace-modes.i18n';

const locales = ['en', 'ru', 'de', 'es', 'fr', 'he', 'ar', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'] as const;

// Values that stay the English word in every locale: shared technical
// vocabulary no translation should touch.
const SAME_AS_ENGLISH = new Set([
  'Chat',
  'Debug',
]);

describe('workspace modes translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = workspaceModesI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = workspaceModesI18n[locale];
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
