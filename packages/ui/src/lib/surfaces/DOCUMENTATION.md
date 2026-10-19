# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered in the regions
of the workspace layout by `components/layout/ContextPanel.tsx` (one per
layout leaf) and `components/layout/ContextSurfacePanes.tsx`.

## Model

Full-screen extension pages are separate from this rail registry. `contributes.page` appears in one sidebar-header menu and uses `useUIStore.openGuestPageId`, the same mutually exclusive main-page lifecycle as Archive and Scheduled tasks. It mounts `PluginPane` with `surface="page"`, closes on runtime switch/uninstall/disable, and is not persisted. `openContextSurface` and the guest's `openSurface` cannot open a full-screen page. Work Status sections (`contributes.statusSection`) are not rail surfaces either: they mount `PluginPane` with `surface="status"` inside the chat's Work Status panel and never open a tab. The entry-point restrictions below describe context-rail surfaces only.

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
  Built-in modes stay a closed list. Installed guests add `plugin:${id}`
  surfaces through `extras` on `sortContextSurfaces` /
  `getVisibleContextRailSurfaces`. Do not copy guest types out of
  `@openchamber/sdk`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces (chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- `width` picks one of two default panel widths, used until the user resizes
  that surface (`CONTEXT_SURFACE_WIDTHS`): `wide`, 640 px, for code beside the
  chat (files, diff, terminal, walkthrough), and `regular`, 540 px, for every
  other surface, guest panels included. Do not add a third size or a
  per-surface number. A resize is remembered in px per mode in
  `useUIStore.contextPanelByDirectory[dir].widthByMode` and restored on reload.
  The width does not follow the chat area: a sidebar toggle or a window resize
  leaves it alone, and it only narrows when it would leave the chat less than
  its minimum column. `ContextPanel` keeps the chat area's width as state only
  while it decides something (expanded, or that ceiling binds), and applies a
  change that arrives during a side-column animation once it ends. Older
  builds also stored `widthFractionByMode`; hydration ignores it and keeps the
  pixel width the same resize stored.
  The file surface stores its full editor width under `file`. Without an
  editor, the panel uses `contextEditorTreeWidth`, the same pixel width as the
  docked file tree. Resizing the tree-only panel updates that shared tree width
  without changing the full editor width. Old `file-tree` width entries are
  discarded on hydration. Tree-only mode temporarily suspends panel expansion;
  reopening the editor restores its previous expanded state. The tree docks
  to the side `fileTreeSide` names (right by default, Settings › General ›
  Navigation) and stays aligned there at its saved width during the panel's
  collapse transition. The header's two layout icons keep their places and
  toggle whichever column stands on their side.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
  `ContextRailSurfacesDialog` edits this same order with drag handles beside
  the visibility checkboxes (`SettingsSortableVisibilityList`, which the phone's
  workspace tab settings also use; those tabs keep their own per-device order
  and hidden set, `lib/mobileWorkspaceTabs.ts`), including hidden panels. Mouse, touch and keyboard
  drops update the rail immediately; visibility changes and "Show all" preserve
  the order. Dialog reorders retain saved ids of unavailable extensions at the
  end of the preference. Escape cancels a drag before closing the dialog.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts`): it drops surfaces the user hid
  (`useUIStore.contextRailHiddenSurfaces`, edited from the rail's trailing
  configure button — `ContextRailSurfacesDialog`),
  drops the walkthrough on VS Code and below `WALKTHROUGH_MIN_WIDTH`, hides the Tracker
  unless a GitHub or GitLab account is connected (signed in from Settings →
  Integrations) or an item is open in it, and hides `has-content` surfaces
  until a tab of their mode exists. Both consumers use it so the digit shown
  on a rail badge always maps to the same surface the shortcut opens.

## Workspace regions

Surfaces open in regions of a recursive layout tree
(`lib/workspace/layoutTree.ts`): `chat` (exactly one — the chat is a region
like any other), `leaf` (a region frame holding tab ids from the shared
strip), and `split` (`row` or `column`, fractions summing to 1). Splits nest
without limit; a leaf splits again from its header, and closing a leaf
collapses its divider, leaving its tabs in the strip.

- The tree is per directory, in `contextPanelByDirectory[..].layout`; the
  renderer (`components/layout/WorkspaceLayout.tsx`) reads it and nothing
  else. `lib/workspace/zones.ts` survives only behind the persist boundary:
  `contextSurfaceZones` and the per-zone mirror still hydrate from state
  saved before the tree, which is built from them by placement
  (`treeFromZonedPanel`) on rehydration.
- Opening a surface (`openSurfaceInTree`'s rule) reveals it where its mode
  already shows, else in the first filled leaf, else in the first empty one,
  else it splits the chat 70/30 as the old right panel did. Clicking the
  rail icon of a surface a region shows closes that region
  (`closeLeaf`), tabs alive; everything is idempotent. A background open
  (`reveal: false`) places nothing: the tab joins the strip only.
- Keep-alive surfaces mount once in `ContextSurfacePanes` and are portalled
  into the body of the leaf holding their tab (`MovablePane` keyed by leaf
  id through `components/layout/regionHosts.ts`), so a move between regions
  keeps the editor's unsaved text and undo, the terminal session and the
  walkthrough's place. A tab with no leaf keeps its pane mounted off-document
  and intact until an open places it again. An Electron webview reloads
  whenever its element moves, so a browser tab reloads when its tab moves
  regions; nothing else moves it.
- The debug surface is the one surface a running program can ask for: a run
  that starts outside the panel (a chat request through the debugger API)
  splits a column under the region of the most recently touched placed tab —
  typically the run's file — and opens the debug tab into the new region
  (`lib/debugger/useDebuggerSurfaceReveal.ts`, mounted in
  `ContextSurfacePanes`). With nothing to sit beside, it opens by the rule
  above like the rail's click.
- Region sizes come from the enclosing split's fractions; dragging a divider
  rebalances the pair (`balanceLayoutSplit`). Pixels floors keep a region
  on screen while a drag passes through.
- The inline work-status card keeps the row's end edge whenever no region
  shows tabs there (`edgeRegionShowsTabs`); a narrow chat still folds the
  card by row width, as before.

## Adding a surface

1. Built-in: add a `ContextPanelMode` value in `packages/ui/src/lib/surfaces/modes.ts`
   (the sanitizer uses `isContextPanelMode`). Register a descriptor here.
   Render the mode in `ContextPanel.tsx`. Add label/hint i18n keys.
2. Guest panel: ship a package with `openchamber.contributes.panel`. The host
  lists it from `GET /api/guests` and renders `PluginPane`. Settings →
  Extensions installs a folder path on that OpenChamber instance. A runtime
  switch clears the catalog so a previous instance cannot leave a rail slot
  from the last host. The rail paints `panel.icon` as a Remixicon glyph.
  `contributes.attach: true` or `"panel"` puts a row on
   the desktop/web chat + menu that opens `plugin:${id}`. `"dialog"` opens a
   host window around the same iframe so the guest can pick an item and call
   `attach`. New Worktree also opens that window for dialog guests. The guest
   still owns the list and HTTP. VS Code and mobile omit the row. Do not add
   a built-in mode for that guest.

## Tracker

The `pr` surface is the Tracker. Its strip lists instances like files and
chats do. The first tab is always the checked-out branch's: its pull or merge
request, or the form that creates one (`views/PullRequestView.tsx`). It sorts
first, has no close button, and `closeContextPanelTabs` and the per-surface
tab budget never remove it. Every other tab is one issue, pull or merge
request or Linear issue (`views/TrackerItemView.tsx`), opened by
`useUIStore.openTrackerItem` with the item's link as `targetPath`, a dedupe key
naming the item whatever page of it the link opens, and the project it is read
through as `targetDirectory` (none when that is the panel's own project).
`components/sourceBoard/openTrackerItem.ts` decides that project from the
session the link belongs to, so opening an item never moves the app to
another project.
A project that is a folder of repositories, with no repository at its root,
reads the item through the repository under it whose remote is the link's,
origin first, then any other remote such as a fork's upstream
(`useLinkRepository` in `sourceBoard/boardRepository.ts`). The Git selection is
not touched, and a link no repository there points into answers as one the
project cannot read.

The item tab reads and acts on the item the way the board's preview does,
with no new-session or worktree actions; attaching it to the session on screen
stays. A link its project cannot read, the host not knowing it or no account
reading it, opens in the browser and its tab closes, but only for the click
that just opened the tab and before it ever showed the item
(`wasTrackerItemRequested`). A tab restored on launch, or one that showed its
item before, says it cannot read it with a button to the browser, and a
failed read shows Retry. Linear answers a missing issue and a failed read the
same way, so a Linear tab falls back only on that first read.

Changes and the walkthrough opened from another project's PR keep that
project's folder as their tab's `targetDirectory`, so they read the PR through
that project's binding beside the chat on screen. Changes then shows that PR
only: no scope switch, no last-turn or review actions, no opening files in the
editor, since none of those belong to the session on screen. Opening either
surface from the rail, or Changes from anywhere that names no folder, returns
it to the panel's own project. Such a tab is saved as the panel's own: the PR
it was asked to show is held in memory only (`usePullRequestSelectionStore`),
so after a restart it would show whatever that project has checked out.

The rail icon is the project's host: GitHub, GitLab, or `ticket-2` for a
project with neither.

## Panel header

The panel has one header row. A single-instance surface with its own toolbar
(terminal, diff, walkthrough, git's branch and sync controls, the notes
search, the context surface's session title) renders that toolbar through
`ContextPanelHeaderToolbar` (`components/layout/contextPanelHeaderSlot.tsx`)
instead of stacking a second row under the header: the toolbar replaces the
mode label and sits beside the fullscreen and close buttons. ContextPanel
provides the header element only to the surface on screen, so inactive tabs
and hosts outside the panel (the mobile workspace drawer) get no slot and
render the toolbar inline as before. A surface nested inside another one that
owns the header (the plan opened from the notes panel) is given a null slot. The label comes
back whenever no toolbar is mounted, so empty and loading states stay named.
Git moves only its first row: identity, pull request and upstream state stay
in the body below.

No new header buttons: the rail, `openContextSurface`, the composer +
menu (`contributes.attach`), and New Worktree's guest icons are the entry
points for opening surfaces or the attach window directly; deep links from
chat/palette go through the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, an in-content link, a composer + menu row from
  `contributes.attach`, or New Worktree's guest icons for dialog attach.
- Multi-instance and session-holding surfaces (file/editor, diff, browser,
  terminal) are keep-alive panes in `ContextSurfacePanes.tsx`. Switching these
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Chat tab records stay open, but only the active chat tab's
  pinned chat column is mounted while the panel is open. A selected chat
  restores its state from the session stores. A closed panel mounts no chat.
  Surfaces rendered by the zone (git, the Tracker, notes, context) remount on
  every switch, the Tracker on every switch between its tabs too. These
  surfaces must restore their state from stores or snapshots.
- Portalled menus and dialogs handle their own Escape key. The panel's capture
  handler ignores their events so dismissing an overlay does not close the panel.
  Escape closes the region it was pressed in: the frame and each keep-alive pane
  run the same handler (`zoneEscape.ts`), since a pane's React events do not
  pass through its frame.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
  The `board` surface is the fork's own board (`components/sourceBoard`):
  two tabs — the Bitbucket Data Center pulls and the Jira issues — each
  mounting the context rail's own panel in place, mounted as a keep-alive
  region pane (the board mode's main region, and any split beside the
  chat).
  The `mcp-console` surface is the fork's own MCP console
  (`components/mcp/McpConsolePane.tsx`): one keep-alive pane, always
  openable from the rail, whose frames — servers, one server's tools, the
  all-tools catalog, one tool's run — live in `useMcpConsoleStore`. The
  palette's console and catalog commands and the Settings → MCP cards open
  this surface (`openContextSurface`) and deep-link its frames through the
  same store; the pane stays keep-alive so a switch keeps the run form's
  answer.

## Workspace modes

The rail stays available in every mode; workspace modes
(`lib/workspace/modePresets.ts`) are named layout presets over the same
region tree, not separate registries. The `board` surface exists for them: it
is `'always'`-openable like git or notes, keep-alive in
`ContextSurfacePanes.tsx` (mount `SourceBoardPane`, refresh gated on the
region showing it), and shares its tab list with the full-page board — the
page (`isSourceBoardOpen`) and the pane are two hosts of one surface, never
both on screen: switching a mode closes the full pages. While the board mode
is active, `pr`, `diff` and `walkthrough` tabs open into the preset's
`leaf-mode-board-detail` region instead of stacking on the board's own leaf;
the general placement rules apply in every other mode.

