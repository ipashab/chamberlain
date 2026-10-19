import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import { mcpConsoleApi, type McpConsoleServer, type McpConsoleTool, type McpConsoleToolArgs, type McpConsoleToolCall } from '@/lib/mcp-console/mcp-console-api';

/**
 * The MCP console panel's state: which of its frames is on, the directory
 * the console asks about, and the data each frame renders. One store because
 * the entrances — the command palette and the MCP settings cards — deep-link
 * into the frames of the same rail surface, and the pane's fetches live here
 * so a reopen in another frame starts from settled state, keeping the frames
 * in sync. Entrances open the surface through `openContextSurface` and then
 * place the frame here; the store takes no layout side. While a stored
 * directory pins the scope, `null` means the app's current project directory
 * at request time.
 */

type McpConsoleFrame = 'servers' | 'tools' | 'run' | 'catalog';

/** One server's row in the catalog frame; null tools means still reading. */
type McpConsoleCatalogEntry = {
  name: string;
  type: McpConsoleServer['type'];
  tools: McpConsoleTool[] | null;
  error: string | null;
};

type McpConsoleState = {
  frame: McpConsoleFrame;
  /** Directory the console runs against; null means the current project. */
  directory: string | null;
  /** Use the current project directory at each request instead of a stored one. */
  directoryIsCurrent: boolean;
  server: string | null;
  tool: McpConsoleTool | null;
  /** Which frame the run frame's back button returns to. */
  runReturn: 'tools' | 'catalog';

  tools: McpConsoleTool[];
  toolsLoading: boolean;
  toolsError: string | null;

  catalogLoading: boolean;
  catalogError: string | null;
  catalogEntries: McpConsoleCatalogEntry[];

  isCalling: boolean;
  lastCall: McpConsoleToolCall | null;
  callError: string | null;

  open: (options?: { server?: string; directory?: string | null }) => void;
  openCatalog: (options?: { directory?: string | null }) => void;
  selectServer: (server: string) => void;
  selectTool: (tool: McpConsoleTool) => void;
  selectCatalogTool: (server: string, tool: McpConsoleTool) => void;
  goBack: () => void;
};

// Reset slices, typed by the slice they reset so the literals carry no casts.
const emptyListing: Pick<McpConsoleState, 'tools' | 'toolsLoading' | 'toolsError'> = { tools: [], toolsLoading: false, toolsError: null };
const emptyCall: Pick<McpConsoleState, 'isCalling' | 'lastCall' | 'callError'> = { isCalling: false, lastCall: null, callError: null };
const emptyCatalog: Pick<McpConsoleState, 'catalogLoading' | 'catalogError' | 'catalogEntries'> = { catalogLoading: false, catalogError: null, catalogEntries: [] };

// A catalog walk runs once per opening; a newer opening or a re-walk drops
// older answers instead of painting them over the fresher list.
let catalogRequest = 0;

