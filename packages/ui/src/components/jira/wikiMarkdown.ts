// The instance's wiki words into the markdown the shared renderer reads.
// Where DC answers comments and descriptions as wiki instead of the HTML
// it rendered, this pure pass turns the common markup into the markdown the
// rest of the card already speaks — headings, lists, tables, code. The
// uncommon markup passes through untouched rather than guessed at: a lost
// `^superscript^` is honest, a corrupted paragraph is not.
//
// The line is the unit: block macros open and close on their own lines,
// everything else is inline runs inside a line. Wiki syntax that Markdown
// answers differently (bold is `*` here and `**` there) is translated;
// syntax Markdown cannot carry (superscript, user mentions) stays literal.

/** The macros that own their lines: fenced code, unformatted text, quotes. */
const BLOCK_OPEN_PATTERN = /^\{(code|noformat|quote)(?::([^}]*))?\}$/;

/** The inline colors: stripped, never guessed into a Markdown cousin. */
const COLOR_PATTERN = /\{color(?::[^}]*)?\}/g;

/** `[label|url]` and `[url]`, the links wiki writes with one bracket pair. */
const LINK_PATTERN = /\[([^|\]]+)\|([^\]]+)\]|\[([a-z][a-z0-9+.-]*:[^\s\]]+)\]/gi;

/** `{{monospace}}` — wiki's backtick cousin, so it becomes one. */
const MONOSPACE_PATTERN = /\{\{(.*?)\}\}/g;

/** `-deleted-` — struck through in both dialects, spelled differently. */
const DELETED_PATTERN = /(^|[\s(["'«„])-(?!\s|-)([^-]*?[^\s-])-(?=$|[\s)."»,;:!?])/g;

/** `??citation??` — an emphasized quote; italics carry the emphasis. */
const CITATION_PATTERN = /\?\?([^?]+)\?\?/g;

/** `*bold*` — no space after the marker, the same boundary wiki demands. */
const BOLD_PATTERN = /\*([^*\s][^*]*?)\*/g;

/** `_italic_` — the underscore pair, again only around real words. */
const ITALIC_PATTERN = /_([^_\s][^_]*?)_/g;

/** One wiki line into the Markdown that says the same thing. Bold runs
 *  before citation: both write single stars, and Markdown's bold would
 *  otherwise read the citation's stars as its own. */
const inline = (text: string): string =>
    text
        .replace(COLOR_PATTERN, '')
        .replace(LINK_PATTERN, (_match, label: string | undefined, url: string | undefined, bare: string | undefined) =>
            bare ? `[${bare}](${bare})` : `[${label ?? url}](${url ?? bare ?? ''})`)
        .replace(MONOSPACE_PATTERN, '`$1`')
        .replace(DELETED_PATTERN, '$1~~$2~~')
        .replace(BOLD_PATTERN, '**$1**')
        .replace(CITATION_PATTERN, '*$1*')
        .replace(ITALIC_PATTERN, '*$1*');

/** One table row of wiki cells into Markdown pipes: `|a|b|` or `||a||b||`. */
const tableCellsOf = (line: string): string[] | null => {
    const header = /^(\|\|.*\|\|)$/.test(line);
    const body = /^\|.*\|$/.test(line);
    if (!header && !body) return null;
    // A header row carries a delimiter on both sides of every cell; a body
    // row wraps the whole line in one — the slices take exactly the words.
    const inner = header ? line.slice(2, -2) : body ? line.slice(1, -1) : null;
    const cells = (inner ?? '').split(header ? '||' : '|').map((cell) => cell.trim());
    return cells.length > 0 ? cells : null;
};

/** The Markdown row of a wiki table line, `|`-spaced like Markdown wants. */
const tableRowOf = (cells: string[]): string => `| ${cells.join(' | ')} |`;

/** One ordinary paragraph line: headings, quote lines, lists, tables, prose. */
const paragraphOf = (line: string): string[] => {
    const heading = /^(h([1-6]))\. ?(.*)$/.exec(line);
    if (heading) return [`${'#'.repeat(Number(heading[2]))} ${inline(heading[3])}`];

    const blockQuote = /^bq\. ?(.*)$/.exec(line);
    if (blockQuote) return [`> ${inline(blockQuote[1])}`];

    const cells = tableCellsOf(line);
    if (cells) {
        const rows = [tableRowOf(cells.map(inline))];
        // A wiki header row asks for the alignment line Markdown requires;
        // body rows pass through, the alignment already spoken for.
        if (line.startsWith('||')) rows.push(tableRowOf(cells.map(() => '---')));
        return rows;
    }

    const bullet = /^(\*+) (.*)$/.exec(line);
    if (bullet) return [`${'  '.repeat(bullet[1].length - 1)}- ${inline(bullet[2])}`];

    const numbered = /^(#+) (.*)$/.exec(line);
    if (numbered) return [`${'  '.repeat(numbered[1].length - 1)}1. ${inline(numbered[2])}`];

    return line === '' ? [''] : [inline(line)];
};

/** The open block macro: the word that closes it, and its fence if any. */
type OpenBlock = { closeWord: string; fence: string | null };

/**
 * Wiki into Markdown: one pass, line by line, the block macros held as
 * fenced blocks so their contents never meet the inline rules, quotes as
 * prefix lines. Unknown macros pass through whole — the line belongs to
 * the instance, not to a guess.
 */
export const jiraWikiToMarkdown = (wiki: string): string => {
    if (wiki === '') return '';
    const out: string[] = [];
    let openBlock: OpenBlock | null = null;
    for (const rawLine of wiki.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (openBlock === null) {
            const open = BLOCK_OPEN_PATTERN.exec(line);
            if (open) {
                if (open[1] === 'quote') {
                    openBlock = { closeWord: '{quote}', fence: null };
                } else {
                    const language = (open[2] ?? '').trim();
                    out.push(`\`\`\`${language}`);
                    openBlock = { closeWord: open[1] === 'code' ? '{code}' : '{noformat}', fence: '```' };
                }
                continue;
            }
            // A quote may open mid-line and close on the same or a later
            // line; both spellings appear in real descriptions.
            const inlineQuote = /^\{quote\}(.*)$/.exec(line);
            if (inlineQuote) {
                const rest = inlineQuote[1].replace(/\{quote\}$/, '');
                out.push(`> ${inline(rest)}`);
                openBlock = inlineQuote[1].endsWith('{quote}') ? null : { closeWord: '{quote}', fence: null };
                continue;
            }
            out.push(...paragraphOf(line));
        } else if (openBlock.fence !== null) {
            if (line === openBlock.closeWord) {
                out.push(openBlock.fence);
                openBlock = null;
            } else {
                out.push(rawLine);
            }
        } else {
            if (line === openBlock.closeWord) {
                openBlock = null;
                continue;
            }
            const content = line.endsWith('{quote}') ? line.slice(0, -'{quote}'.length) : line;
            if (content !== '') out.push(`> ${inline(content)}`);
            if (line.endsWith('{quote}')) openBlock = null;
        }
    }
    // An unterminated block stays honest: its contents are already out, the
    // closing fence arrives only if the instance wrote it.
    if (openBlock?.fence) out.push(openBlock.fence);
    return out.join('\n');
};
