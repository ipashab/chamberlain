/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The desktop context zones no longer close on Escape at all;
 * the mobile drawer still does, except from its terminal tab.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileWorkspaceDrawerSource = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
  'utf-8',
);

describe('issue #2644: Escape in terminal must not close the context panel', () => {
  test('the frame and its keep-alive panes each capture Escape', () => {
    expect(contextPanelSource).toContain('onKeyDownCapture={handlePanelKeyDownCapture}');
    expect(contextPanelSource).toContain('closeZoneOnEscape(event, true, handleClose)');
    // The terminal is portalled in from ContextSurfacePanes, so its keys never
    // pass through the frame: its pane wrapper runs the same handler.
    expect(surfacePanesSource).toContain('onKeyDownCapture={handleKeyDownCapture}');
    expect(surfacePanesSource).toContain('closeZoneOnEscape(event, visible, () => {');
  });

  test('the capture handler skips closing when the event target is inside the terminal', () => {
    const start = zoneEscapeSource.indexOf('export const closeZoneOnEscape = (');
    expect(start).toBeGreaterThan(-1);
    const handler = zoneEscapeSource.slice(start);

    expect(handler).toContain("event.key !== 'Escape'");
    expect(handler).toContain('isTerminalEventTarget(event.target)');
    expect(handler).toContain('event.preventDefault()');
    expect(handler).toContain('event.stopPropagation()');
    expect(handler).toContain('close()');

    // Guard must return before preventDefault/stopPropagation so the terminal input's
    // bubble-phase keydown listener can forward Escape to the PTY.
    const guardIndex = handler.indexOf('isTerminalEventTarget(event.target)');
    const preventIndex = handler.indexOf('event.preventDefault()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(preventIndex).toBeGreaterThan(guardIndex);
  });

  test('the Escape handler imports the shared terminal focus helper', () => {
    expect(zoneEscapeSource).toContain("from '@/lib/terminalFocus'");
    expect(zoneEscapeSource).toContain('isTerminalEventTarget');
  });

  test('mobile drawer keeps its terminal Escape exception', () => {
    const handlerStart = mobileWorkspaceDrawerSource.indexOf("if (event.key !== 'Escape'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = mobileWorkspaceDrawerSource.slice(handlerStart, handlerStart + 300);
    // The terminal tab returns before the drawer closes on Escape.
    expect(handler).toContain("tabRef.current === 'terminal') return");
    expect(handler).toContain('onCloseRef.current()');
  });
});
