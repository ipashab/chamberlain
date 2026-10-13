import { describe, expect, test } from 'bun:test';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { getDefaultMagicPromptTemplate } from '@/lib/magicPrompts';

import {
    analysisSessionTitle,
    buildAnalysisPrompt,
    parseAnalysisResult,
    previousReadingDigest,
    taskIdOfTitle,
    type PullAnalysis,
} from './pullAnalysis';

// The judging guidance the analysis opens with — the Magic Prompts
// default the settings may override, exactly as the session starter
// passes it after reading the overrides.
const defaultMethodology = getDefaultMagicPromptTemplate('bitbucket.pull.analysis.methodology');

// A pull view with two comments and two files, small enough to read whole.
const baseView: BitbucketPullView = {
    pull: {
        number: 4242,
        url: 'https://bitbucket.example/projects/DEMO/repos/demo-service/pull-requests/4242/overview',
        title: 'DEMO-3223: Автоматизация приёмочных сценариев',
        description: 'Добавляем эксперименты.',
        state: 'open',
        author: 'Анна',
        authorSlug: 'an',
        createdAt: 1,
        updatedAt: 2,
        fromBranch: 'feature/exp',
        toBranch: 'master',
        reviewers: [{ name: 'Максим', slug: 'mx', approved: true }],
        checks: { state: 'success', total: 3 },
    },
    files: [
        {
            path: 'autotests/experiments/src/model.py',
            changeType: 'add',
            truncated: false,
            diffText: 'diff --git a/m b/m\nnew file\n+class Model: ...',
        },
        {
            path: 'autotests/common/configs/config.yaml',
            changeType: 'modify',
            truncated: false,
            diffText: 'diff --git a/c b/c\n@@\n+experiments:',
        },
    ],
    comments: [
        {
            id: 101,
            author: 'Максим',
            authorSlug: 'mx',
            text: 'Не хватает таймаута на опрос экспериментов.',
            createdAt: 3,
            resolved: false,
            severity: 'MAJOR',
            anchor: { path: 'autotests/experiments/src/client.py', line: 42, lineType: 'ADDED' },
            replies: [{ author: 'Анна', authorSlug: 'an', text: 'Добавлю.', createdAt: 4 }],
        },
        {
            id: 102,
            author: 'ICT',
            authorSlug: 'ci',
            text: 'Форматирование.',
            createdAt: 5,
            resolved: true,
            severity: null,
            anchor: null,
            replies: [],
        },
    ],
    commits: [{ sha: 'abc', shortSha: 'abc', author: 'Анна', summary: 'wip', date: 1 }],
    truncated: { diff: false, comments: false, commits: false },
};

const allScope = { comments: true, files: true };
const noScope = { comments: false, files: false };

describe('taskIdOfTitle', () => {
    test('reads the key the title opens with', () => {
        expect(taskIdOfTitle('DEMO-3223: Автоматизация')).toBe('DEMO-3223');
    });

    test('reads a key inside the title', () => {
        expect(taskIdOfTitle('fix: разбор DEMO-42 в клиенте')).toBe('DEMO-42');
    });

    test('a lowercase branch name is not a key', () => {
        expect(taskIdOfTitle('feature-1: правки')).toBeNull();
    });

    test('a title without a key says so', () => {
        expect(taskIdOfTitle('просто правки')).toBeNull();
    });
});

