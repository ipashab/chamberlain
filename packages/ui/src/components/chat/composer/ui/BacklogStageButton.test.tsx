import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';

import { BacklogStageButton } from './BacklogStageButton';

// Renders the stage button and clicks it under a given disabled state.
const renderStageButton = async (disabled: boolean) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let stages = 0;
    try {
        await act(async () => root.render(
            <ThemeSystemProvider>
            <I18nProvider>
                <BacklogStageButton
                    footerIconButtonClass="icon-button"
                    iconSizeClass="icon-size"
                    disabled={disabled}
                    onStage={() => { stages += 1; }}
                />
            </I18nProvider>
            </ThemeSystemProvider>));
        const button = container.querySelector<HTMLButtonElement>('button');
        const markup = button?.outerHTML ?? '';
        await act(async () => { button?.click(); });
        return { markup, stages };
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('BacklogStageButton', () => {
    test('stages on click and names the action for the reader', async () => {
        const { markup, stages } = await renderStageButton(false);

        expect(markup).not.toContain('disabled');
        expect(markup).toContain('aria-label="Add to the queue"');
        expect(stages).toBe(1);
    });

    test('takes no action while the draft is empty', async () => {
        const { markup, stages } = await renderStageButton(true);

        expect(markup).toContain('disabled');
        expect(markup).toContain('opacity-30');
        expect(stages).toBe(0);
    });
});
