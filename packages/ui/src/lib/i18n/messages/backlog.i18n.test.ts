import { describe, expect, test } from 'bun:test';

import { backlogI18n } from './backlog.i18n';

const locales = ['en', 'ru', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('backlog translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = backlogI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = backlogI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('the queue counts keep their placeholder in every locale', () => {
    for (const locale of locales) {
      expect(backlogI18n[locale]['chat.backlog.staged']).toContain('{count}');
      expect(backlogI18n[locale]['chat.backlog.draining']).toContain('{count}');
      expect(backlogI18n[locale]['chat.backlog.runStarted']).toContain('{count}');
    }
  });
});
