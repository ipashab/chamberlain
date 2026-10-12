// The unified patch the server rebuilds for each file — `diff --git`,
// `---`/`+++`, hunks, prefixed lines — turned into rows the viewer can
// number, color and aim a question at.
//
// The parser answers structure, nothing else: each row keeps the patch's
// own text, the kind its first character claims, and the two line numbers
// the hunks promise — the old file's for removed rows, the new file's for
// added and context rows. Rows outside a hunk (the file header) carry no
// numbers and no question: there is nothing stable to ask about.

export type DiffRowKind = 'meta' | 'added' | 'removed' | 'context';

export interface DiffRow {
    kind: DiffRowKind;
    /** The row as the patch writes it, prefix character included. */
    text: string;
    /** The line's number in the file before the change, when it has one. */
    oldLine: number | null;
    /** The line's number in the file after the change, when it has one. */
    newLine: number | null;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * One unified patch into rows. Numbering follows the patch: a hunk says
 * where each side starts, context rows advance both sides, added rows
 * advance only the new side, removed rows only the old side.
 */
export const parseDiffRows = (diffText: string): DiffRow[] => {
    const rows: DiffRow[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const rawLine of diffText.split('\n')) {
        const hunk = HUNK_HEADER_PATTERN.exec(rawLine);
        if (hunk) {
            oldLine = Number.parseInt(hunk[1] ?? '0', 10);
            newLine = Number.parseInt(hunk[3] ?? '0', 10);
            rows.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
            continue;
        }
        // The file header's own markers start with the added and removed
        // prefixes; they name files, not lines, so they read as meta first.
        if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ') || rawLine.startsWith('diff --git')) {
            rows.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
            continue;
        }
        if (rawLine.startsWith('+')) {
            rows.push({ kind: 'added', text: rawLine, oldLine: null, newLine });
            newLine += 1;
            continue;
        }
        if (rawLine.startsWith('-')) {
            rows.push({ kind: 'removed', text: rawLine, oldLine, newLine: null });
            oldLine += 1;
            continue;
        }
        if (rawLine.startsWith(' ') || rawLine === '') {
            rows.push({ kind: 'context', text: rawLine, oldLine, newLine });
            if (rawLine !== '') {
                oldLine += 1;
                newLine += 1;
            }
            continue;
        }
        rows.push({ kind: 'meta', text: rawLine, oldLine: null, newLine: null });
    }
    return rows;
};

/**
 * The rows around one row, for asking about it with its own context: the
 * hunk region the row lives in, capped so a question never carries a whole
 * file. The chosen row keeps its place; the excerpt's first and last row
 * numbers tell the reader where the window landed.
 */
export const excerptAround = (rows: readonly DiffRow[], index: number, radius = 12): DiffRow[] => {
    const first = Math.max(0, index - radius);
    const last = Math.min(rows.length, index + radius + 1);
    return rows.slice(first, last);
};
