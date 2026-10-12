// The analysis flow's pure half: what the asking message carries, what the
// answering message must look like, and how the answer is read back. The
// button, the dialog and the footnotes live in the pull body; nothing here
// touches stores, sessions or the DOM, so the whole contract is testable
// as text in, structure out.
//
// The shape of the deal: the panel opens a dedicated session whose first
// message embeds the pull (meta, comments, capped diffs) and demands a
// two-part answer — a readable analysis for the person first, a compact
// fenced JSON block last. The block is machine food: the panel hangs its
// footnotes and verdict chips off it and the person reads the prose. The
// parser is deliberately forgiving about where that block sits in the
// answer and strict about what is inside it — an answer that does not fit
// is no analysis at all, and the panel says so rather than guessing.

import { z } from 'zod';

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';

/** Which of the two readings the user asked for. */
export type AnalysisScope = {
    comments: boolean;
    files: boolean;
};

/**
 * The comments the reading may judge: the open, not-yet-resolved ones.
 * A resolved thread is a settled matter — re-judging it from a diff
 * snippet second-guesses a decision already made, so it never reaches
 * the material. The whole point is what still demands a reaction.
 */
const openCommentsOf = (view: BitbucketPullView) => view.comments.filter((comment) => !comment.resolved);

/** One comment's footnote: its gist, its merit, and what to do about it. */
export type CommentAnalysis = {
    summary: string;
    justified: boolean | null;
    variants: string[];
};

/** One file's verdict chip and the notes behind it. */
export type FileAnalysis = {
    verdict: 'ok' | 'questions' | 'concerns';
    notes: string;
};

/** The whole reading, keyed so the panel can hang it on real entities. */
export type PullAnalysis = {
    comments: ReadonlyMap<number, CommentAnalysis>;
    files: ReadonlyMap<string, FileAnalysis>;
    overall: { verdict: 'ok' | 'questions' | 'concerns'; notes: string } | null;
};

// A file's patch may not outgrow its share of the asking message: past this
// many lines the diff is cut with a marker the model is told to weigh into
// its verdict. The server caps the raw patch too; this cap is the prompt's.
const DIFF_LINE_CAP = 120;
// And no reading may drown the session in total: when the budget runs out,
// the remaining files arrive by name only, with the same warning note.
const DIFF_TOTAL_BUDGET = 3000;

const verdictSchema = z.enum(['ok', 'questions', 'concerns']);

const analysisBlockSchema = z
    .object({
        comments: z
            .record(
                z.string(),
                z.object({
                    summary: z.string(),
                    justified: z.boolean().nullish(),
                    variants: z.array(z.string()).nullish(),
                }),
            )
            .nullish(),
        files: z
            .record(
                z.string(),
                z.object({
                    verdict: verdictSchema,
                    notes: z.string().nullish(),
                }),
            )
            .nullish(),
        overall: z
            .object({
                verdict: verdictSchema,
                notes: z.string().nullish(),
            })
            .nullish(),
    })
    // The model may decorate the block with a key we did not ask for; it
    // must not cost the whole reading. Known keys are still checked.
    .passthrough();

/**
 * The task key a pull title carries, Bitbucket-style: `DEMO-3223: ...`.
 * Uppercase letters first, digits after — a branch name like `feature-1`
 * is not a key, `AB-123456` still may be one.
 */
export const taskIdOfTitle = (title: string): string | null =>
    title.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/)?.[0] ?? null;

/** The dedicated session's title, short enough for the session list. */
export const analysisSessionTitle = (view: BitbucketPullView): string =>
    `PR #${view.pull.number}: ${view.pull.title}`.slice(0, 80);

/** A diff trimmed to the prompt's budget, with the cut left visible. */
type CappedDiff = { text: string; cut: number };

const cappedDiff = (diffText: string, cap: number): CappedDiff => {
    const lines = diffText.split('\n');
    if (lines.length <= cap) {
        return { text: diffText, cut: 0 };
    }
    const cut = lines.length - cap;
    return {
        text: `${lines.slice(0, cap).join('\n')}\n[... ${cut} more lines truncated in this message ...]`,
        cut,
    };
};

/**
 * The answer contract: what the readable half must cover, and the shape of
 * the machine half. The readable analysis is the main deliverable — a
 * person opens the session to read it — and the JSON block is a compact
 * digest of that same text, ordered into keys the panel can hang its
 * footnotes and verdict chips on. Repeating the analysis in full inside
 * the block is a failure of the contract, not its spirit.
 */
