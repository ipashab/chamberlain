# Workspace modes

## Purpose

`lib/workspace/modePresets.ts` owns the workspace modes: named, per-project
presets that compose the existing region tree (and the surfaces that live in
it) into one working setup. A mode is not a second layout engine — it is one
saved tree per mode, remembered per project the same way `layout` is, plus
first-entry preset trees for modes the project has never visited.

## Model

- `WorkspaceMode` is `'chat' | 'debug' | 'board'`. `'chat'` is the default and
  the layout the app has always had: the chat holds the main area and every
  other surface opens beside it.
- The active mode's tree IS `contextPanelByDirectory[dir].layout` — the
  renderer (`WorkspaceLayout`) reads it and nothing else, so a mode switch is
  an ordinary layout write. The saved trees of the other modes live beside it
  in `modeLayouts`; switching saves the outgoing mode's tree there and loads
  the incoming one (or builds its preset on first entry). Tabs and keep-alive
  panes never die in a switch: leaves that lose their tabs stay empty and
  reopen from the strip, and a chat region keeps the session it was holding.
- Preset trees use stable leaf ids (`DEBUG_EDITOR_LEAF_ID`,
  `DEBUG_PANEL_LEAF_ID`, `BOARD_LIST_LEAF_ID`, `BOARD_DETAIL_LEAF_ID`) so the
  store can place surfaces into named regions after applying a preset, and
  the board mode can route its detail surfaces to `BOARD_DETAIL_LEAF_ID` on
  open instead of letting the general placement rules stack them on the
  board's own leaf.
- Presets claim no tabs of their own, but a mode answers for its named
  regions: every entry opens the preset's surfaces into the named leaves the
  incoming tree left empty — a fresh preset's leaves are empty by
  construction, and a saved tree can leave one empty after its tab was
  closed, here or in another mode. A leaf holding any tab keeps what is in
  it, and a named region closed with its leaf is rebuilt on the next entry,
  split off its sibling named leaf (`restorePresetRegions` in `modePresets`)
  at the preset's share, so a mode without its region is not a state a
  user can get stuck in. A region whose anchor leaf is gone too is left
  alone — nothing of the mode's shape survives there, so the saved tree is
  the user's own arrangement. Placing goes through
  the same `openContextSurfaceInLeaf` path a split header uses, so an
  existing tab returns to its region and an absent surface starts empty; a
  file surface opens with its docked tree visible.

## Modes

- **chat** — today's layout, unchanged. The preset is the chat alone.
- **debug** — editor over debug, chat as the right column:
  `row [ column [ editor, debug ], chat ]` at roughly 75/25 and 58/42. The
  debugger's own reveal (a run started from a chat request) keeps working in
  every mode; in this one the panel is already in place. While this mode is
  active, `file` and `diff` tabs open into the editor leaf (see
  `DEBUG_EDITOR_MODES` in `modePresets` and `upsertContextPanelTab` in
  `useUIStore`), so picking a file keeps the arrangement — files above the
  debug panel — instead of moving the tab into the debugger's leaf and
  leaving the editor region empty.
- **board** — the board as the main region with the Tracker's item cards
  beside it and the chat as the right column:
  `row [ row [ board, detail ], chat ]`. The board lists this fork's own
  sources — the Bitbucket Data Center pulls and the Jira issues — as two
  tabs, each a whole surface in place (the context rail's own Bitbucket and
  Jira panels, hosted here). While this mode is active, `pr`, `diff` and
  `walkthrough` tabs open into the detail leaf (see `upsertContextPanelTab`
  in `useUIStore`), so an item clicked anywhere shows its card next to the
  board instead of covering it.

## Adding a mode

1. Add the value to `WORKSPACE_MODES` and a preset builder here, with stable
   leaf ids and a `WorkspaceModePreset` describing what opens into them.
2. Extend `switchWorkspaceMode` in `useUIStore` with the mode's
   surface-opening pass, and any placement rule the mode needs.
3. Give the mode a header slot in `WorkspaceModeSwitcher` (an icon, an
   accessible label, a tooltip) and a `switch_workspace_<mode>` shortcut in
   `lib/shortcuts/config.ts`.
4. Strings live in `lib/i18n/messages/workspace-modes.i18n.ts`, every locale
   in the same change.

The mode offer (`offerWorkspaceMode`) and its card
(`WorkspaceModeOffer`) are the only sanctioned auto-surface: a run or a link
may *suggest* a mode, never take the screen without the click that accepts.

# Workspace zone state

Upstream's zone model, from before this fork replaced the zone layout with
the region tree. What survives of it here is `zones.ts`: the `ContextZone`
vocabulary, the placement record, and the size and view helpers that the
store's legacy (zone-shaped) panel entries and the work-status sizing still
read. Dragging, fitting and the drag-target geometry upstream documented
under this heading moved to the region world instead
(`regionDropTargets`, `regionDropGesture`, `layoutTree`), and their upstream
v2.7.3 counterparts (`zoneDropTargets`, `zoneFit`, `zoneDrag`, `zoneFitWatch`)
do not exist in this fork.

## Ownership

This module owns pure zone placement, sizing decisions and drag-target geometry. The surface registry and mounted layout own availability and rendering; their contract is in `../surfaces/DOCUMENTATION.md`. In this fork, that ownership narrows to what `zones.ts` still holds; the layout itself is the region tree (`layoutTree.ts`).

## Invariants

- Right is the unstored placement default and retains the legacy top-level view fields. Left and bottom use nested views; every resolved tab must still exist and belong to that zone (`resolveZoneActiveTab` answers only with a tab the placement puts there).
- Upstream's drag-target and fit invariants (targets measured once per drag and never overlapping; moving the visible surface opens its destination and closes its source; a side zone preserving the chat minimum by folding the session sidebar before closing the opposite zone) applied to the zone drag this fork removed. The region tree keeps their intent — conflict-free drops, a move that lands the tab it was given, a chat that never disappears, sizes that belong to surfaces — through `regionDropTargets` and the store's layout actions.