describe('parseAnalysisResult', () => {
    test('reads the block back into keyed structures', () => {
        const text = [
            'Разбор словами...',
            '```json',
            JSON.stringify({
                comments: {
                    '101': { summary: 'Нет таймаута', justified: true, variants: ['поставить timeout'] },
                    '102': { summary: 'Форматирование', justified: false, variants: [] },
                },
                files: {
                    'autotests/experiments/src/model.py': { verdict: 'ok', notes: 'чистое добавление' },
                },
                overall: { verdict: 'questions', notes: 'не всё покрыто' },
            }),
            '```',
        ].join('\n');
        const analysis = parseAnalysisResult(text);
        expect(analysis).not.toBeNull();
        expect(analysis?.comments.get(101)).toEqual({
            summary: 'Нет таймаута',
            justified: true,
            variants: ['поставить timeout'],
        });
        expect(analysis?.comments.get(102)?.justified).toBe(false);
        expect(analysis?.files.get('autotests/experiments/src/model.py')?.verdict).toBe('ok');
        expect(analysis?.overall?.verdict).toBe('questions');
    });

    test('the last well-formed block wins', () => {
        const text = [
            '```json',
            '{"overall": {"verdict": "ok", "notes": "ранний черновик"}}',
            '```',
            'нет, вот окончательный:',
            '```json',
            '{"overall": {"verdict": "concerns", "notes": "окончательный"}}',
            '```',
        ].join('\n');
        expect(parseAnalysisResult(text)?.overall?.notes).toBe('окончательный');
    });

    test('stray keys and empty summaries do not become footnotes', () => {
        const text = '```json\n' + JSON.stringify({
            comments: {
                '7x': { summary: 'мусорный id' },
                '0': { summary: 'нулевой id' },
                '101': { summary: '   ' },
                '102': { summary: 'годится' },
            },
        }) + '\n```';
        const analysis = parseAnalysisResult(text);
        expect(analysis?.comments.size).toBe(1);
        expect(analysis?.comments.get(102)?.justified).toBeNull();
    });

    test('prose without a block is no analysis', () => {
        expect(parseAnalysisResult('Я посмотрел, всё хорошо.')).toBeNull();
    });

    test('a broken block is no analysis', () => {
        expect(parseAnalysisResult('```json\n{"comments": {"1":')).toBeNull();
    });

    test('a verdict outside the contract rejects the block', () => {
        expect(
            parseAnalysisResult('```json\n{"files": {"a.py": {"verdict": "maybe"}}}\n```'),
        ).toBeNull();
    });

    test('an empty block reads as nothing', () => {
        expect(parseAnalysisResult('```json\n{}\n```')).toBeNull();
    });
});

