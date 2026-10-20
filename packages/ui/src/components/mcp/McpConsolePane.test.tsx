import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { McpConsolePane } from '@/components/mcp/McpConsolePane';
import { I18nProvider } from '@/lib/i18n';
import { useMcpConsoleStore } from '@/stores/useMcpConsoleStore';
import { SyncProvider } from '@/sync/sync-context';
import { OpenCode } from '@opencode/client';

// The run frame is where the user reads what a tool does before running it:
// the whole description with its line breaks, not the catalog's truncated
// hover title.

const DESCRIPTION = 'Reads a session message page.\nLine two explains the cursor,\nand a third line warns about limits.';

describe('McpConsolePane run frame', () => {
    let root: Root | null = null;
    let dom: Window;
    let restoreGlobals: () => void;
    const initialState = useMcpConsoleStore.getState();

    const renderPane = async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const mounted = createRoot(host);
        root = mounted;
        const sdk = OpenCode.make({
            baseUrl: 'http://localhost',
            fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
        });
        await act(async () => {
            mounted.render(
                <SyncProvider sdk={sdk} directory="">
                    <I18nProvider>
                        <McpConsolePane visible />
                    </I18nProvider>
                </SyncProvider>,
            );
        });
        return host;
    };

    beforeEach(() => {
        dom = new Window();
        const globals = {
            window: dom,
            document: dom.document,
            Event: dom.Event,
            PointerEvent: dom.PointerEvent,
            KeyboardEvent: dom.KeyboardEvent,
            HTMLElement: dom.HTMLElement,
            Element: dom.Element,
            Node: dom.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = Object.getOwnPropertyDescriptors(globalThis);
        Object.assign(globalThis, globals);
        restoreGlobals = () => {
            for (const key of Object.keys(globals)) {
                const descriptor = descriptors[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        };
    });

    afterEach(() => {
        const mountedRoot = root;
        if (mountedRoot) {
            act(() => {
                mountedRoot.unmount();
            });
        }
        restoreGlobals();
        useMcpConsoleStore.setState(initialState);
    });

    test('carries the whole description at the run form, line breaks included', async () => {
        useMcpConsoleStore.setState({
            frame: 'run',
            server: 'filesystem',
            runReturn: 'tools',
            tool: {
                name: 'message_page',
                description: DESCRIPTION,
                inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
            },
        });
        const host = await renderPane();
        const paragraphs = Array.from(host.querySelectorAll('p'));
        const description = paragraphs.find((node) => node.textContent?.includes('Line two explains the cursor'));
        expect(description).toBeDefined();
        // The full text rides as one paragraph, whitespace preserved.
        expect(description?.getAttribute('class')).toContain('whitespace-pre-wrap');
        expect(description?.textContent).toBe(DESCRIPTION);
        // The catalog's truncation class has no place here.
        expect(description?.getAttribute('class')).not.toContain('truncate');
    });

    test('renders no description block when the tool carries none', async () => {
        useMcpConsoleStore.setState({
            frame: 'run',
            server: 'filesystem',
            runReturn: 'tools',
            tool: { name: 'bare_tool', description: '', inputSchema: null },
        });
        const host = await renderPane();
        const paragraphs = Array.from(host.querySelectorAll('p'));
        expect(paragraphs.some((node) => node.getAttribute('class')?.includes('whitespace-pre-wrap'))).toBe(false);
    });
});
