import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import {
  isPluginContextPanelMode,
  type ContextPanelMode,
} from '@/lib/surfaces/modes';

type BuiltInContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'walkthrough'
  | 'terminal'
  | 'debug'
  | 'notes'
  | 'context'
  | 'browser'
  | 'chat'
  | 'team'
  | 'pulls'
  | 'jira'
  | 'confluence'
  | 'review'
  | 'board'
  | 'mcp-console';

export type ContextSurfaceId = BuiltInContextSurfaceId | `plugin:${string}`;

export type ContextSurfaceDescriptor = {
  id: ContextSurfaceId;
  /** The context panel tab mode this surface activates. 1:1 in the current model. */
  mode: ContextPanelMode;
  icon: IconName;
  /** Authenticated package SVG for a guest rail mark. Prefer over `icon` when set. */
  iconSrc?: string;
  /** Guest-provided name. When set, the rail prefers this over `labelKey`. */
  label?: string;
  labelKey: I18nKey;
  /**
   * 'always' surfaces can be opened empty from the rail.
   * 'has-content' surfaces are content-driven: they need an existing tab of
   * their mode (a split session, a diff to show) and stay hidden on the rail
   * until one exists.
   */
  availability: 'always' | 'has-content';
  /** Short tooltip explanation shown on the rail. */
  descriptionKey: I18nKey;
  /**
   * Which of the two default widths the panel opens at until the user resizes
   * this surface. The panel never takes more than the chat area leaves after
   * a minimum chat column, so a small window shows it narrower.
   */
  width: ContextSurfaceWidth;
};

/** Default panel widths in px. Every surface, built-in or guest, uses one. */
export const CONTEXT_SURFACE_WIDTHS = {
  // Code side by side with the chat: files, diffs, the terminal, the walkthrough.
  wide: 640,
  // A list or a card: every other surface, guest panels included.
  regular: 540,
} as const;

type ContextSurfaceWidth = keyof typeof CONTEXT_SURFACE_WIDTHS;

export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    descriptionKey: 'contextRail.surface.context.description',
    width: 'regular',
    mode: 'context',
    icon: 'donut-chart-fill',
    labelKey: 'contextPanel.mode.context',
    availability: 'always',
  },
  {
    id: 'git',
    descriptionKey: 'contextRail.surface.git.description',
    width: 'regular',
    mode: 'git',
    icon: 'git-branch',
    labelKey: 'layout.rightSidebar.git',
    availability: 'always',
  },
  {
    id: 'pr',
    descriptionKey: 'contextRail.surface.pr.description',
    width: 'regular',
    mode: 'pr',
    icon: 'github',
    labelKey: 'contextPanel.mode.pr',
    availability: 'always',
  },
  {
    id: 'diff',
    descriptionKey: 'contextRail.surface.diff.description',
    width: 'wide',
    mode: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'contextPanel.mode.diff',
    availability: 'always',
  },
  {
    id: 'walkthrough',
    descriptionKey: 'contextRail.surface.walkthrough.description',
    width: 'wide',
    mode: 'walkthrough',
    icon: 'route',
    labelKey: 'contextPanel.mode.walkthrough',
    availability: 'always',
  },
  {
    id: 'editor',
    descriptionKey: 'contextRail.surface.editor.description',
    width: 'wide',
    mode: 'file',
    icon: 'file-edit',
    labelKey: 'contextPanel.mode.files',
    availability: 'always',
  },
  {
    id: 'terminal',
    descriptionKey: 'contextRail.surface.terminal.description',
    width: 'wide',
    mode: 'terminal',
    icon: 'terminal-box',
    labelKey: 'layout.mainTab.terminal',
    availability: 'always',
  },
  {
    id: 'debug',
    descriptionKey: 'contextRail.surface.debug.description',
    width: 'wide',
    mode: 'debug',
    icon: 'bug',
    labelKey: 'contextPanel.mode.debug',
    availability: 'always',
  },
  {
    id: 'notes',
    descriptionKey: 'contextRail.surface.notes.description',
    width: 'regular',
    mode: 'notes',
    icon: 'book-marked',
    labelKey: 'contextRail.surface.notes',
    availability: 'always',
  },
  {
    id: 'browser',
    descriptionKey: 'contextRail.surface.browser.description',
    width: 'regular',
    mode: 'browser',
    icon: 'global',
    labelKey: 'contextPanel.mode.browser',
    availability: 'always',
  },
  {
    id: 'chat',
    descriptionKey: 'contextRail.surface.chat.description',
    width: 'regular',
    mode: 'chat',
    icon: 'chat-4',
    labelKey: 'contextPanel.mode.chat',
    availability: 'has-content',
  },
  {
    // The team board needs the session it belongs to, like the chat split
    // needs its session: the rail shows it only while a board tab is open.
    id: 'team',
    descriptionKey: 'contextRail.surface.team.description',
    width: 'wide',
    mode: 'team',
    icon: 'layout-column',
    labelKey: 'contextPanel.mode.team',
    availability: 'has-content',
  },
  {
    // The Bitbucket pull surface is the one read-anywhere surface: no
    // repository or session context, only the configured Data Center
    // connection, so it is reachable empty — its landing state is the
    // address input and the recently read pulls.
    id: 'pulls',
    descriptionKey: 'contextRail.surface.pulls.description',
    width: 'wide',
    mode: 'pulls',
    icon: 'git-pull-request',
    labelKey: 'contextPanel.mode.pulls',
    availability: 'always',
  },
  {
    // The Jira issue surface is the second read-anywhere surface: no
    // repository or session context, only the configured Data Center
    // connection, so it is reachable empty — its landing state is the
    // address input and the recently viewed issues.
    id: 'jira',
    descriptionKey: 'contextRail.surface.jira.description',
    width: 'wide',
    mode: 'jira',
    icon: 'task',
    labelKey: 'contextPanel.mode.jira',
    availability: 'always',
  },
  {
    id: 'confluence',
    descriptionKey: 'contextRail.surface.confluence.description',
    width: 'wide',
    mode: 'confluence',
    icon: 'booklet',
    labelKey: 'contextPanel.mode.confluence',
    availability: 'always',
  },
  {
    id: 'review',
    descriptionKey: 'contextRail.surface.review.description',
    width: 'wide',
    mode: 'review',
    icon: 'list-check-2',
    labelKey: 'contextPanel.mode.review',
    availability: 'always',
  },
  {
    // The issues-and-PRs board as a surface: the same list the sidebar's
    // board page shows, alive as a region the board mode presets and any
    // split can host.
    id: 'board',
    descriptionKey: 'contextRail.surface.board.description',
    width: 'wide',
    mode: 'board',
    icon: 'clipboard',
    labelKey: 'contextPanel.mode.board',
    availability: 'always',
  },
  {
    // The MCP console as a surface: the servers of the scope, one server's
    // tools, the all-tools catalog, and the run form. Entrances — palette
    // commands and the Settings MCP cards — open this same tree tab and
    // place its frames through the console store.
    id: 'mcp-console',
    descriptionKey: 'contextRail.surface.mcp-console.description',
    width: 'regular',
    mode: 'mcp-console',
    icon: 'server',
    labelKey: 'contextPanel.mode.mcp-console',
    availability: 'always',
  },
];

