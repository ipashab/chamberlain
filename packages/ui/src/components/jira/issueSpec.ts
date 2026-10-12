// The spec-draft flow's pure half: what the asking message carries, what
// the answering message must look like, and how the answer is read back.
// The button and the card live in the issue body; nothing here touches
// stores, sessions or the DOM, so the whole contract is testable as text
// in, structure out.
//
// The shape of the deal: the panel opens a dedicated session whose first
// message embeds the issue — the same material the ask flow pins — and
// demands a two-part answer — a readable spec for the person first, a
// compact fenced JSON block last. The block is machine food: the card in
// the issue body is built from it, while the person reads the prose. The
// parser is deliberately forgiving about where that block sits in the
// answer and strict about what is inside it — an answer that does not fit
// is no spec at all, and the panel says so rather than guessing.

import { z } from 'zod';

import type { JiraIssueView } from '@/lib/jira/issue-view-api';
import { buildIssueViewMaterial } from './issueViewMaterial';

/** The requirement spec a reading produced: a card, not prose to parse. */
export type IssueSpec = {
    /** What the task is, one-two sentences a stakeholder nods at. */
    essence: string;
    /** The development plan: what to build, down to code where possible. */
    plan: string[];
    /** What "done" means: testable acceptance criteria, each one line. */
    acceptance: string[];
    /** What the material leaves unanswered; a criterion cannot hide here. */
    openQuestions: string[];
    /** What the task must not grow into — the scope's fence. */
    outOfScope: string[];
};

const specBlockSchema = z
    .object({
        essence: z.string(),
        plan: z.array(z.string()).nullish(),
        acceptance: z.array(z.string()).nullish(),
        openQuestions: z.array(z.string()).nullish(),
        outOfScope: z.array(z.string()).nullish(),
    })
    // The model may decorate the block with a key we did not ask for; it
    // must not cost the whole reading. Known keys are still checked.
    .passthrough();

/** The spec session's title, short enough for the session list. */
export const issueSpecSessionTitle = (view: JiraIssueView): string =>
    `Jira ${view.issue.key}: ${view.issue.summary}`.slice(0, 80);

/**
 * The asking message: what to read, what to weigh, what to answer. The
 * instructions are the caller's to pass — the Magic Prompts settings own
 * their default and override — while the material and the answer
 * contract stay the app's: the spec card hangs off the contract, and no
 * methodology text replaces it. The message embeds the whole issue as
 * the ask flow's material — meta, details, description, linked issues,
 * comments — so the spec session needs no Jira access of its own. But
 * the spec is a development one: the session may and should use its own
 * tools (the repository it runs in, available integrations) to name
 * concrete files, modules and endpoints. Where that grounding is
 * impossible, the plan stays faithful to the issue text and the gap
 * lands in the open questions.
 */
export const buildIssueSpecPrompt = (view: JiraIssueView, methodology: string): string => {
    const parts = [
        `Составь техническое задание на разработку по Jira-задаче ${view.issue.key}: ${view.issue.summary}.`,
        'Материал задачи встроен в сообщение: ходить в Jira не нужно — источником постановки служит этот текст.',
        methodology,
        '',
        '## Задача',
        '',
        buildIssueViewMaterial(view),
        '',
        '## Ответ',
        '',
        'Ответ из двух частей. Сначала — полное читаемое ТЗ по-русски, для человека: связный текст обычными абзацами и списками (без всякого JSON). Именно он — главный ответ. В нём раскрывай каждый пункт по существу:',
        '- суть задачи — одной-двумя строками, понятными заказчику;',
        '- план доработок: что и где менять, по возможности с файлами, модулями, функциями или эндпоинтами — и почему именно так;',
        '- критерии приёмки: каждый проверяем сам по себе;',
        '- открытые вопросы и границы задачи — прямо, без домыслов.',
        '',
        'Затем, после ТЗ, последним сообщением — ровно один блок JSON, обёрнутый в тройные кавычки с языком `json`: машинная выжимка того же ТЗ для карточки интерфейса, не для чтения. Значения короткие, без повторения текста разбора, без комментариев внутри. Структура:',
        '',
        '```json',
        '{',
        '  "essence": "суть задачи одной-двумя строками",',
        '  "plan": ["что и где менять: файл/модуль/эндпоинт — насколько код и материал позволяют", "..."],',
        '  "acceptance": ["проверяемый критерий приёмки", "..."],',
        '  "openQuestions": ["что в постановке неясно или не названо", "..."],',
        '  "outOfScope": ["что в эту задачу не входит", "..."]',
        '}',
        '```',
        '',
        'Правила блока:',
        '- Пиши только по материалу; домысел не принадлежит ТЗ. Чего в материале нет — «openQuestions».',
        '- «plan»: 2–8 пунктов, каждый про одно конкретное изменение; где код доступен — с привязкой к файлам и функциям. Пункты без привязки к коду всё равно конкретны по смыслу.',
        '- «acceptance»: 3–8 пунктов, каждый проверяем сам по себе; «сделать хорошо» — не критерий.',
        '- «outOfScope»: пустой список, если границ задачи материал не намечает.',
        '- Никаких ключей сверх перечисленных; ТЗ перед блоком — обычный текст, без JSON.',
    ];
    return parts.join('\n');
};

/**
 * Read the answer back. The newest well-formed fenced JSON block that fits
 * wins (the model may show drafts earlier — a draft that does not fit the
 * contract is skipped, not fatal); nothing that fits the contract means no
 * spec at all, and the panel keeps its "open the session" fallback rather
 * than guessing a spec out of prose.
 */
export type IssueSpecParseResult =
    | { ok: true; spec: IssueSpec }
    | { ok: false; error: 'no-block' | 'bad-shape' };

const parseSpecBlock = (candidate: string): IssueSpec | null => {
    let raw: unknown;
    try {
        raw = JSON.parse(candidate);
    } catch {
        return null;
    }
    const parsed = specBlockSchema.safeParse(raw);
    if (!parsed.success) return null;

    const trimmedList = (items: ReadonlyArray<string> | null | undefined): string[] =>
        (items ?? []).map((item) => item.trim()).filter(Boolean);

    const spec: IssueSpec = {
        essence: parsed.data.essence.trim(),
        plan: trimmedList(parsed.data.plan),
        acceptance: trimmedList(parsed.data.acceptance),
        openQuestions: trimmedList(parsed.data.openQuestions),
        outOfScope: trimmedList(parsed.data.outOfScope),
    };
    // A spec without an essence is a card with a blank face, and a card
    // with nothing to plan, nothing to accept and nothing to ask has
    // nothing to say: both stay drafts, and an older full answer still
    // counts.
    if (!spec.essence) return null;
    if (spec.plan.length === 0 && spec.acceptance.length === 0 && spec.openQuestions.length === 0) return null;
    return spec;
};

export const parseIssueSpecResult = (text: string): IssueSpecParseResult => {
    const blockPattern = /```json\s*\n([\s\S]*?)```/gi;
    const candidates: string[] = [];
    for (const match of text.matchAll(blockPattern)) {
        const candidate = match[1]?.trim();
        if (candidate) candidates.push(candidate);
    }
    if (candidates.length === 0) return { ok: false, error: 'no-block' };
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const spec = parseSpecBlock(candidates[index] ?? '');
        if (spec !== null) return { ok: true, spec };
    }
    return { ok: false, error: 'bad-shape' };
};
