import { describe, expect, test } from 'bun:test';

import { clickedLine, draggedOverLine, emptySpan } from './pullSpan';

describe('clickedLine', () => {
    test('the first click starts a span waiting at that line', () => {
        expect(clickedLine(emptySpan, 3)).toEqual({ picking: 3, span: null });
    });

    test('the second click ends the span, endpoints in order', () => {
        const started = clickedLine(emptySpan, 7);
        expect(clickedLine(started, 4)).toEqual({ picking: null, span: [4, 7] });
        expect(clickedLine(started, 9)).toEqual({ picking: null, span: [7, 9] });
    });

    test('clicking the waited line itself makes a span of one', () => {
        const started = clickedLine(emptySpan, 5);
        expect(clickedLine(started, 5)).toEqual({ picking: null, span: [5, 5] });
    });

    test('a click on a held range drops it and starts fresh there', () => {
        const held = clickedLine(clickedLine(emptySpan, 2), 6);
        expect(clickedLine(held, 10)).toEqual({ picking: 10, span: null });
    });
});

describe('draggedOverLine', () => {
    test('the start row itself changes nothing — the press stays a click', () => {
        expect(draggedOverLine(4, 4)).toBeNull();
    });

    test('crossing a row draws the range from the pressed line, both ways', () => {
        expect(draggedOverLine(2, 6)).toEqual({ picking: null, span: [2, 6] });
        expect(draggedOverLine(6, 2)).toEqual({ picking: null, span: [2, 6] });
    });

    test('every crossing commits live, so the band follows the mouse', () => {
        let state = emptySpan;
        for (const index of [3, 4, 5]) {
            const next = draggedOverLine(2, index);
            expect(next).not.toBeNull();
            state = next ?? state;
        }
        expect(state.span).toEqual([2, 5]);
    });
});
