import { describe, expect, test } from 'bun:test';

import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { getDefaultMagicPromptTemplate } from '@/lib/magicPrompts';
import { buildIssueSpecAnswersPrompt, buildIssueSpecPrompt, issueSpecSessionTitle, parseIssueSpecResult } from './issueSpec';

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
    // The instructions the spec opens with — the Magic Prompts default
    // the settings may override, exactly as the session starter passes
    // it after reading the overrides.
    const defaultMethodology = getDefaultMagicPromptTemplate('jira.issue.spec.methodology');

    test('embeds the issue material and demands the one JSON block', () => {
        const prompt = buildIssueSpecPrompt(VIEW, defaultMethodology);
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

    test('an attached Confluence brief rides as its own section before the issue', () => {
        const prompt = buildIssueSpecPrompt(VIEW, defaultMethodology, {
            title: 'Приёмочные критерии релиза',
            material: 'Confluence page: Приёмочные критерии релиза\n\nАртефакты выгружаются до релиза.',
        });
        expect(prompt).toContain('Постановка задачи приложена ниже');
        expect(prompt).toContain('«Приёмочные критерии релиза»');
        expect(prompt).toContain('## Постановка из Confluence');
        expect(prompt).toContain('Артефакты выгружаются до релиза.');
        // The brief precedes the issue's own material: the stakeholder's
        // words arrive as the frame the issue then details.
        expect(prompt.indexOf('Постановка из Confluence')).toBeLessThan(prompt.indexOf('## Задача'));
        // The contradiction rule is part of the frame: a divergence is an
        // open question, never a silent pick of a side.
        expect(prompt).toContain('противоречие называется в открытых вопросах');
    });

    test('a spec without a brief embeds no brief section', () => {
        const prompt = buildIssueSpecPrompt(VIEW, defaultMethodology, null);
        expect(prompt).not.toContain('Постановка из Confluence');
        expect(prompt).toContain('## Задача');
    });

    test('the answer is a readable spec first, the JSON block a digest tail', () => {
        const prompt = buildIssueSpecPrompt(VIEW, defaultMethodology);
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

    test('a custom methodology replaces the guidance, never the material or the contract', () => {
        const prompt = buildIssueSpecPrompt(VIEW, 'Мои требования: план только по фронтенду.');
        expect(prompt).toContain('Мои требования: план только по фронтенду.');
        expect(prompt).not.toContain('читай репозиторий текущей директории');
        // The app owns the rest: the material and the card contract ride
        // along untouched, so the spec card keeps parsing.
        expect(prompt).toContain('DEMO-3223');
        expect(prompt).toContain('Сборка падает на шаге выгрузки артефактов');
        expect(prompt).toContain('ровно один блок JSON');
    });
});

describe('buildIssueSpecAnswersPrompt', () => {
    test('carries every answered pair and names the issue it continues', () => {
        const prompt = buildIssueSpecAnswersPrompt(VIEW, [
            { question: 'Какой таймаут считать нормой?', answer: '60 секунд' },
            { question: 'Нужен ли retry?', answer: 'Да, один повторный вызов' },
        ]);
        expect(prompt).toContain('DEMO-3223');
        expect(prompt).toContain('Вопрос: Какой таймаут считать нормой?\n  Ответ: 60 секунд');
        expect(prompt).toContain('Вопрос: Нужен ли retry?\n  Ответ: Да, один повторный вызов');
        expect(prompt).toContain('Продолжим ТЗ');
    });

    test('demands the re-draft whole, under the same contract as the first ask', () => {
        const prompt = buildIssueSpecAnswersPrompt(VIEW, [{ question: 'Кто отвечает за горячфикс?', answer: 'Дежурный' }]);
        const firstAsk = buildIssueSpecPrompt(VIEW, getDefaultMagicPromptTemplate('jira.issue.spec.methodology'));
        // The two-part contract is the app's, and a follow-up loosens none
        // of it: readable spec first, one JSON block last.
        expect(prompt).toContain('Пересобери ТЗ целиком');
        expect(prompt).toContain('Вопросы без ответа остаются открытыми');
        expect(prompt).toContain('## Ответ');
        expect(prompt).toContain('ровно один блок JSON');
        expect(prompt).toContain('"essence"');
        // The answers section asks its own «## …» question; the contract is
        // the last section, so the comparison starts from the last heading.
        expect(prompt.slice(prompt.lastIndexOf('## Ответ'))).toBe(firstAsk.slice(firstAsk.indexOf('## Ответ')));
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
