/**
 * Regression guard for regional chat panes.
 *
 * Two chat tabs shown by two regions of one workspace layout (a session fork
 * beside its source, a review beside the session it reviews) must each get
 * their own keep-alive pane. The old renderer mounted a single pane bound to
 * the first region-shown chat tab, so the second region stayed blank.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextSurfacePanes.tsx'), 'utf-8');

describe('context panel regional chat panes', () => {
  test('renders one pane per region-shown chat tab, not a single lookup', () => {
    expect(contextPanelSource).toContain('const chatShownTabs = React.useMemo(');
    expect(contextPanelSource).toContain("tabs.filter((tab) => tab.mode === 'chat' && shownInRegion(tab.id))");
    expect(contextPanelSource).not.toContain('const chatActiveTab = React.useMemo(');
  });

  test('renders the shown chat tabs through ChatRegionPane, keyed per tab', () => {
    expect(contextPanelSource).toContain('{chatShownTabs.map((tab) => (');
    expect(contextPanelSource).toContain('<ChatRegionPane');
    expect(contextPanelSource).toContain('key={tab.id}');
  });

  test('pins each pane to its own tab session inside ChatRegionPane', () => {
    expect(contextPanelSource).toContain('const ChatRegionPane: React.FC<{');
    expect(contextPanelSource).toContain('getSessionIDFromDedupeKey(tab.dedupeKey)');
    expect(contextPanelSource).toContain('pinnedSession={pinnedSession}');
  });
});
