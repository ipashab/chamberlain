import { z } from 'zod';

// A finalized answer may carry a machine tail: prose for the person, then
// one fenced JSON block — the digest a panel elsewhere in the app reads
// off the raw text. The chat is the person's half, so the tail only ever
// shows as a collapsed line; this module owns the pure split — prose
// before the fence, digest inside it — testable as text in, parts out.

// The digest every flow in this app asks for is one JSON object, never a
// bare array or string — the schema is the boundary that says so.
const digestObjectSchema = z.record(z.string(), z.unknown());

type TrailingJsonDigest = {
    /** The prose the person reads; everything before the fence. */
    prose: string;
    /** The fence's body, the raw JSON as the model wrote it. */
    digest: string;
    /** The digest's line count, the one number the collapsed line shows. */
    lines: number;
};

/**
 * Split a finalized answer into its readable half and a trailing machine
 * digest. Strict, because the wrong split costs real prose: the fence
 * must be the answer's last element and its language `json`, the prose
 * before it must exist (an all-JSON answer is the answer itself, not a
 * tail), and the body must parse as one JSON object — the digest every
 * flow in this app asks for is an object, never a bare array or string.
 */
export const splitTrailingJsonDigest = (text: string): TrailingJsonDigest | null => {
    const fencePattern = /```json\s*\n([\s\S]*?)\n?```\s*$/i;
    const match = text.match(fencePattern);
    if (!match || match.index === undefined) return null;

    const prose = text.slice(0, match.index).trimEnd();
    if (!prose) return null;

    const digest = match[1] ?? '';
    let parsedDigest: unknown;
    try {
        parsedDigest = JSON.parse(digest);
    } catch {
        return null;
    }
    if (!digestObjectSchema.safeParse(parsedDigest).success) return null;

    return { prose, digest, lines: digest.split('\n').length };
};
