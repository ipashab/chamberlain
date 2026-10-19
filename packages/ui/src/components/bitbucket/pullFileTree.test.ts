import { describe, expect, test } from 'bun:test';

import { buildPullFileTree, type PullFileRow } from './pullFileTree';

type PullFile = Parameters<typeof buildPullFileTree>[0][number];

/** The changed files as readable lines, so an assertion shows the listing it checked. */
const listing = (rows: readonly PullFileRow[], depth = 0): string[] => rows.flatMap((row) => row.kind === 'folder'
    ? [
        `${'  '.repeat(depth)}dir ${row.path} [${row.label}] ${row.fileCount}`,
        ...listing(row.children, depth + 1),
    ]
    : [`${'  '.repeat(depth)}file ${row.file.path}`]);

const file = (path: string): PullFile => ({
    path,
    changeType: 'modify',
    truncated: false,
    diffText: '',
});

describe('buildPullFileTree', () => {
    test('groups paths under their folders', () => {
        expect(listing(buildPullFileTree([file('src/a.ts'), file('src/deep/b.ts')]))).toEqual([
            'dir src [src] 2',
            '  dir src/deep [deep] 1',
            '    file src/deep/b.ts',
            '  file src/a.ts',
        ]);
    });

    test('lists folders before the files of their own level', () => {
        expect(listing(buildPullFileTree([file('README.md'), file('docs/a.md')]))).toEqual([
            'dir docs [docs] 1',
            '  file docs/a.md',
            'file README.md',
        ]);
    });

    test('folds a chain of single-child folders into one row', () => {
        expect(listing(buildPullFileTree([file('a/b/c/x.ts')]))).toEqual([
            'dir a [a/b/c] 1',
            '  file a/b/c/x.ts',
        ]);
    });

    test('stops folding at the level that holds a file', () => {
        expect(listing(buildPullFileTree([file('a/b/x.ts'), file('a/b/c/y.ts')]))).toEqual([
            'dir a [a/b] 2',
            '  dir a/b/c [c] 1',
            '    file a/b/c/y.ts',
            '  file a/b/x.ts',
        ]);
    });

    test('keeps the order the server listed files in', () => {
        expect(listing(buildPullFileTree([file('a/z.ts'), file('a/m.ts')]))).toEqual([
            'dir a [a] 2',
            '  file a/z.ts',
            '  file a/m.ts',
        ]);
    });

    test('counts every file under a folder, however deep', () => {
        const [folder] = buildPullFileTree([file('a/x.ts'), file('a/b/y.ts'), file('a/b/c/z.ts')]);
        expect(folder).toMatchObject({ kind: 'folder', path: 'a', fileCount: 3 });
    });

    test('ignores empty segments and answers nothing for no files', () => {
        expect(listing(buildPullFileTree([file('/a//b.java')]))).toEqual([
            'dir a [a] 1',
            '  file /a//b.java',
        ]);
        expect(buildPullFileTree([])).toEqual([]);
    });
});
