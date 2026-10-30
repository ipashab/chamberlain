/**
 * Regression guard for the four layout drag gestures.
 *
 * Everything dragged onto the workspace layout — a region's tab, a sidebar
 * session row, a whole region by its header, a header session tab — lands
 * through one shared gesture (`regionDropGesture`): one target model
 * (`lib/workspace/regionDropTargets`), one drop application, one overlay the
 * MainLayout mounts over the regions.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readInLayout = (name: string) => readFileSync(join(__dirname, '..', name), 'utf-8');

const contextPanelSource = readInLayout('ContextPanel.tsx');
const sessionTabsStripSource = readInLayout('SessionTabsStrip.tsx');
const mainLayoutSource = readInLayout('MainLayout.tsx');
const sidebarDndSource = readFileSync(join(__dirname, '..', '..', 'session', 'sidebar', 'folders', 'sessionFolderDnd.tsx'), 'utf-8');

describe('layout drag gestures wiring', () => {
  test('a region tab dragged out of its strip tracks the shared region gesture', () => {
    expect(contextPanelSource).toContain('onTabDragOut={handleTabDragOut}');
    expect(contextPanelSource).toContain("trackRegionDrop({ kind: 'tab'");
  });

  test('a region is draggable by its header through the shared gesture', () => {
    expect(contextPanelSource).toContain('runRegionHeaderDrop(');
    expect(contextPanelSource).toContain("kind: 'region'");
    expect(contextPanelSource).toContain('HEADER_DRAG_EXCLUDED');
  });

  test('a header session tab dragged out of the strip opens on the layout', () => {
    expect(sessionTabsStripSource).toContain('trackRegionDrop({');
    expect(sessionTabsStripSource).toContain('onDragStart={handleDragStart}');
    expect(sessionTabsStripSource).toContain('onDragCancel={handleDragCancel}');
  });

  test('a sidebar session row lands on the layout through the shared gesture', () => {
    expect(sidebarDndSource).toContain('resolveRegionDropTarget');
    expect(sidebarDndSource).toContain('applyRegionDrop(');
    expect(sidebarDndSource).toContain('trackRegionDrop({');
    expect(sidebarDndSource).toContain("kind: 'session'");
  });

  test('the drop targets draw over the workspace through the MainLayout mount', () => {
    expect(mainLayoutSource).toContain('import { RegionDropOverlay }');
    expect(mainLayoutSource).toContain('<RegionDropOverlay />');
  });
});
