import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { BitbucketAvatar } from './BitbucketAvatar';

// The avatar answers through three windows — no slug at all, bytes that
// arrive after the mount (the load event), and bytes already in the
// cache, where the img is finished before any listener could exist and
// only its own complete flag tells the truth. All three flip the same
// verdict: initials while loading, the photo once it is real, initials
// again if a different person replaces it before their picture lands.

const flushImgs = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('img'));

describe('BitbucketAvatar', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    const renderAvatar = async (props: Partial<React.ComponentProps<typeof BitbucketAvatar>>) => {
        await act(async () => {
            root.render(<BitbucketAvatar name="Aleksandr Ostaenkov" {...props} />);
        });
    };

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            Event: windowInstance.Event,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => root.unmount());
        windowInstance.close();
    });

    test('without a slug there is no request to make: initials only', async () => {
        await renderAvatar({});
        expect(flushImgs(host)).toHaveLength(0);
        expect(host.textContent).toBe('AO');
    });

    test('a slug mounts the image hidden; the load event trades initials for the photo', async () => {
        await renderAvatar({ slug: 'a.ostaenkov' });
        const img = flushImgs(host)[0];
        expect(img?.getAttribute('src')).toBe('/api/openchamber/bitbucket/pulls/avatar?slug=a.ostaenkov&size=48');
        // Loading: the initials stand in, the bytes stay invisible.
        expect(host.textContent).toBe('AO');
        expect(img?.className).toContain('opacity-0');

        await act(async () => {
            img?.dispatchEvent(new Event('load'));
        });
        expect(host.textContent).toBe('');
        expect(img?.className).not.toContain('opacity-0');
    });

    test('an image that fails falls back to initials and stops asking', async () => {
        await renderAvatar({ slug: 'ghost.user' });
        const img = flushImgs(host)[0];
        await act(async () => {
            img?.dispatchEvent(new Event('error'));
        });
        expect(flushImgs(host)).toHaveLength(0);
        expect(host.textContent).toBe('AO');
    });

    test('a cached image is complete before listeners exist — its own flag, no event', async () => {
        // A warm cache: the img is born finished, no load will ever fire.
        const imageProto = windowInstance.HTMLImageElement.prototype;
        const originalComplete = Object.getOwnPropertyDescriptor(imageProto, 'complete');
        const originalWidth = Object.getOwnPropertyDescriptor(imageProto, 'naturalWidth');
        Object.defineProperty(imageProto, 'complete', { configurable: true, get: () => true });
        Object.defineProperty(imageProto, 'naturalWidth', { configurable: true, get: () => 48 });
        try {
            await renderAvatar({ slug: 'a.ostaenkov' });
        } finally {
            // The prototype outlives every Window in this file: whatever a
            // later test renders must see the honest defaults again.
            if (originalComplete) Object.defineProperty(imageProto, 'complete', originalComplete);
            else Reflect.deleteProperty(imageProto, 'complete');
            if (originalWidth) Object.defineProperty(imageProto, 'naturalWidth', originalWidth);
            else Reflect.deleteProperty(imageProto, 'naturalWidth');
        }
        const img = flushImgs(host)[0];
        expect(img?.className).not.toContain('opacity-0');
        expect(host.textContent).toBe('');
    });

    test('a different person resets the verdict: initials until the new photo lands', async () => {
        await renderAvatar({ slug: 'a.ostaenkov' });
        await act(async () => {
            flushImgs(host)[0]?.dispatchEvent(new Event('load'));
        });
        expect(host.textContent).toBe('');

        await renderAvatar({ slug: 'il.denisov' });
        const secondImg = flushImgs(host)[0];
        expect(secondImg?.getAttribute('src')).toContain('slug=il.denisov');
        // The old photo does not vouch for the new person.
        expect(host.textContent).toBe('AO');
        await act(async () => {
            secondImg?.dispatchEvent(new Event('load'));
        });
        expect(host.textContent).toBe('');
    });
});
