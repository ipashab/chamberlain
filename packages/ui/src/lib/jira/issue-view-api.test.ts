import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import { fetchJiraIssueView } from './issue-view-api';

const VIEW_BODY = {
    issue: {
        key: 'DEMO-3223',
        url: 'https://jira.example.com/browse/DEMO-3223',
        summary: 'Автоматизация отчётов: Сборка падает на шаге выгрузки артефактов',
        type: { name: 'Task', iconPath: '/images/issuetypes/task.svg' },
        status: { name: 'In Progress', category: 'indeterminate' },
        resolution: null,
        priority: { name: 'Major', iconPath: '/images/icons/priorities/major.svg' },
        assignee: { name: 'T. Harper', key: 't.harper', avatarPath: '/secure/useravatar?ownerId=t.harper' },
        reporter: { name: 'P. Ivanov', key: 'a.coder', avatarPath: '/secure/useravatar?ownerId=a.coder' },
        creator: { name: 'P. Ivanov', key: 'a.coder', avatarPath: '/secure/useravatar?ownerId=a.coder' },
        created: '2026-09-01T10:00:00.000+0300',
        updated: '2026-10-10T18:30:00.000+0300',
        labels: ['autotests'],
        components: ['playtest'],
        fixVersions: [],
        affectsVersions: [],
        watchCount: 3,
        watcherNames: ['a.coder', 't.harper', 'r.stone'],
        customFields: [{ id: 'customfield_10001', name: 'Story Points', text: '5' }],
        epic: { key: 'DEMO-210', name: 'Testing infrastructure', statusName: 'In Progress' },
        sprints: ['Sprint 41'],
    },
    description: {
        wiki: 'Флоу падает на шаге отправки отчёта в Allure.',
        html: '<p>Флоу падает на шаге отправки отчёта в Allure.</p>',
    },
    comments: [
        {
            id: '40001',
            author: { name: 'B. Asvarov', key: 'r.stone', avatarPath: null },
            created: '2026-10-11T12:00:00.000+0300',
            updated: '2026-10-11T13:00:00.000+0300',
            edited: true,
            html: '<p>Воспроизвёл локально.</p>',
            text: 'Воспроизвёл локально.',
        },
    ],
    issueLinks: [
        {
            typeName: 'Blocks',
            relation: 'blocks',
            issue: { key: 'DEMO-7301', summary: 'Починить выгрузку артефактов', statusName: 'Open', typeName: 'Bug' },
        },
    ],
    subtasks: [
        { key: 'DEMO-3224', summary: 'Собрать логи прогона', statusName: 'Done', typeName: 'Sub-task' },
    ],
    attachments: [
        { id: '12001', filename: 'allure-report.zip', size: 20480, created: '2026-10-11T12:05:00.000+0300', author: 'B. Asvarov' },
    ],
    truncated: { comments: false },
};

const jsonResponse = (status: number, body: JsonValue): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchJiraIssueView', () => {
    test('asks the route once and answers the parsed view', async () => {
        let asked = '';
        const result = await fetchJiraIssueView(
            'https://jira.example.com/browse/DEMO-3223',
            async (input: string | URL | Request) => {
                asked = String(input);
                return jsonResponse(200, VIEW_BODY);
            },
        );
        expect(asked).toBe('/api/openchamber/jira/issues/view?ref=https%3A%2F%2Fjira.example.com%2Fbrowse%2FDEMO-3223');
        expect(result).toEqual({ ok: true, view: VIEW_BODY });
    });

    test('reads a bare issue key the same way as a full link', async () => {
        let asked = '';
        const result = await fetchJiraIssueView('DEMO-3223', async (input: string | URL | Request) => {
            asked = String(input);
            return jsonResponse(200, VIEW_BODY);
        });
        expect(asked).toBe('/api/openchamber/jira/issues/view?ref=DEMO-3223');
        expect(result.ok).toBe(true);
    });

    test('carries the route error kinds into the failure result', async () => {
        const result = await fetchJiraIssueView('https://elsewhere.example.com/browse/X-1', async () =>
            jsonResponse(409, { kind: 'wrong-instance', error: 'elsewhere' }),
        );
        expect(result).toEqual({ ok: false, kind: 'wrong-instance' });
    });

    test('answers unexpected when the error body carries no known kind', async () => {
        const result = await fetchJiraIssueView('DEMO-1', async () =>
            jsonResponse(502, { error: 'mystery' }),
        );
        expect(result).toEqual({ ok: false, kind: 'unexpected' });
    });

    test('answers unexpected when a good status carries a bad shape', async () => {
        const result = await fetchJiraIssueView('DEMO-1', async () =>
            jsonResponse(200, { hello: 'world' }),
        );
        expect(result).toEqual({ ok: false, kind: 'unexpected' });
    });

    test('answers unreachable when the fetch itself fails', async () => {
        const result = await fetchJiraIssueView('DEMO-1', async () => {
            throw new Error('network down');
        });
        expect(result).toEqual({ ok: false, kind: 'unreachable' });
    });

    test('accepts the honest truncated-comments answer the server sends', async () => {
        const result = await fetchJiraIssueView('DEMO-3223', async () =>
            jsonResponse(200, { ...VIEW_BODY, comments: [], truncated: { comments: true } }),
        );
        if (!result.ok) throw new Error('expected a ready view');
        expect(result.view.truncated.comments).toBe(true);
        expect(result.view.comments).toEqual([]);
    });

    test('keeps the rendered description separate from the wiki words', async () => {
        const result = await fetchJiraIssueView('DEMO-3223', async () => jsonResponse(200, VIEW_BODY));
        if (!result.ok) throw new Error('expected a ready view');
        expect(result.view.description.wiki).toBe('Флоу падает на шаге отправки отчёта в Allure.');
        expect(result.view.description.html).toBe('<p>Флоу падает на шаге отправки отчёта в Allure.</p>');
        // Watched names are a snapshot the rows may show; the count is the
        // instance's own number even when the names read was refused.
        expect(result.view.issue.watchCount).toBe(3);
        expect(result.view.issue.watcherNames).toEqual(['a.coder', 't.harper', 'r.stone']);
    });
});
