import { describe, expect, test } from 'bun:test';

import { excerptAround, parseDiffRows } from './pullDiff';

const SAMPLE = [
    'diff --git a/checker.py b/checker.py',
    '--- a/checker.py',
    '+++ b/checker.py',
    '@@ -10,4 +10,6 @@ def check(msisdn):',
    ' def check(msisdn):',
    '-    return old()',
    '+    headers = build()',
    '+    return new(headers)',
    ' ',
    ' # trailing note',
].join('\n');

describe('parseDiffRows', () => {
    test('-numbers hunks from their headers and advances each side by kind', () => {
        const rows = parseDiffRows(SAMPLE);
        expect(rows.map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
            ['meta', null, null],
            ['meta', null, null],
            ['meta', null, null],
            ['meta', null, null],
            ['context', 10, 10],
            ['removed', 11, null],
            ['added', null, 11],
            ['added', null, 12],
            ['context', 12, 13],
            ['context', 13, 14],
        ]);
    });

    test('a removed row advances only the old side, an added only the new', () => {
        const rows = parseDiffRows('@@ -1,1 +1,1 @@\n-a\n+b\n c');
        expect(rows.slice(1).map((row) => [row.kind, row.oldLine, row.newLine])).toEqual([
            ['removed', 1, null],
            ['added', null, 1],
            ['context', 2, 2],
        ]);
    });

    test('a single-line hunk may omit the counts and still number from one', () => {
        const rows = parseDiffRows('@@ -5 +7 @@\n-x\n+y');
        expect(rows[1]).toEqual({ kind: 'removed', text: '-x', oldLine: 5, newLine: null });
        expect(rows[2]).toEqual({ kind: 'added', text: '+y', oldLine: null, newLine: 7 });
    });

    test('keeps the patch row text untouched, prefix included', () => {
        const rows = parseDiffRows('@@ -1,1 +1,1 @@\n+    return (');
        expect(rows[1].text).toBe('+    return (');
    });

    test('an empty context row survives as context without advancing', () => {
        // Real patches prefix context rows with a space; the blank row between
        // them is the patch's own empty line.
        const rows = parseDiffRows('@@ -1,3 +1,3 @@\n a\n\n b');
        expect(rows[1]).toEqual({ kind: 'context', text: ' a', oldLine: 1, newLine: 1 });
        expect(rows[2]).toEqual({ kind: 'context', text: '', oldLine: 2, newLine: 2 });
        expect(rows[3]).toEqual({ kind: 'context', text: ' b', oldLine: 2, newLine: 2 });
    });

    test('unknown rows fall back to meta instead of guessing a kind', () => {
        const rows = parseDiffRows('something odd');
        expect(rows[0]).toEqual({ kind: 'meta', text: 'something odd', oldLine: null, newLine: null });
    });
});

describe('excerptAround', () => {
    test('caps both directions around the chosen row', () => {
        const rows = parseDiffRows(['@@ -1,60 +1,60 @@', ...Array.from({ length: 60 }, (_, i) => ` ctx${i}`)].join('\n'));
        const excerpt = excerptAround(rows, 30, 5);
        expect(excerpt).toHaveLength(11);
        // Context rows begin one row past the hunk header, so the window that
        // opens at row 25 reads the context numbered 24.
        expect(excerpt[0].text).toBe(' ctx24');
        expect(excerpt[10].text).toBe(' ctx34');
    });

    test('clamps at the array edges instead of underflowing', () => {
        const rows = parseDiffRows(SAMPLE);
        const excerpt = excerptAround(rows, 0, 2);
        expect(excerpt[0]).toEqual(rows[0]);
        expect(excerpt).toHaveLength(3);
    });
});