// Tablet width and up: below this the walkthrough cannot show a stop and its
// code side by side, which is the whole point of the surface.
export const WALKTHROUGH_MIN_WIDTH = 768;

const isKnownSurfaceId = (value: string, byId: ReadonlyMap<string, ContextSurfaceDescriptor>): boolean => {
  return byId.has(value);
};

/**
 * Applies a persisted user reorder on top of the default registry order:
 * unknown ids are dropped, missing surfaces are appended in default order.
 */
export const sortContextSurfaces = (
  railOrder: readonly string[],
  extras: readonly ContextSurfaceDescriptor[] = [],
): ContextSurfaceDescriptor[] => {
  const all = extras.length === 0 ? CONTEXT_SURFACES : [...CONTEXT_SURFACES, ...extras];
  const byId = new Map<string, ContextSurfaceDescriptor>(all.map((surface) => [surface.id, surface]));
  const ordered: ContextSurfaceDescriptor[] = [];
  const seen = new Set<string>();

  for (const id of railOrder) {
    if (!isKnownSurfaceId(id, byId) || seen.has(id)) {
      continue;
    }
    const surface = byId.get(id);
    if (surface) {
      seen.add(id);
      ordered.push(surface);
    }
  }

  for (const surface of all) {
    if (!seen.has(surface.id)) {
      ordered.push(surface);
    }
  }

  return ordered;
};

type VisibleRailSurfacesOptions = {
  railOrder: readonly string[];
  /** Surfaces the user chose to hide from the rail (and from the digit
      shortcuts, which share this filter). */
  hiddenSurfaces?: readonly string[];
  isVSCode: boolean;
  screenWidth: number;
  tabs: readonly { mode: ContextPanelMode; targetPath?: string | null }[];
  /** The Tracker rail icon stays off until a GitHub or GitLab account is
      connected (OAuth, a token, or a detected `gh`/`glab` login), or an item
      such as a Linear issue is open in it. Accounts are connected from
      Settings, so hiding the surface removes no entry point. */
  sourceControlConnected: boolean;
  /** Installed guest panels. Empty on VS Code and when the catalog has not
      loaded or failed. */
  extras?: readonly ContextSurfaceDescriptor[];
};

/**
 * The context panel rail's visible, user-ordered surfaces. Shared by the rail
 * (for rendering and number badges) and the global surface-switch shortcut so
 * both agree on which surface each digit maps to.
 *
 * Content-driven surfaces are hidden (not disabled) until content exists; an
 * existing tab keeps them visible even if the content source went away.
 */
export const getVisibleContextRailSurfaces = (options: VisibleRailSurfacesOptions): ContextSurfaceDescriptor[] => {
  return sortContextSurfaces(options.railOrder, options.extras).filter((surface) => {
    if (options.hiddenSurfaces?.includes(surface.id)) {
      return false;
    }
    if (isPluginContextPanelMode(surface.mode) && options.isVSCode) {
      return false;
    }
    // The walkthrough needs room for a stop list beside real code, and its
    // diffs come from OpenChamber's Git routes, which VS Code does not serve.
    if (surface.id === 'walkthrough' && (options.isVSCode || options.screenWidth < WALKTHROUGH_MIN_WIDTH)) {
      return false;
    }
    // VS Code already is an editor with a browser next to it. What OpenChamber
    // could add there is a bare frame: no annotation, no agent control, no
    // remote dev servers — all of which need a Chromium host the extension does
    // not have. Offering the surface anyway would promise the panel people see
    // on the desktop.
    if (surface.id === 'browser' && options.isVSCode) {
      return false;
    }
    if (surface.id === 'pr' && !options.sourceControlConnected
      && !options.tabs.some((tab) => tab.mode === 'pr' && tab.targetPath)) {
      return false;
    }
    if (surface.availability === 'has-content') {
      return options.tabs.some((tab) => tab.mode === surface.mode);
    }
    return true;
  });
};