const outputContract = (view: BitbucketPullView, scope: AnalysisScope): string => {
    // The contract may only name entities that are actually in the material:
    // an unchecked scope means the reading never sees those bodies, and a
    // verdict demanded over unseen data is a verdict invited to invent.
    const commentIds = scope.comments ? openCommentsOf(view).map((comment) => comment.id).join(', ') : '';
    const filePaths = scope.files ? view.files.map((file) => `\`${file.path}\``).join(', ') : '';

    // What the readable half owes the person: exactly the bodies the scope
    // let into the material, in a fixed order, closing on the whole pull.
    const readable: string[] = [];
    if (scope.comments) {
        readable.push(
            commentIds
                ? `- каждое открытое замечание (${commentIds}): суть в пару строк, справедливо ли оно относительно своей строки/файла — и что сделать, если доработка нужна;`
                : '- открытых замечаний в материале нет — этой части в разборе не будет;',
        );
    }
    if (scope.files) {
        readable.push(
            filePaths
                ? `- каждый файл (${filePaths}): вердикт с обоснованием — решает ли дифф постановку, что недоработано, что лишнее;`
                : '- файлов в материале нет — этой части в разборе не будет;',
        );
    }
    readable.push('- общий вывод по ПРу в конце.');

    const parts = [
        '## Ответ',
        '',
        'Ответ из двух частей. Сначала — полный читаемый разбор по-русски, для человека: связный текст обычными абзацами и списками (без всякого JSON). Именно он — главный ответ, раскрывай каждый пункт по существу. В нём:',
        ...readable,
        '',
        'Затем, после разбора, последним сообщением — ровно один блок JSON, обёрнутый в тройные кавычки с языком `json`: машинная выжимка того же разбора для панели интерфейса, не для чтения. Значения короткие, без повторения текста разбора, без комментариев внутри. Структура:',
        '',
        '```json',
        '{',
        '  "comments": { "<id>": { "summary": "суть замечания одной-двумя строками",',
        '                              "justified": true | false,',
        '                              "variants": ["вариант доработки", "..."] } },',
        '  "files":    { "<path>": { "verdict": "ok" | "questions" | "concerns",',
        '                            "notes": "почему такой вердикт" } },',
        '  "overall":  { "verdict": "ok" | "questions" | "concerns", "notes": "..." }',
        '}',
        '```',
        '',
        'Правила блока:',
        commentIds
            ? `- «comments»: ключи — только id открытых комментариев из материала (${commentIds}); справедливость оценивается относительно строки/файла, к которым замечание прилинковано. «variants» — только если доработка нужна, иначе пустой список.`
            : '- «comments»: открытых комментариев в материале нет — поле опущено.',
        filePaths
            ? `- «files»: ключи — только пути файлов из материала (${filePaths}); «verdict» честный: усечённый диф не «ok» без слов о том.`
            : '- «files»: в материале нет файлов — поле опущено.',
        '- «overall»: оценка ПРа целиком; «notes» — по-русски, по делу.',
        '- Никаких ключей сверх перечисленных; разбор перед блоком — обычный текст, без JSON.',
    ];
    return parts.join('\n');
};

/**
 * The asking message: what to read, what to weigh, what to answer. The
 * judging instructions are the caller's to pass — the Magic Prompts
 * settings own their default and override — while the material and the
 * answer contract stay the app's: the panel's footnotes and verdict
 * chips hang off the contract, and no methodology text replaces it. The
 * message embeds the whole reading material — meta, comments with their
 * anchors, diffs inside the two budgets — so the analysis session can
 * work without any Bitbucket access of its own. The language of the
 * answer is Russian, and nothing here promises a button the panel does
 * not render.
 */
