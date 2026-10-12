// The picking half of the line-ask flow, as pure state moves: a row knows
// only its index, and every gesture — a click, a drag crossing into a
// neighbouring row — is one transition over the same small state. The
// diff renderer owns the DOM and the pointers; nothing in here touches
// stores, sessions or the DOM, so both gestures are testable as data in,
// data out.

/** The span the reader is building; endpoints are row indices, inclusive. */
export type SpanState = {
    /** The line a started span waits at; null is no span being picked. */
    picking: number | null;
    /** The held range awaiting its mark; null is none. */
    span: [number, number] | null;
};

export const emptySpan: SpanState = { picking: null, span: null };

/**
 * Where a click on a line takes the picker. A held range answers a fresh
 * click with a fresh start; the first click on a line starts the span;
 * the second ends it — the same line makes a span of one.
 */
export const clickedLine = (state: SpanState, index: number): SpanState => {
    if (state.span !== null) return { picking: index, span: null };
    if (state.picking === null) return { picking: index, span: null };
    return {
        picking: null,
        span: [Math.min(state.picking, index), Math.max(state.picking, index)],
    };
};

/**
 * Where a drag crossing into another line takes the picker: the range
 * from the pressed line to the hovered one, committed live so the band
 * follows the mouse. Null says nothing changes — the pointer is still
 * over the line it went down on, and a press that never crossed a row
 * stays a plain click for `clickedLine` to handle.
 */
export const draggedOverLine = (start: number, index: number): SpanState | null => {
    if (index === start) return null;
    return {
        picking: null,
        span: [Math.min(start, index), Math.max(start, index)],
    };
};
