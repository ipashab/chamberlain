import { describe, expect, test } from 'bun:test';

import { looksLikeUrl, matchesPullQuery, pullNumberOf } from './pullSearch';

describe('pullNumberOf', () => {
    test('reads a bare or hashed number, nothing else', () => {
        expect(pullNumberOf('8667')).toBe(8667);
        expect(pullNumberOf('#8667')).toBe(8667);
        expect(pullNumberOf('  #8667 ')).toBe(8667);
        expect(pullNumberOf('IDP-7004')).toBeNull();
        expect(pullNumberOf('8667 add headers')).toBeNull();
        expect(pullNumberOf('')).toBeNull();
        expect(pullNumberOf('#0')).toBeNull();
    });
});

describe('looksLikeUrl', () => {
    test('only an http(s) opener claims to be a link', () => {
        expect(looksLikeUrl('https://bitbucket.example/projects/AUTO/repos/r/pull-requests/110')).toBe(true);
        expect(looksLikeUrl('HTTP://EXAMPLE.COM/x')).toBe(true);
        expect(looksLikeUrl('8667')).toBe(false);
        expect(looksLikeUrl('add headers')).toBe(false);
    });
});

describe('matchesPullQuery', () => {
    const pull = {
        number: 8667,
        title: 'IDP-3223: Автоматизация тестов',
        author: 's.mytsykov',
        repo: { project: 'OTHER', slug: 'playtest' },
    };

    test('an empty query is the unfiltered landing state', () => {
        expect(matchesPullQuery(pull, '')).toBe(true);
        expect(matchesPullQuery(pull, '   ')).toBe(true);
    });

    test('the number answers with or without its hash, case-blind elsewhere', () => {
        expect(matchesPullQuery(pull, '8667')).toBe(true);
        expect(matchesPullQuery(pull, '#8667')).toBe(true);
        expect(matchesPullQuery(pull, '86')).toBe(true);
        expect(matchesPullQuery(pull, '9999')).toBe(false);
    });

    test('title and author match as substrings, in any case', () => {
        expect(matchesPullQuery(pull, 'автоматизация')).toBe(true);
        expect(matchesPullQuery(pull, 'Автоматизация')).toBe(true);
        expect(matchesPullQuery(pull, 'mytsykov')).toBe(true);
        expect(matchesPullQuery(pull, 'nobody')).toBe(false);
    });

    test('the repo answers by project, slug, or both', () => {
        expect(matchesPullQuery(pull, 'OTHER')).toBe(true);
        expect(matchesPullQuery(pull, 'playtest')).toBe(true);
        expect(matchesPullQuery(pull, 'other/playtest')).toBe(true);
    });

    test('a row without author or repo matches on what it still has', () => {
        const recent = { number: 110, title: 'IDP-7004 map the modules' };
        expect(matchesPullQuery(recent, '110')).toBe(true);
        expect(matchesPullQuery(recent, 'IDP-7004')).toBe(true);
        expect(matchesPullQuery(recent, 'other')).toBe(false);
    });
});
