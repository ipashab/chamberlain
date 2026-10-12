import { describe, expect, test } from 'bun:test';

import { splitTrailingJsonDigest } from './trailingJsonDigest';

describe('splitTrailingJsonDigest', () => {
    test('splits prose from a trailing json fence, counting the digest lines', () => {
        const answer = [
            'Разбор по существу: замечание справедливо.',
            '',
            '```json',
            '{"overall": {"verdict": "ok",',
            '  "notes": "всё хорошо"}}',
            '```',
        ].join('\n');
        const split = splitTrailingJsonDigest(answer);
        expect(split).not.toBeNull();
        expect(split?.prose).toBe('Разбор по существу: замечание справедливо.');
        expect(split?.lines).toBe(2);
    });

    test('an answer without a fence is no digest — the text stays whole', () => {
        expect(splitTrailingJsonDigest('Просто текст без блока.')).toBeNull();
    });

    test('a fence that is not last is no digest — mid-answer code stays visible', () => {
        const answer = 'Текст до.\n```json\n{"a": 1}\n```\nТекст после блока.';
        expect(splitTrailingJsonDigest(answer)).toBeNull();
    });

    test('a fence with no prose before it is no digest — the whole answer is the block', () => {
        expect(splitTrailingJsonDigest('```json\n{"a": 1}\n```')).toBeNull();
    });

    test('a fence whose body is not one JSON object is no digest', () => {
        expect(splitTrailingJsonDigest('Разбор.\n```json\n[1, 2]\n```')).toBeNull();
        expect(splitTrailingJsonDigest('Разбор.\n```json\nnot json at all\n```')).toBeNull();
    });

    test('a code fence of another language never folds', () => {
        const answer = 'Разбор.\n```python\nprint(1)\n```';
        expect(splitTrailingJsonDigest(answer)).toBeNull();
    });

    test('whitespace after the closing fence still folds', () => {
        const answer = 'Разбор.\n```json\n{"a": 1}\n```\n\n  ';
        expect(splitTrailingJsonDigest(answer)).not.toBeNull();
        expect(splitTrailingJsonDigest(answer)?.prose).toBe('Разбор.');
    });
});
