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

/**
 * The rows of a chosen span — from one row to another, endpoints included —
 * with the same breathing room `excerptAround` gives a single line, so a
 * question about a range still arrives with its surroundings. The span's
 * own rows always ride along regardless of the radius.
 */
export const excerptRange = (
    rows: readonly DiffRow[],
    fromIndex: number,
    toIndex: number,
    radius = 12,
): DiffRow[] => {
    const first = Math.max(0, Math.min(fromIndex, toIndex) - radius);
    const last = Math.min(rows.length, Math.max(fromIndex, toIndex) + radius + 1);
    return rows.slice(first, last);
};

/**
 * One excerpt's rows as the ask carries them: a line number a side has
 * promised, then the row's own text. Meta rows carry no number and ride
 * along as they are.
 */
export const rowsAsQuote = (excerpt: readonly DiffRow[]): string =>
    excerpt
        .map((entry) => {
            const number = entry.newLine ?? entry.oldLine;
            return number === null ? entry.text : `${String(number).padStart(4, ' ')}| ${entry.text}`;
        })
        .join('\n');

/**
 * Where a comment's anchor lands in the file's rows: a comment hung on a
 * removed line is addressed by the old side's numbering, everything else
 * by the new side's. -1 when the anchor carries no line of its own or no
 * row answers the line it names.
 */
export const anchorRowIndex = (
    rows: readonly DiffRow[],
    anchor: { line?: number | null; lineType?: string | null },
): number => {
    if (anchor.line === null || anchor.line === undefined) return -1;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (anchor.lineType === 'REMOVED' && row.oldLine === anchor.line) return index;
        if (anchor.lineType !== 'REMOVED' && row.newLine === anchor.line) return index;
    }
    return -1;
};

/**
 * The file's code as a highlighter wants it — file headers and hunk
 * headers left out, prefix characters stripped — together with each
 * row's place in that text, so a viewer tokenizes the whole diff once,
 * in one worker call, and still knows which colored line belongs to
 * which row. -1 marks a row the text leaves out.
 */
export interface DiffCodeMap {
    code: string;
    lineOf: number[];
}

export const codeMapOf = (rows: readonly DiffRow[]): DiffCodeMap => {
    const pieces: string[] = [];
    const lineOf: number[] = [];
    for (const row of rows) {
        if (row.kind === 'meta') {
            lineOf.push(-1);
            continue;
        }
        lineOf.push(pieces.length);
        pieces.push(row.text.length > 1 ? row.text.slice(1) : '');
    }
    return { code: pieces.join('\n'), lineOf };
};