export const useMcpConsoleStore = create<McpConsoleState>()(devtools((set, get) => ({
  frame: 'servers',
  directory: null,
  directoryIsCurrent: true,
  server: null,
  tool: null,
  runReturn: 'tools',
  ...emptyListing,
  ...emptyCatalog,
  ...emptyCall,

  open: (options) => {
    const serverName = options?.server?.trim() ?? '';
    const hasDirectory = options != null && 'directory' in options && options.directory !== undefined;
    catalogRequest += 1;
    set({
      frame: serverName !== '' ? 'tools' : 'servers',
      server: serverName !== '' ? serverName : null,
      tool: null,
      runReturn: 'tools',
      directory: hasDirectory ? (options?.directory ?? null) : null,
      directoryIsCurrent: !hasDirectory,
      ...emptyListing,
      ...emptyCatalog,
      ...emptyCall,
    });
    if (serverName !== '') void get().selectServer(serverName);
  },

  // The catalog frame reads the server list, then every server's tools in
  // parallel; each answer patches its own row, so the page fills in as the
  // servers answer and one dead server only marks its own row.
  openCatalog: (options) => {
    const hasDirectory = options && 'directory' in options && options.directory !== undefined;
    const directory = hasDirectory ? options?.directory ?? null : null;
    const requestId = catalogRequest += 1;
    set({
      frame: 'catalog',
      server: null,
      tool: null,
      directory,
      directoryIsCurrent: !hasDirectory,
      ...emptyListing,
      ...emptyCall,
      catalogLoading: true,
      catalogError: null,
      catalogEntries: [],
    });
    const scopeDirectory = directory;
    mcpConsoleApi.servers(scopeDirectory)
      .then((servers) => {
        if (catalogRequest !== requestId) return;
        set({
          catalogEntries: servers.map((server) => ({ name: server.name, type: server.type, tools: null, error: null })),
        });
        void Promise.allSettled(servers.map((server) => mcpConsoleApi.tools(server.name, scopeDirectory)))
          .then((settled) => {
            if (catalogRequest !== requestId) return;
            settled.forEach((outcome, index) => {
              const entry = outcome.status === 'fulfilled'
                ? { tools: outcome.value, error: null }
                : { tools: null, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) };
              set((state) => ({
                catalogEntries: state.catalogEntries.map((row, i) => (i === index ? { ...row, ...entry } : row)),
              }));
            });
            set({ catalogLoading: false });
          });
      })
      // The api boundary rejects only with Error instances: its parser and
      // raiseConsoleError throw those, and the fetch underneath rejects
      // with TypeError; the cast-free parameter rests on that contract.
      .catch((error: Error) => {
        if (catalogRequest !== requestId) return;
        set({ catalogLoading: false, catalogError: error.message });
      });
  },

  // Entering a server's frame also fetches the catalog; a reopen (the idle
  // timer may have retired the connection since last time) refetches fine.
  selectServer: (server) => {
    const { directory, directoryIsCurrent } = get();
    set({
      frame: 'tools',
      server,
      tool: null,
      runReturn: 'tools',
      ...emptyCall,
      tools: [],
      toolsLoading: true,
      toolsError: null,
    });
    const scopeDirectory = directoryIsCurrent ? null : directory;
    mcpConsoleApi.tools(server, scopeDirectory)
      .then((tools) => {
        const state = get();
        // A later navigation may have replaced this request's target.
        if (state.server !== server || state.frame === 'run') return;
        set({ tools, toolsLoading: false });
      })
      // Same boundary contract as openCatalog's catch above.
      .catch((error: Error) => {
        const state = get();
        if (state.server !== server || state.frame === 'run') return;
        set({ toolsLoading: false, toolsError: error.message });
      });
  },

  selectTool: (tool) => set({ frame: 'run', tool, runReturn: 'tools', ...emptyCall }),

  // The catalog's rows run tools directly; the tool may come from a server
  // the dialog never opened, so the run frame takes the server with it.
  selectCatalogTool: (server, tool) => set({ frame: 'run', server, tool, runReturn: 'catalog', ...emptyCall }),

  goBack: () => {
    const { frame, server, runReturn } = get();
    if (frame === 'run') {
      if (runReturn === 'catalog') set({ frame: 'catalog', server: null, tool: null, ...emptyCall });
      else set({ frame: 'tools', tool: null, ...emptyCall });
    } else if (frame === 'tools' && server != null) set({ frame: 'servers', server: null, tool: null, ...emptyListing, ...emptyCall });
    else if (frame === 'catalog') { catalogRequest += 1; set({ frame: 'servers', ...emptyCatalog, ...emptyCall }); }
  },
}), { name: 'mcp-console' }));

/** Fires one tool call for the run frame; the store keeps it out of the component. */
export const callConsoleTool = async (
  server: string,
  tool: string,
  args: McpConsoleToolArgs,
  directory: string | null,
): Promise<void> => {
  const state = useMcpConsoleStore.getState();
  if (state.isCalling) return;
  useMcpConsoleStore.setState({ isCalling: true, callError: null, lastCall: null });
  try {
    const answer = await mcpConsoleApi.call(server, tool, args, directory);
    const current = useMcpConsoleStore.getState();
    // The user may have navigated away while the tool ran; the answer lands only in the frame it belongs to.
    if (current.server === server && current.tool?.name === tool && current.frame === 'run') {
      useMcpConsoleStore.setState({ isCalling: false, lastCall: answer });
    } else {
      useMcpConsoleStore.setState({ isCalling: false });
    }
  } catch (error) {
    useMcpConsoleStore.setState({
      isCalling: false,
      callError: error instanceof Error ? error.message : String(error),
    });
  }
};
