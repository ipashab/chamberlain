import { describe, expect, test } from 'bun:test';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';

import {
    analysisSessionTitle,
    buildAnalysisPrompt,
    parseAnalysisResult,
    taskIdOfTitle,
} from './pullAnalysis';

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
        const prompt = buildAnalysisPrompt(baseView, allScope);
        expect(prompt).toContain('#4242');
        expect(prompt).toContain('Не хватает таймаута');
        expect(prompt).toContain('Ответ Анна: Добавлю.');
        expect(prompt).toContain('+class Model');
        expect(prompt).toContain('постановку задачи DEMO-3223');
    });

    test('resolved comments stay out of the material and the contract', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope);
        expect(prompt).not.toContain('Форматирование.');
        expect(prompt).not.toContain('102');
        expect(prompt).toContain('101');
        expect(prompt).toContain('Разбираются только открытые');
    });

    test('honours the scope checkboxes', () => {
        const prompt = buildAnalysisPrompt(baseView, { ...noScope, files: true });
        expect(prompt).toContain('+class Model');
        expect(prompt).not.toContain('Не хватает таймаута');
        expect(prompt).not.toContain('Открытые комментарии');
    });

    test('the files reading carries the task for the model to fetch', () => {
        const prompt = buildAnalysisPrompt(baseView, { ...noScope, files: true });
        expect(prompt).toContain('Сначала получи постановку задачи DEMO-3223');
        expect(prompt).toContain('проверь доработки на корректность относительно постановки');
    });

    test('a task without a readable key says so instead of pretending', () => {
        const view: BitbucketPullView = { ...baseView, pull: { ...baseView.pull, title: 'правки без ключа' } };
        const prompt = buildAnalysisPrompt(view, { ...noScope, files: true });
        expect(prompt).toContain('Номер задачи в заголовке ПРа не читается');
        expect(prompt).toContain('постановку выведи из заголовка и описания ПРа');
    });

    test('a long diff is cut with a visible marker', () => {
        const long = `diff --git a/x b/x\n${'+line\n'.repeat(200)}`;
        const view: BitbucketPullView = {
            ...baseView,
            files: [{ path: 'big.py', changeType: 'modify', truncated: false, diffText: long }],
        };
        const prompt = buildAnalysisPrompt(view, { ...allScope, comments: false });
        expect(prompt).toContain('more lines truncated');
        expect(prompt).toContain('дифф усечён');
    });

    test('the contract names the real ids and paths', () => {
        const prompt = buildAnalysisPrompt(baseView, allScope);
        expect(prompt).toContain('101');
        expect(prompt).not.toContain('101, 102');
        expect(prompt).toContain('`autotests/common/configs/config.yaml`');
    });

    test('the contract narrows to the checked scope', () => {
        const commentsOnly = buildAnalysisPrompt(baseView, { ...noScope, comments: true });
        expect(commentsOnly).toContain('101');
        expect(commentsOnly).toContain('«files»: в материале нет файлов');
        expect(commentsOnly).not.toContain('`autotests/common/configs/config.yaml`');
        expect(commentsOnly).not.toContain('Сначала получи постановку задачи');

        const filesOnly = buildAnalysisPrompt(baseView, { ...noScope, files: true });
        expect(filesOnly).toContain('`autotests/experiments/src/model.py`');
        expect(filesOnly).toContain('открытых комментариев в материале нет');
        expect(filesOnly).not.toContain('101');
    });

    test('the session title stays short and names the pull', () => {
        expect(analysisSessionTitle(baseView)).toBe('PR #4242: DEMO-3223: Автоматизация приёмочных сценариев');
    });
});
