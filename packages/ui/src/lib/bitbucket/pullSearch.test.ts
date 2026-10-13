import { describe, expect, test } from 'bun:test';

import { looksLikeUrl, matchesPullQuery, matchesPullState, PULL_STATE_FILTERS, pullNumberOf } from './pullSearch';

describe('pullNumberOf', () => {
    test('reads a bare or hashed number, nothing else', () => {
        expect(pullNumberOf('4242')).toBe(4242);
        expect(pullNumberOf('#4242')).toBe(4242);
        expect(pullNumberOf('  #4242 ')).toBe(4242);
        expect(pullNumberOf('DEMO-7004')).toBeNull();
        expect(pullNumberOf('4242 add headers')).toBeNull();
        expect(pullNumberOf('')).toBeNull();
        expect(pullNumberOf('#0')).toBeNull();
    });
});

describe('looksLikeUrl', () => {
    test('only an http(s) opener claims to be a link', () => {
        expect(looksLikeUrl('https://bitbucket.example/projects/AUTO/repos/r/pull-requests/110')).toBe(true);
        expect(looksLikeUrl('HTTP://EXAMPLE.COM/x')).toBe(true);
        expect(looksLikeUrl('4242')).toBe(false);
        expect(looksLikeUrl('add headers')).toBe(false);
    });
});

describe('matchesPullQuery', () => {
    const pull = {
        number: 4242,
        title: 'DEMO-3223: Автоматизация отчётов',
        author: 't.harper',
        repo: { project: 'DEMO', slug: 'demo-service' },
    };

    test('an empty query is the unfiltered landing state', () => {
        expect(matchesPullQuery(pull, '')).toBe(true);
        expect(matchesPullQuery(pull, '   ')).toBe(true);
    });

    test('the number answers with or without its hash, case-blind elsewhere', () => {
        expect(matchesPullQuery(pull, '4242')).toBe(true);
        expect(matchesPullQuery(pull, '#4242')).toBe(true);
        expect(matchesPullQuery(pull, '42')).toBe(true);
        expect(matchesPullQuery(pull, '9999')).toBe(false);
    });

    test('title and author match as substrings, in any case', () => {
        expect(matchesPullQuery(pull, 'автоматизация')).toBe(true);
        expect(matchesPullQuery(pull, 'Автоматизация')).toBe(true);
        expect(matchesPullQuery(pull, 'harper')).toBe(true);
        expect(matchesPullQuery(pull, 'nobody')).toBe(false);
    });

    test('the repo answers by project, slug, or both', () => {
        expect(matchesPullQuery(pull, 'DEMO')).toBe(true);
        expect(matchesPullQuery(pull, 'demo-service')).toBe(true);
        expect(matchesPullQuery(pull, 'demo/demo-service')).toBe(true);
    });

    test('a row without author or repo matches on what it still has', () => {
        const recent = { number: 110, title: 'DEMO-7004 map the modules' };
        expect(matchesPullQuery(recent, '110')).toBe(true);
        expect(matchesPullQuery(recent, 'DEMO-7004')).toBe(true);
        expect(matchesPullQuery(recent, 'other')).toBe(false);
    });
});

describe('matchesPullState', () => {
    test('a chip keeps its own state, "all" keeps everything', () => {
        expect(PULL_STATE_FILTERS).toEqual(['open', 'merged', 'closed', 'all']);
        expect(matchesPullState('open', 'open')).toBe(true);
        expect(matchesPullState('merged', 'merged')).toBe(true);
        expect(matchesPullState('closed', 'closed')).toBe(true);
        expect(matchesPullState('merged', 'open')).toBe(false);
        expect(matchesPullState('closed', 'merged')).toBe(false);
        for (const state of ['open', 'merged', 'closed']) {
            expect(matchesPullState(state, 'all')).toBe(true);
        }
    });

    test('the state words join the free-text haystack', () => {
        const row = { number: 110, title: 'Map the modules', state: 'merged' };
        expect(matchesPullQuery(row, 'merged')).toBe(true);
        expect(matchesPullQuery(row, 'open')).toBe(false);
        expect(matchesPullQuery(row, 'map')).toBe(true);
    });
});
