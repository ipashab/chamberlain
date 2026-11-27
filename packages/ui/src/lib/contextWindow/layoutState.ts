import { z } from 'zod';
import { CHAT_NODE } from '@/lib/workspace/layoutTree';
import { CLOSED_ZONE_VIEW } from '@/lib/workspace/zones';
import { sanitizeContextPanelByDirectory } from '@/stores/ui/contextPanelState';
import type { ContextPanelDirectoryState } from '@/stores/ui/types';

export const CONTEXT_WINDOW_STATE_KEY = 'openchamber.context-window.v1';

const MAX_PANELS = 8;

type ContextPanels = Record<string, ContextPanelDirectoryState>;

/**
 * One owner window's panel state, carried whole: the region trees of every
 * directory live in `byDirectory`, so the window shows the same layout the
 * main window showed at the moment of the detach, and the return restores
 * it as the panel window left it.
 */
export type ContextWindowPanelEntry = {
  byDirectory: ContextPanels;
  touchedAt: number;
};

export type ContextWindowRecord = {
  panels: Record<string, ContextWindowPanelEntry>;
};

export const EMPTY_CONTEXT_WINDOW_RECORD: ContextWindowRecord = { panels: {} };

const entriesSchema = z.record(z.string(), z.unknown()).catch({});

export const contextPanelsSchema = z.unknown().transform((value) => sanitizeContextPanelByDirectory(value));

const panelEntrySchema = z.object({
  byDirectory: contextPanelsSchema,
  touchedAt: z.number().finite().catch(0),
});

const panelsSchema = entriesSchema.transform((entries) => {
  const panels: ContextWindowRecord['panels'] = {};
  for (const [ownerId, entry] of Object.entries(entries)) {
    const parsed = panelEntrySchema.safeParse(entry);
    if (parsed.success) panels[ownerId] = parsed.data;
  }
  return panels;
});

export const contextWindowRecordSchema = z.object({
  panels: panelsSchema,
}).catch(EMPTY_CONTEXT_WINDOW_RECORD);

/**
 * The owner's panel read as closed in every surface: the region tree folds
 * back to the chat node (tabs stay in the strip for the day they come back)
 * and the legacy zone views stop claiming a shown surface while the panel
 * lives in its own window. The panel window's record keeps the whole tree.
 */
export const closeEveryRegion = (byDirectory: ContextPanels): ContextPanels => Object.fromEntries(
  Object.entries(byDirectory).map(([directory, panel]) => [directory, {
    ...panel,
    layout: CHAT_NODE,
    isOpen: false,
    expanded: false,
    zones: {
      left: { ...CLOSED_ZONE_VIEW },
      bottom: { ...CLOSED_ZONE_VIEW },
    },
  }]),
);

export const withPanelEntry = (record: ContextWindowRecord, ownerId: string, entry: ContextWindowPanelEntry): ContextWindowRecord => {
  const panels = Object.entries({ ...record.panels, [ownerId]: entry })
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, MAX_PANELS);
  return { ...record, panels: Object.fromEntries(panels) };
};

export const withoutPanelEntry = (record: ContextWindowRecord, ownerId: string): ContextWindowRecord => ({
  ...record,
  panels: Object.fromEntries(Object.entries(record.panels).filter(([id]) => id !== ownerId)),
});

export const latestPanelOwner = (record: ContextWindowRecord, among: ReadonlySet<string>): string | null => (
  Object.entries(record.panels).filter(([ownerId]) => among.has(ownerId)).reduce<[string, number] | null>(
    (latest, [ownerId, entry]) => (!latest || entry.touchedAt > latest[1] ? [ownerId, entry.touchedAt] : latest),
    null,
  )?.[0] ?? null
);
