# Context panel window

## Ownership

This module owns the mode where a main window's context panel lives in a
window of its own: which window is which, what the main window hands the
panel window, and how the panel comes back. The panel window's layout is
`components/layout/ContextWindowLayout.tsx` (picked by `WindowLayout.tsx`);
the region frames and surfaces are the layout module's
(`components/layout/DOCUMENTATION.md`). The desktop shell owns the native
window: `packages/electron/context-window-controller.mjs` and its pure
helpers in `context-window.mjs`.

A panel window is the regular app page opened with `?contextWindow=<owner id>`
(`role.ts`). The owner id is the main window's id, kept in that page's
`sessionStorage`, so a reload keeps it; a duplicated browser tab that copied
it is told `owner-taken` and makes a new one. Desktop opens a `BrowserWindow`
with the owner's runtime; the web opens a same-origin popup with
`window.open`. VS Code and the phone layouts have no entry point.

## Invariants

- One routing rule. While a main window is detached, every store action in
  `ROUTED_CONTEXT_ACTIONS` called there runs in its panel window instead
  (`routing.ts` wraps them when the store is composed). A new action that
  opens something in the context panel, changes what it shows, or decides
  from the panel's state what to do (`toggleContextPanel`) joins that list;
  an entry point that writes or reads panel state any other way talks to the
  main window's hidden copy. A forwarded call returns null, because a tab id
  it would return belongs to the other window.
- The owner queues forwarded actions until its panel window says
  `panel-hello`, and again after `panel-gone` while a panel window reloads,
  so a click during startup or a reload is not lost. A panel window that
  does not say hello within `PANEL_START_MS` (first start) or
  `PANEL_REPLY_MS` (after leaving) gives the panel back: the owner closes
  the popup it holds and runs the queued actions on its own panel.
- Opens the user asked for raise the desktop panel window without taking
  focus from the chat; opens an agent makes in the background
  (`openAgentBrowserTab`, `reveal: false`) and closing calls do not.
- The panel window follows its owner live: project on screen, session or
  draft, and the composer address (`follow` messages). Switching to a draft
  first clears the session through `setCurrentSession(null)`, which retires
  a session admission still in flight. `useEffectiveDirectory` returns the
  followed project in the panel window. Comments made there land under the
  composer address, so in the owner's composer; files for the composer (an
  annotation's screenshot, an image pasted into a comment) go to the owner
  over the channel, because the panel window has no composer.
- Only the region trees are the panel window's own. It persists them in
  `openchamber.context-window.v1` (`storage.ts`) as `contextPanelByDirectory`,
  never in `ui-store`, so a main window cannot write them over, and the
  storage-event follower that keeps surface zone placement in step between
  main windows (`followZonePlacementOfOtherWindows`) does not run in a
  panel window at all. Every other `ui-store` field is
  shared: it is merged into the stored field by field, because a full write
  would put back what another window changed since, and sent to the owner
  (`prefs`), whose next full save would otherwise put the old value back.
  A panel entry is the whole `byDirectory` of one owner and nothing more;
  placement, zone sizes and the fork's work-status widths stay the owner's
  shared fields, so the panel window neither decides the owner's placement
  nor stores sizes for surfaces the owner still shows. Trees enter the record
  through the same sanitizer as `ui-store`, and the return drops comparisons
  of other worktrees (`withoutForeignComparisons`) and clamps roots
  (`clampContextPanelRoots`), so what comes back keeps what a hydrated
  store would keep.
- The panel window has no placement of its own: it shows the region trees the
  detach carried. A surface opened there lands by the same rule as in a main
  window (`openSurfaceInTree`: a leaf that already shows the mode, else the
  first leaf with a tab, else a split of the chat node); a directory that
  was never carried starts from the bare chat node, so its first surface
  splits that node like a fresh project does. Extension surfaces mount when
  the catalog lists them (`useContextWindowPanel`).
- Detaching carries what the main window showed into the panel window — the
  region trees of every directory, whole — and closes the owner's regions:
  `closeEveryRegion` folds each tree back to the chat node with its tabs
  kept for the day they come back. Returning carries what the panel window
  showed back the same way: the owner replaces `contextPanelByDirectory`
  with the entry's trees and drops the entry. Tabs travel per owner
  (`panels[ownerId]`), so two main windows each keep their own panel.
- The main window can raise its panel window (`showContextPanelWindow`:
  the desktop shell focuses it, the web focuses the popup, found again by its
  window name after a reload of the main window) and ask for the panel back
  (`bringContextPanelBack`): it sends `return`, and the panel window answers
  as its own return button does, so the panel comes back with what that
  window showed. A panel window that is not ready, or does not answer within
  `PANEL_REPLY_MS`, is returned from the owner's side and told to close.
- Closing the panel window ends the mode. Desktop reports it through
  `openchamber:context-window-closed`; the web checks the popup it holds
  right after `panel-gone`. The return button sends `panel-returned` first,
  so it is immediate everywhere. A main window that closes takes its panel
  window with it.
- Desktop reopens the panel window after a restart when one was open at
  quit. The shell keeps the owner ids of open panel windows
  (`desktopContextWindow.owners`) and hands them once per app run to the
  first main window, which takes the most recent entry among them, so the
  tabs of a panel closed with its main window never come back.
- A runtime switch in the owner closes the panel window, which talks to the
  old server; the panel comes back to the owner.

## Decisions

### Why the same app page and not a smaller entry

The panel's surfaces need the whole app underneath: sync, runtime APIs,
terminals, browser control, extensions. A page of their own would rebuild
that bootstrap and drift from it. In the panel window, `useRouter` neither
reads nor writes the URL, and the last-session restore does nothing: the
session comes from the owner.

### Why forwarded store actions and not mirrored state

The panel window keeps a normal store and runs the same actions a main
window runs on its own panel, with their side effects (terminal and file
stores). Mirroring the main window's panel state instead would need two-way
merging of tabs, zones and those side stores, and the main window would
still have to own a hidden copy of every surface.

### Why a BroadcastChannel and not the desktop shell

The channel works the same in the desktop app and in a browser, between
same-origin pages. The shell only does what a page cannot: open and raise a
native window without a user gesture (restore), and say when one closed.
