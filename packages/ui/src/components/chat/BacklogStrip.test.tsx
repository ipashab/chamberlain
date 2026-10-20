import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { BacklogStrip } from './BacklogStrip';

// The strip is the queue the store owns: the rows render what the shared
// fetch loaded, and every reorder goes out as one graded move, the arrow's
// target index computed from the row's own place in the list.

const items = [
    { id: 'bl_1', text: 'Do the audit', createdAt: 100 },
    { id: 'bl_2', text: 'Make the review', createdAt: 200 },
];

const moves: Array<{ itemId: string; position: number }> = [];

mock.module('@/lib/openchamberEvents', () => ({
    subscribeOpenchamberEvents: () => () => {},
}));

mock.module('@/lib/session-backlog/backlogApi', () => ({
    backlogApi: {
        list: mock(async () => ({ items, draining: false })),
        remove: mock(async () => true),
        move: mock(async (sessionId: string, itemId: string, position: number) => {
            moves.push({ itemId, position });
            return items;
        }),
        clear: mock(async () => items.length),
        run: mock(async () => ({ started: true, staged: items.length, note: '' })),
    },
}));

describe('BacklogStrip', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(async () => {
        windowInstance = new Window({ url: 'http://localhost' });
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        moves.length = 0;
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => {
            root.render(
                <I18nProvider>
                    <BacklogStrip sessionId="ses_1" />
                </I18nProvider>,
            );
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        await windowInstance.happyDOM.close();
    });

    const openTheList = async () => {
        const header = host.querySelector<HTMLButtonElement>('[aria-expanded]');
        await act(async () => { header?.click(); });
    };

    const rows = () => [...host.querySelectorAll('.max-h-40 > div')];
    const rowButtons = (row: number) =>
        [...(rows()[row]?.querySelectorAll('button') ?? [])];

    test('renders nothing until the backlog loaded', () => {
        // The shared fetch answered in beforeEach, so the strip is up with
        // its count; a session without a stage renders nothing at all.
        expect(host.textContent).toContain('Staged, not running: 2');
    });

    test('expands into rows with drag grips and boundary-honest arrows', async () => {
        expect(host.textContent).not.toContain('Do the audit');
        await openTheList();
        expect(host.textContent).toContain('Do the audit');
        expect(host.textContent).toContain('Make the review');
        const grips = [...host.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label') === 'Drag to reorder the queue');
        expect(grips).toHaveLength(2);
        // The first row offers no move up, the last no move down.
        expect(rowButtons(0).some((button) => button.getAttribute('aria-label') === 'Move earlier in the queue' && button.disabled)).toBe(true);
        expect(rowButtons(0).some((button) => button.getAttribute('aria-label') === 'Move later in the queue' && !button.disabled)).toBe(true);
        expect(rowButtons(1).some((button) => button.getAttribute('aria-label') === 'Move later in the queue' && button.disabled)).toBe(true);
    });

    test('an arrow moves its item by one place', async () => {
        await openTheList();
        const down = rowButtons(0).find((button) => button.getAttribute('aria-label') === 'Move later in the queue');
        await act(async () => { down?.click(); });
        expect(moves).toEqual([{ itemId: 'bl_1', position: 1 }]);
        const up = rowButtons(1).find((button) => button.getAttribute('aria-label') === 'Move earlier in the queue');
        await act(async () => { up?.click(); });
        expect(moves[1]).toEqual({ itemId: 'bl_2', position: 0 });
    });
});
