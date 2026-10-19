import { describe, expect, test } from 'bun:test';

import { advisorI18n } from './advisor.i18n';

const locales = ['en', 'ru', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('advisor translations', () => {
  test('provides every key in every supported locale, translated', () => {
    const english: Record<string, string> = advisorI18n.en;
    const keys = Object.keys(english);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of locales) {
      const translated: Record<string, string> = advisorI18n[locale];
      expect(Object.keys(translated)).toEqual(keys);
      for (const key of keys) {
        const value = translated[key];
        expect(value).toBeTruthy();
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });

  test('the overflow line keeps its count placeholder in every locale', () => {
    for (const locale of locales) {
      expect(advisorI18n[locale]['chat.advisor.more']).toContain('{count}');
    }
  });
});
