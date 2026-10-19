import { describe, expect, test } from 'bun:test';

import { checkpointsI18n } from './checkpoints.i18n';

const locales = ['en', 'ru', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('checkpoints translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = checkpointsI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = checkpointsI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('the restore counts keep their placeholders in every locale', () => {
    for (const locale of locales) {
      expect(checkpointsI18n[locale]['chat.messageBody.actions.restoreDone']).toContain('{changed}');
      expect(checkpointsI18n[locale]['chat.messageBody.actions.restoreSkipped']).toContain('{changed}');
      expect(checkpointsI18n[locale]['chat.messageBody.actions.restoreSkipped']).toContain('{skipped}');
    }
  });
});
