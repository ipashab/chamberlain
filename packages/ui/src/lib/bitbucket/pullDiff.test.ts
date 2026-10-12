import { describe, expect, test } from 'bun:test';

import { anchorRowIndex, codeMapOf, excerptAround, excerptRange, parseDiffRows, rowsAsQuote } from './pullDiff';

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

describe('excerptRange', () => {
    const manyRows = parseDiffRows(
        ['@@ -1,60 +1,60 @@', ...Array.from({ length: 60 }, (_, i) => ` ctx${i}`)].join('\n'),
    );

    test('covers the chosen span with the same breathing room on both sides', () => {
        const excerpt = excerptRange(manyRows, 20, 25, 5);
        // One past the hunk header: the window covers indexes 15 to 30,
        // the context rows ctx14 through ctx29.
        expect(excerpt[0].text).toBe(' ctx14');
        expect(excerpt[excerpt.length - 1].text).toBe(' ctx29');
        expect(excerpt).toHaveLength(16);
    });

    test('reads the same span whichever end the drag began at', () => {
        expect(excerptRange(manyRows, 25, 20, 5)).toEqual(excerptRange(manyRows, 20, 25, 5));
    });

    test('clamps at the array edges instead of underflowing', () => {
        const rows = parseDiffRows(SAMPLE);
        const excerpt = excerptRange(rows, 0, rows.length - 1, 5);
        expect(excerpt).toEqual(rows);
    });
});

describe('rowsAsQuote', () => {
    test('numbers the rows the sides promise and leaves meta bare', () => {
        const rows = parseDiffRows(SAMPLE);
        const quote = rowsAsQuote(rows);
        const quoteLines = quote.split('\n');
        // The file header and the hunk head arrive as they are.
        expect(quoteLines[0]).toBe('diff --git a/checker.py b/checker.py');
        expect(quoteLines[3]).toBe('@@ -10,4 +10,6 @@ def check(msisdn):');
        // Numbered rows carry their number; the removed row counts old.
        expect(quoteLines[4]).toBe('  10|  def check(msisdn):');
        expect(quoteLines[5]).toBe('  11| -    return old()');
        expect(quoteLines[6]).toBe('  11| +    headers = build()');
        expect(quoteLines[9]).toBe('  14|  # trailing note');
    });
});

describe('anchorRowIndex', () => {
    test('a removed anchor counts the old side, every other the new one', () => {
        const rows = parseDiffRows(SAMPLE);
        expect(anchorRowIndex(rows, { line: 11, lineType: 'REMOVED' })).toBe(5);
        expect(anchorRowIndex(rows, { line: 11, lineType: 'ADDED' })).toBe(6);
        expect(anchorRowIndex(rows, { line: 13, lineType: null })).toBe(8);
    });

    test('a context anchor reads the new side, the way the instance numbers it', () => {
        const rows = parseDiffRows(SAMPLE);
        expect(anchorRowIndex(rows, { line: 14, lineType: 'CONTEXT' })).toBe(9);
    });

    test('an anchor without a line, or one the diff no longer holds, has no row', () => {
        const rows = parseDiffRows(SAMPLE);
        expect(anchorRowIndex(rows, { line: null, lineType: 'ADDED' })).toBe(-1);
        expect(anchorRowIndex(rows, { line: 999, lineType: 'ADDED' })).toBe(-1);
    });
});

describe('codeMapOf', () => {
    test('strips the prefix and leaves header rows out of the text', () => {
        const rows = parseDiffRows(SAMPLE);
        const codeMap = codeMapOf(rows);
        expect(codeMap.code).toBe([
            'def check(msisdn):',
            '    return old()',
            '    headers = build()',
            '    return new(headers)',
            '',
            '# trailing note',
        ].join('\n'));
        // Each row keeps its place in that text; headers read back as none.
        expect(codeMap.lineOf).toEqual([-1, -1, -1, -1, 0, 1, 2, 3, 4, 5]);
    });

    test('a code row that carries only its prefix maps to an empty line', () => {
        const rows = parseDiffRows('@@ -1,1 +1,1 @@\n+');
        const codeMap = codeMapOf(rows);
        expect(codeMap.code).toBe('');
        expect(codeMap.lineOf).toEqual([-1, 0]);
    });
});
