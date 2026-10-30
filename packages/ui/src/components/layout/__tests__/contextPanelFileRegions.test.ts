/**
 * Regression guard for regional file editor panes.
 *
 * Two file tabs shown by two regions of one workspace layout must each get
 * their own editor pane, pinned to its tab's file. The old renderer mounted a
 * single editor bound to the first region-shown file tab, so the second
 * region stayed blank: one shared editor cannot show two files at once.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextSurfacePanes.tsx'), 'utf-8');
const filesViewSource = readFileSync(join(__dirname, '..', '..', 'views', 'FilesView.tsx'), 'utf-8');

describe('context panel regional file panes', () => {
  test('renders one pane per file tab, keyed per tab', () => {
    expect(contextPanelSource).toContain('const fileTabs = React.useMemo(');
    expect(contextPanelSource).toContain("tabs.filter((tab) => tab.mode === 'file')");
    expect(contextPanelSource).toContain('{fileTabs.map((tab) => (');
    expect(contextPanelSource).toContain('<FileRegionPane');
    expect(contextPanelSource).toContain('key={tab.id}');
    expect(contextPanelSource).not.toContain('hasFileTabs');
    expect(contextPanelSource).not.toContain('isFileTabActive');
  });

  test('mounts panes through FileRegionPane, hidden and parked when no region shows the tab', () => {
    expect(contextPanelSource).toContain('const FileRegionPane: React.FC<{');
    expect(contextPanelSource).toContain('hostKey={shown ? hostKey : null}');
    expect(contextPanelSource).toContain('visible={shown}');
    expect(contextPanelSource).toContain("shown ? 'flex' : 'hidden'");
  });

  test('pins each editor to its own tab file, so two regions show two files', () => {
    expect(contextPanelSource).toContain('const filePath = tab.targetPath ?? null;');
    expect(contextPanelSource).toContain('pinnedPath={filePath}');
    expect(filesViewSource).toContain('pinnedPath?: string | null;');
    expect(filesViewSource).toContain('return openPaths.find((path) => toComparablePath(path) === comparablePinned) ?? pinnedPath;');
  });

  test('a pinned editor does not heal the shared per-root selection', () => {
    // Without the pin guard, the heal effect would drag the shared selection
    // back to the pinned pane's file and fight the other regions' reveals.
    expect(filesViewSource).toContain('if (pinnedPath) return;');
  });

  test('a pinned editor ignores jumps into other files', () => {
    // Every file tab mounts a pane, parked ones included; without the gate a
    // hidden pane consumed the global pendingFileNavigation, selected its
    // own file, and a dirty one threw its unsaved prompt over the screen.
    expect(filesViewSource).toContain('if (pinnedPath && normalizePath(pinnedPath) !== targetPath)');
  });
});
