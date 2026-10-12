import { describe, expect, test } from 'bun:test';

import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { buildIssueSpecPrompt, issueSpecSessionTitle, parseIssueSpecResult } from './issueSpec';

const VIEW: JiraIssueView = {
    issue: {
        key: 'DEMO-3223',
        url: 'https://jira.example.com/browse/DEMO-3223',
        summary: 'Сборка падает на шаге выгрузки артефактов',
        type: { name: 'Task', iconPath: null },
        status: { name: 'In Progress', category: 'indeterminate' },
        resolution: null,
        priority: { name: 'Major', iconPath: null },
        assignee: { name: 'T. Harper', key: 't.harper', avatarPath: null },
        reporter: { name: 'P. Ivanov', key: 'a.coder', avatarPath: null },
        creator: { name: 'P. Ivanov', key: 'a.coder', avatarPath: null },
        created: '2026-09-01T10:00:00.000+0300',
        updated: '2026-10-10T18:30:00.000+0300',
        labels: ['autotests'],
        components: ['playtest'],
        fixVersions: [],
        affectsVersions: [],
        watchCount: null,
        watcherNames: null,
        customFields: [],
        epic: null,
        sprints: null,
    },
    description: { wiki: 'Отправка отчёта в Allure падает по таймауту.', html: null },
    comments: [
        {
            id: '40001',
            author: { name: 'B. Asvarov', key: 'r.stone', avatarPath: null },
            created: '2026-10-11T12:00:00.000+0300',
            updated: null,
            edited: false,
            html: null,
            text: 'Воспроизвёл локально: таймаут 30 секунд.',
        },
    ],
    issueLinks: [],
    subtasks: [],
    attachments: [],
    truncated: { comments: false },
};

describe('issueSpecSessionTitle', () => {
    test('carries the key and the summary, capped for the session list', () => {
        expect(issueSpecSessionTitle(VIEW)).toBe('Jira DEMO-3223: Сборка падает на шаге выгрузки артефактов');
        const long = { ...VIEW, issue: { ...VIEW.issue, summary: 'очень'.repeat(40) } };
        expect(issueSpecSessionTitle(long).length).toBeLessThanOrEqual(80);
    });
});

describe('buildIssueSpecPrompt', () => {
    test('embeds the issue material and demands the one JSON block', () => {
        const prompt = buildIssueSpecPrompt(VIEW);
        // The material rides inside: meta, description, comments — so the
        // spec session needs no Jira access of its own.
        expect(prompt).toContain('DEMO-3223');
        expect(prompt).toContain('Сборка падает на шаге выгрузки артефактов');
        expect(prompt).toContain('Отправка отчёта в Allure падает по таймауту.');
        expect(prompt).toContain('Воспроизвёл локально');
        expect(prompt).toContain('```json');
        expect(prompt).toContain('"plan"');
        // The source stays sealed on the issue side, but the dev plan is
        // allowed to reach for the repository the session runs in.
        expect(prompt).toContain('ходить в Jira не нужно');
        expect(prompt).toContain('читай репозиторий текущей директории');
    });

    test('the answer is a readable spec first, the JSON block a digest tail', () => {
        const prompt = buildIssueSpecPrompt(VIEW);
        expect(prompt).toContain('Сначала — полное читаемое ТЗ по-русски');
        expect(prompt).toContain('суть задачи — одной-двумя строками');
        expect(prompt).toContain('план доработок');
        expect(prompt).toContain('критерии приёмки');
        expect(prompt).toContain('ровно один блок JSON');
        expect(prompt).toContain('без повторения текста разбора');
        // The digest is demanded after the readable half, so the person
        // reads prose before any block.
        expect(prompt.indexOf('читаемое ТЗ')).toBeLessThan(prompt.indexOf('```json'));
    });
});

describe('parseIssueSpecResult', () => {
    const answer = [
        'Разбор постановки: задача про таймаут отправки.',
        '```json',
        '{',
        '  "essence": "Отправка отчёта не должна падать по таймауту",',
        '  "plan": ["Поднять таймаут в autotests/common/steps/report.py", "Добавить ретрай отправки"],',
        '  "acceptance": ["Отчёт доходит до Allure за отведённое время", "Провал виден в логе флоу"],',
        '  "openQuestions": ["Какой таймаут считается нормой"],',
        '  "outOfScope": []',
        '}',
        '```',
    ].join('\n');

    test('reads the last well-formed block into the spec card', () => {
        const result = parseIssueSpecResult(answer);
        if (!result.ok) throw new Error('expected a spec');
        expect(result.spec.essence).toBe('Отправка отчёта не должна падать по таймауту');
        expect(result.spec.plan).toEqual([
            'Поднять таймаут в autotests/common/steps/report.py',
            'Добавить ретрай отправки',
        ]);
        expect(result.spec.acceptance).toEqual([
            'Отчёт доходит до Allure за отведённое время',
            'Провал виден в логе флоу',
        ]);
        expect(result.spec.openQuestions).toEqual(['Какой таймаут считается нормой']);
        expect(result.spec.outOfScope).toEqual([]);
    });

    test('the newest block wins over earlier drafts', () => {
        const draft = ['```json', '{ "essence": "draft", "acceptance": [] }', '```'].join('\n');
        const withDraft = `${answer}\n${draft}`;
        const result = parseIssueSpecResult(withDraft);
        // The empty draft with nothing to plan or ask is not a card, so
        // the older full answer is the one that still counts.
        if (!result.ok) throw new Error('expected a spec');
        expect(result.spec.outOfScope).toEqual([]);
    });

    test('an answer without a block is no spec at all', () => {
        expect(parseIssueSpecResult('Просто текст без блока.')).toEqual({ ok: false, error: 'no-block' });
    });

    test('a block that does not fit the contract is refused, not guessed', () => {
        const broken = '```json\n{ "unrelated": true }\n```';
        expect(parseIssueSpecResult(broken)).toEqual({ ok: false, error: 'bad-shape' });
        const noEssence = '```json\n{ "essence": " ", "acceptance": ["x"] }\n```';
        expect(parseIssueSpecResult(noEssence)).toEqual({ ok: false, error: 'bad-shape' });
    });

    test('extra keys the model added do not cost the reading', () => {
        const decorated = [
            '```json',
            JSON.stringify({
                essence: 'Отправка стабильна',
                acceptance: ['Флоу зелёный'],
                openQuestions: [],
                outOfScope: [],
                mood: 'chatty',
            }),
            '```',
        ].join('\n');
        const result = parseIssueSpecResult(decorated);
        if (!result.ok) throw new Error('expected a spec');
        expect(result.spec.acceptance).toEqual(['Флоу зелёный']);
    });
});