describe('buildAnalysisPrompt', () => {
    test('carries meta, open comments and files when all is in scope', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology);
        expect(prompt).toContain('#4242');
        expect(prompt).toContain('Не хватает таймаута');
        expect(prompt).toContain('Ответ Анна: Добавлю.');
        expect(prompt).toContain('+class Model');
        expect(prompt).toContain('постановку задачи DEMO-3223');
    });

    test('the answer is a readable analysis first, the JSON block a digest tail', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology);
        expect(prompt).toContain('Сначала — полный читаемый разбор по-русски');
        expect(prompt).toContain('каждое открытое замечание (101)');
        expect(prompt).toContain('каждый файл (`autotests/experiments/src/model.py`, `autotests/common/configs/config.yaml`)');
        expect(prompt).toContain('общий вывод по ПРу в конце.');
        expect(prompt).toContain('ровно один блок JSON');
        expect(prompt).toContain('без повторения текста разбора');
        // The digest is demanded after the readable half, so the person
        // reads prose before any block.
        expect(prompt.indexOf('читаемый разбор')).toBeLessThan(prompt.indexOf('```json'));
    });

    test('resolved comments stay out of the material and the contract', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology);
        expect(prompt).not.toContain('Форматирование.');
        expect(prompt).not.toContain('102');
        expect(prompt).toContain('101');
        expect(prompt).toContain('Разбираются только открытые');
    });

    test('honours the scope checkboxes', () => {
        const prompt = buildAnalysisPrompt(baseView, { ...noScope, files: true }, defaultMethodology);
        expect(prompt).toContain('+class Model');
        expect(prompt).not.toContain('Не хватает таймаута');
        expect(prompt).not.toContain('Открытые комментарии');
    });

    test('the files reading carries the task for the model to fetch', () => {
        const prompt = buildAnalysisPrompt(baseView, { ...noScope, files: true }, defaultMethodology);
        expect(prompt).toContain('Сначала получи постановку задачи DEMO-3223');
        expect(prompt).toContain('проверь доработки на корректность относительно постановки');
    });

    test('a task without a readable key says so instead of pretending', () => {
        const view: BitbucketPullView = { ...baseView, pull: { ...baseView.pull, title: 'правки без ключа' } };
        const prompt = buildAnalysisPrompt(view, { ...noScope, files: true }, defaultMethodology);
        expect(prompt).toContain('Номер задачи в заголовке ПРа не читается');
        expect(prompt).toContain('постановку выведи из заголовка и описания ПРа');
    });

    test('a long diff is cut with a visible marker', () => {
        const long = `diff --git a/x b/x\n${'+line\n'.repeat(200)}`;
        const view: BitbucketPullView = {
            ...baseView,
            files: [{ path: 'big.py', changeType: 'modify', truncated: false, diffText: long }],
        };
        const prompt = buildAnalysisPrompt(view, { ...allScope, comments: false }, defaultMethodology);
        expect(prompt).toContain('more lines truncated');
        expect(prompt).toContain('дифф усечён');
    });

    test('the contract names the real ids and paths', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology);
        expect(prompt).toContain('101');
        expect(prompt).not.toContain('101, 102');
        expect(prompt).toContain('`autotests/common/configs/config.yaml`');
    });

    test('the contract narrows to the checked scope', () => {
        const commentsOnly = buildAnalysisPrompt(baseView, { ...noScope, comments: true }, defaultMethodology);
        expect(commentsOnly).toContain('101');
        expect(commentsOnly).toContain('«files»: в материале нет файлов');
        expect(commentsOnly).not.toContain('`autotests/common/configs/config.yaml`');
        expect(commentsOnly).not.toContain('Сначала получи постановку задачи');

        const filesOnly = buildAnalysisPrompt(baseView, { ...noScope, files: true }, defaultMethodology);
        expect(filesOnly).toContain('`autotests/experiments/src/model.py`');
        expect(filesOnly).toContain('открытых комментариев в материале нет');
        expect(filesOnly).not.toContain('101');
    });

    test('a previous reading rides along as a framed digest, before the material', () => {
        const analysis: PullAnalysis = {
            comments: new Map([[101, { summary: 'Таймаута нет', justified: true, variants: [' Добавить'] }]]),
            files: new Map([['autotests/experiments/src/model.py', { verdict: 'questions', notes: 'Без теста' }]]),
            overall: { verdict: 'questions', notes: 'Черновик' },
        };
        const digest = previousReadingDigest(analysis);
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology, { digest, at: 1700000000000 });
        // The frame names it a repeat: the model re-judges the old opinion
        // against fresh material instead of restating it.
        expect(prompt).toContain('повторное чтение ПРа');
        expect(prompt).toContain('прошлому мнению, а не к истине');
        expect(prompt).toContain('## Выжимка предыдущего чтения');
        expect(prompt).toContain(digest);
        // The digest opens with the opinion it frames, the material follows.
        expect(prompt.indexOf('Выжимка предыдущего чтения')).toBeLessThan(prompt.indexOf('## Pull request'));
    });

    test('a reading without a previous opinion says nothing about one', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology, null);
        expect(prompt).not.toContain('повторное чтение');
        expect(prompt).not.toContain('Выжимка предыдущего');
    });

    test('an attached Confluence brief rides as its own section with its frame', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology, null, {
            title: 'Release checklist',
            material: 'Confluence page: Release checklist\n\nПроверь артефакты.',
        });
        expect(prompt).toContain('Постановка задачи приложена ниже');
        expect(prompt).toContain('«Release checklist»');
        expect(prompt).toContain('## Постановка из Confluence');
        expect(prompt).toContain('Проверь артефакты.');
        // The attached brief sits before the material the reading judges.
        expect(prompt.indexOf('Постановка из Confluence')).toBeLessThan(prompt.indexOf('## Pull request'));
    });

    test('a reading with neither a brief nor a previous opinion embeds neither', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, defaultMethodology, null, null);
        expect(prompt).not.toContain('Постановка из Confluence');
        expect(prompt).toContain('## Pull request');
    });

    test('the digest keeps the keyed verdicts and drops nothing the re-judge needs', () => {
        const analysis: PullAnalysis = {
            comments: new Map([[101, { summary: 'Таймаута нет', justified: true, variants: ['Добавить'] }]]),
            files: new Map([['config.yaml', { verdict: 'ok', notes: 'Норм' }]]),
            overall: null,
        };
        const digest = JSON.parse(previousReadingDigest(analysis));
        expect(digest.comments['101']).toEqual({
            summary: 'Таймаута нет',
            justified: true,
            variants: ['Добавить'],
        });
        expect(digest.files['config.yaml']).toEqual({ verdict: 'ok', notes: 'Норм' });
        expect(digest.overall).toBeNull();
    });

    test('the session title stays short and names the pull', () => {
        expect(analysisSessionTitle(baseView)).toBe('PR #4242: DEMO-3223: Автоматизация приёмочных сценариев');
    });

    test('a custom methodology replaces the guidance, never the material or the contract', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope, 'Моя методика: смотри на пайплайны и логи.');
        expect(prompt).toContain('Моя методика: смотри на пайплайны и логи.');
        expect(prompt).not.toContain('Разбираются только открытые');
        // The app owns the rest: the material and the digest contract ride
        // along untouched, so the panel keeps its footnotes and verdicts.
        expect(prompt).toContain('Не хватает таймаута');
        expect(prompt).toContain('+class Model');
        expect(prompt).toContain('ровно один блок JSON');
    });

    test('a methodology without the task slot drops the task fetch, by its author\'s choice', () => {
        const prompt = buildAnalysisPrompt(baseView, { ...noScope, files: true }, 'Смотри только код ПРа.');
        expect(prompt).not.toContain('постановку задачи DEMO-3223');
        expect(prompt).toContain('Смотри только код ПРа.');
    });
});
