import { describe, expect, test } from 'bun:test';

import { findJiraIssueMentions, issueKeyOf, looksLikeUrl, matchesIssueQuery } from './issueRef';

describe('issueKeyOf', () => {
    test('reads an issue key in either case, spelling it the way Jira prints it', () => {
        expect(issueKeyOf('DEMO-3223')).toBe('DEMO-3223');
        expect(issueKeyOf('demo-3223')).toBe('DEMO-3223');
        expect(issueKeyOf('  DEMO-3223 ')).toBe('DEMO-3223');
        expect(issueKeyOf('X-1')).toBe('X-1');
    });

    test('words that are not a key stay a search', () => {
        expect(issueKeyOf('4242')).toBeNull();
        expect(issueKeyOf('DEMO-3223 doesn’t parse')).toBeNull();
        expect(issueKeyOf('')).toBeNull();
        expect(issueKeyOf('idp 3223')).toBeNull();
        // A dash-prefixed or overlong project part is not a key spelling.
        expect(issueKeyOf('-3223')).toBeNull();
        expect(issueKeyOf('DEMO-1234567')).toBeNull();
    });
});

describe('looksLikeUrl', () => {
    test('only an http(s) opener claims to be a link', () => {
        expect(looksLikeUrl('https://jira.example.com/browse/DEMO-3223')).toBe(true);
        expect(looksLikeUrl('HTTP://EXAMPLE.COM/browse/X-1')).toBe(true);
        expect(looksLikeUrl('DEMO-3223')).toBe(false);
        expect(looksLikeUrl('отчёт не отправляется')).toBe(false);
    });
});

describe('findJiraIssueMentions', () => {
    test('finds the keys the words name, first one first, once each', () => {
        expect(findJiraIssueMentions('Глянь DEMO-3223 и DEMO-7301, потом DEMO-3223 ещё раз'))
            .toEqual(['DEMO-3223', 'DEMO-7301']);
        expect(findJiraIssueMentions('(DEMO-1); [DEMO-2]')).toEqual(['DEMO-1', 'DEMO-2']);
        expect(findJiraIssueMentions('DEMO-1')).toEqual(['DEMO-1']);
    });

    test('letters or digits glued to either side keep the token out of the offer', () => {
        expect(findJiraIssueMentions('xDEMO-3223')).toEqual([]);
        expect(findJiraIssueMentions('DEMO-3223x')).toEqual([]);
        // Overlong numbers are not the server's key spelling either.
        expect(findJiraIssueMentions('DEMO-1234567')).toEqual([]);
    });

    test('an empty text offers nothing', () => {
        expect(findJiraIssueMentions('')).toEqual([]);
        expect(findJiraIssueMentions('   ')).toEqual([]);
    });
});

describe('matchesIssueQuery', () => {
    const recent = {
        key: 'DEMO-3223',
        summary: 'Сборка падает на шаге выгрузки артефактов',
        statusName: 'In Progress',
    };

    test('an empty query is the unfiltered landing state', () => {
        expect(matchesIssueQuery(recent, '')).toBe(true);
        expect(matchesIssueQuery(recent, '   ')).toBe(true);
    });

    test('the key answers case-blind', () => {
        expect(matchesIssueQuery(recent, 'demo-3223')).toBe(true);
        expect(matchesIssueQuery(recent, 'DEMO-3223')).toBe(true);
        expect(matchesIssueQuery(recent, '3223')).toBe(true);
        expect(matchesIssueQuery(recent, 'DEMO-9999')).toBe(false);
    });

    test('the summary and the status match as substrings, in any case', () => {
        expect(matchesIssueQuery(recent, 'артефактов')).toBe(true);
        expect(matchesIssueQuery(recent, 'in progress')).toBe(true);
        expect(matchesIssueQuery(recent, 'allure')).toBe(false);
    });

    test('a row without a status still answers on what it has', () => {
        const hit = { key: 'DEMO-7301', summary: 'Починить выгрузку артефактов' };
        expect(matchesIssueQuery(hit, 'починить')).toBe(true);
        expect(matchesIssueQuery(hit, 'open')).toBe(false);
    });
});