export const buildAnalysisPrompt = (view: BitbucketPullView, scope: AnalysisScope, methodology: string): string => {
    const taskId = taskIdOfTitle(view.pull.title);
    // How to reach the requirements the diffs answer to: by the task key
    // when the title carries one, or honestly without one. The slot
    // fills only for a files reading — comments alone are judged against
    // their own lines, and a task fetch nobody asked for is noise. The
    // methodology's `{{task_instruction}}` slot decides where the words
    // land; an override without the slot keeps its own way of saying it.
    const filesTaskInstruction = taskId
        ? `Сначала получи постановку задачи ${taskId}: возьми её доступными инструментами (Jira/Confluence-интеграции, MCP, поиск — можно выходить за пределы этого сообщения) или найди сведения в доступных источниках. Затем проверь доработки на корректность относительно постановки: решают ли диффы задачу, что недоработано, что лишнее.`
        : 'Номер задачи в заголовке ПРа не читается — постановку выведи из заголовка и описания ПРа (при возможности дополни доступными источниками) и прямо скажи об этом в вердиктах. Доработки проверяй на корректность относительно этой постановки.';
    const taskInstruction = scope.files ? filesTaskInstruction : '';
    const methodologyText = methodology.replace(/\{\{\s*task_instruction\s*\}\}/g, taskInstruction);

    const head = [
        `Проанализируй Bitbucket pull request #${view.pull.number}: ${view.pull.title}.`,
        'Материал ПРа встроен в сообщение: в сам Bitbucket ходить не нужно — комментариев и диффов здесь столько, сколько есть.',
        '',
        methodologyText,
        '',
        '## Pull request',
        '',
        `- Заголовок: ${view.pull.title}`,
        `- Состояние: ${view.pull.state}, автор: ${view.pull.author ?? 'неизвестен'}`,
        `- Ветки: ${view.pull.fromBranch ?? '?'} → ${view.pull.toBranch ?? '?'}`,
        view.pull.description ? `- Описание:\n${view.pull.description}` : '- Описания нет.',
        '',
    ];

    const sections: string[] = [];

    const openComments = openCommentsOf(view);
    if (scope.comments && openComments.length > 0) {
        const lines = [
            '## Открытые комментарии',
            '',
        ];
        for (const comment of openComments) {
            const anchor = comment.anchor;
            lines.push(
                `### id ${comment.id} — ${comment.author ?? 'неизвестно'}` +
                    `${anchor ? `, ${anchor.path}${anchor.line ? `:${anchor.line}` : ''}` : ''}`,
                comment.text,
            );
            for (const reply of comment.replies) {
                lines.push(`Ответ ${reply.author ?? 'неизвестно'}: ${reply.text}`);
            }
            lines.push('');
        }
        if (view.truncated.comments) {
            lines.push('Внимание: список комментариев усечён сервером, часть переписки не видна.', '');
        }
        sections.push(lines.join('\n'));
    }

    if (scope.files && view.files.length > 0) {
        const lines = ['## Диффы файлов', ''];
        let budget = DIFF_TOTAL_BUDGET;
        const omitted: string[] = [];
        for (const file of view.files) {
            if (budget <= 0) {
                omitted.push(file.path);
                continue;
            }
            const { text, cut } = cappedDiff(file.diffText, Math.min(DIFF_LINE_CAP, budget));
            budget -= text.split('\n').length;
            lines.push(
                `### ${file.path} (${file.changeType}${file.truncated || cut > 0 ? ', дифф усечён' : ''})`,
                '```diff',
                text,
                '```',
                '',
            );
        }
        if (omitted.length > 0) {
            lines.push(
                `Бюджет сообщения исчерпан — диффы этих файлов не включены (вердикт по ним давать поимённо, с этой оговоркой): ${omitted.join(', ')}.`,
                '',
            );
        }
        sections.push(lines.join('\n'));
    }

    return [...head, ...sections, outputContract(view, scope)].join('\n');
};

/**
 * Read the answer back. The last well-formed fenced JSON block wins (the
 * model may show drafts earlier); anything that does not fit the contract
 * yields null, and the panel keeps its "open the session" fallback. Keys
 * that are not valid comment ids are dropped — the panel hangs footnotes
 * only on entities it actually has, and a stray id is noise, not a crash.
 */
export const parseAnalysisResult = (text: string): PullAnalysis | null => {
    const blockPattern = /```json\s*\n([\s\S]*?)```/gi;
    let best: string | null = null;
    for (let match = blockPattern.exec(text); match !== null; match = blockPattern.exec(text)) {
        const candidate = match[1]?.trim();
        if (candidate) best = candidate;
    }
    if (best === null) return null;

    let raw: unknown;
    try {
        raw = JSON.parse(best);
    } catch {
        return null;
    }
    const parsed = analysisBlockSchema.safeParse(raw);
    if (!parsed.success) return null;

    const comments = new Map<number, CommentAnalysis>();
    for (const [key, entry] of Object.entries(parsed.data.comments ?? {})) {
        const id = Number(key);
        if (!Number.isInteger(id) || id <= 0 || !entry.summary.trim()) continue;
        comments.set(id, {
            summary: entry.summary.trim(),
            justified: entry.justified ?? null,
            variants: (entry.variants ?? []).map((variant) => variant.trim()).filter(Boolean),
        });
    }

    const files = new Map<string, FileAnalysis>();
    for (const [key, entry] of Object.entries(parsed.data.files ?? {})) {
        if (!key.trim()) continue;
        files.set(key.trim(), { verdict: entry.verdict, notes: (entry.notes ?? '').trim() });
    }

    const overall = parsed.data.overall
        ? { verdict: parsed.data.overall.verdict, notes: (parsed.data.overall.notes ?? '').trim() }
        : null;

    if (comments.size === 0 && files.size === 0 && overall === null) return null;
    return { comments, files, overall };
};
