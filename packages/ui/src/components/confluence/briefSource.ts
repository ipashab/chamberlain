// The attached brief's source: one fetched page, reshaped into the two
// things an asking message carries — a title to name it by and a material
// to embed. The pin flow's own material builder does the reshaping, so a
// brief and a pinned page are the same words in both places; a page that
// fails to answer says its kind, the same kinds the reader's errors use.

import { fetchConfluencePageView, type PageErrorKind } from '@/lib/confluence/page-api';
import { buildPageViewMaterial } from './pageAsk';

/** What an asking message embeds when a page rides along as the brief. */
export type AttachedBrief = {
    title: string;
    material: string;
};

/**
 * The brief of one page, fetched fresh at the moment the reading starts —
 * a page chosen an hour ago is read now, not remembered then. The failure
 * kinds are the reader's own, so the caller words them with the panel's
 * own error lines instead of inventing new ones.
 */
export const fetchAttachedBrief = async (
    pageId: string,
): Promise<{ ok: true; brief: AttachedBrief } | { ok: false; kind: PageErrorKind }> => {
    const result = await fetchConfluencePageView(pageId);
    if (!result.ok) return { ok: false, kind: result.kind };
    return {
        ok: true,
        brief: { title: result.view.title, material: buildPageViewMaterial(result.view) },
    };
};
