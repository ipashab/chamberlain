import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { mcpConsoleApi, parseToolArguments, summarizeToolInput, type McpConsoleServer, type McpConsoleTool } from '@/lib/mcp-console/mcp-console-api';
import { cn } from '@/lib/utils';
import { callConsoleTool, useMcpConsoleStore } from '@/stores/useMcpConsoleStore';

/**
 * The MCP console as a context rail surface: the servers of the scope, one
 * server's tools, the all-tools catalog, and one tool's run form. The parent
 * pane mounts it keep-alive and passes `visible`, so a switch to another
 * region keeps the run form and its answer; state lives in
 * `useMcpConsoleStore`, which the palette commands and the MCP settings
 * cards deep-link into. The panel header names the surface, so the body
 * starts at the frames directly.
 */

/** Row click targets stay generous; the hint line carries the transport. */
const ServerRow: React.FC<{ server: McpConsoleServer; onOpen: () => void }> = ({ server, onOpen }) => {
  const { t } = useI18n();
  const hint = server.type === 'local'
    ? server.local?.command.join(' ')
    : server.remote?.origin ?? '';
  const unusable = server.needsAuth;
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-start gap-3 rounded-md border border-border/70 bg-card p-3 text-start',
        unusable ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted/60',
      )}
      onClick={unusable ? undefined : onOpen}
      disabled={unusable}
    >
      <Icon name={server.type === 'local' ? 'server' : 'global'} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{server.name}</span>
        {hint ? <span className="block truncate typography-meta text-muted-foreground">{hint}</span> : null}
      </span>
      {unusable ? (
        <span className="shrink-0 typography-meta text-destructive">{t('mcpConsole.server.needsAuth')}</span>
      ) : (
        <span className="shrink-0 typography-meta text-muted-foreground">
          {server.console.toolsKnown != null
            ? t('mcpConsole.server.toolsKnown', { count: server.console.toolsKnown })
            : server.console.connected ? t('mcpConsole.server.connected') : ''}
        </span>
      )}
    </button>
  );
};

const ServersFrame: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18n();
  const directory = useMcpConsoleStore((state) => state.directory);
  const directoryIsCurrent = useMcpConsoleStore((state) => state.directoryIsCurrent);
  const selectServer = useMcpConsoleStore((state) => state.selectServer);
  const currentDirectory = useEffectiveDirectory();
  const scope = directoryIsCurrent ? (currentDirectory ?? null) : directory;

  const [servers, setServers] = React.useState<McpConsoleServer[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setServers(null);
    setError(null);
    mcpConsoleApi.servers(scope)
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [active, scope]);

  if (error != null) return <p className="typography-meta text-destructive">{error}</p>;
  if (servers == null) return <p className="typography-meta text-muted-foreground">{t('mcpConsole.servers.loading')}</p>;
  if (servers.length === 0) return <p className="typography-meta text-muted-foreground">{t('mcpConsole.servers.empty')}</p>;
  return (
    <div className="space-y-2">
      {servers.map((server) => (
        <ServerRow key={server.name} server={server} onOpen={() => selectServer(server.name)} />
      ))}
    </div>
  );
};

const ToolsFrame: React.FC = () => {
  const { t } = useI18n();
  const tools = useMcpConsoleStore((state) => state.tools);
  const toolsLoading = useMcpConsoleStore((state) => state.toolsLoading);
  const toolsError = useMcpConsoleStore((state) => state.toolsError);
  const selectTool = useMcpConsoleStore((state) => state.selectTool);

  if (toolsError != null) return <p className="typography-meta text-destructive">{toolsError}</p>;
  if (toolsLoading) return <p className="typography-meta text-muted-foreground">{t('mcpConsole.tools.loading')}</p>;
  if (tools.length === 0) return <p className="typography-meta text-muted-foreground">{t('mcpConsole.tools.empty')}</p>;
  return (
    <div className="space-y-2">
      {tools.map((tool) => (
        <button
          key={tool.name}
          type="button"
          className="flex w-full items-start gap-3 rounded-md border border-border/70 bg-card p-3 text-start hover:bg-muted/60"
          onClick={() => selectTool(tool)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm font-medium">{tool.name}</span>
            {tool.description ? (
              <span className="block truncate typography-meta text-muted-foreground" title={tool.description}>
                {tool.description}
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
};

const RunFrame: React.FC = () => {
  const { t } = useI18n();
  const server = useMcpConsoleStore((state) => state.server);
  const tool = useMcpConsoleStore((state) => state.tool);
  const directory = useMcpConsoleStore((state) => state.directory);
  const directoryIsCurrent = useMcpConsoleStore((state) => state.directoryIsCurrent);
  const isCalling = useMcpConsoleStore((state) => state.isCalling);
  const lastCall = useMcpConsoleStore((state) => state.lastCall);
  const callError = useMcpConsoleStore((state) => state.callError);
  const currentDirectory = useEffectiveDirectory();
  const scope = directoryIsCurrent ? (currentDirectory ?? null) : directory;

  const [argsText, setArgsText] = React.useState('{}');
  const [argsError, setArgsError] = React.useState<string | null>(null);

  if (server == null || tool == null) return null;

  const run = () => {
    const parsed = parseToolArguments(argsText);
    if (parsed == null) {
      setArgsError(t('mcpConsole.run.invalidJson'));
      return;
    }
    setArgsError(null);
    void callConsoleTool(server, tool.name, parsed, scope);
  };

  return (
    <div className="space-y-3">
      {tool.inputSchema != null ? (
        <details className="rounded-md border border-border/70 bg-card">
          <summary className="cursor-pointer p-3 typography-meta text-muted-foreground">{t('mcpConsole.run.schema')}</summary>
          <pre className="max-h-48 overflow-auto p-3 pt-0 text-xs font-mono">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
      ) : null}
      <div className="space-y-1.5">
        <label className="typography-micro font-medium" htmlFor="mcp-console-args">{t('mcpConsole.run.arguments')}</label>
        <Textarea
          id="mcp-console-args"
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
          className="min-h-24 font-mono text-xs"
          spellCheck={false}
        />
        {argsError ? <p className="typography-meta text-destructive">{argsError}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={isCalling}>
          {isCalling ? t('mcpConsole.run.running') : t('mcpConsole.run.start')}
        </Button>
      </div>
      {callError ? (
        <div className="rounded-md border p-3 typography-meta text-destructive">
          {callError}
        </div>
      ) : null}
      {lastCall ? (
        <div className={cn('rounded-md border p-3', lastCall.result.isError ? 'border-destructive/50 bg-destructive/10' : 'bg-card')}>
          {lastCall.result.isError ? (
            <p className="mb-1 typography-meta font-medium text-destructive">{t('mcpConsole.run.toolError')}</p>
          ) : null}
          {lastCall.result.text ? <pre className="whitespace-pre-wrap break-words text-xs font-mono">{lastCall.result.text}</pre> : null}
          {lastCall.result.structured != null ? (
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs font-mono">
              {JSON.stringify(lastCall.result.structured, null, 2)}
            </pre>
          ) : null}
          <p className="mt-2 typography-meta text-muted-foreground">
            {t('mcpConsole.run.duration', { ms: lastCall.durationMs })}
            {lastCall.result.nonTextItems > 0
              ? ` · ${t('mcpConsole.run.nonText', { count: lastCall.result.nonTextItems })}`
              : ''}
          </p>
        </div>
      ) : null}
    </div>
  );
};

// The catalog frame lists every server's tools at once. Rows are grouped per
// server, the filter narrows rows in place, and a dead server only marks its
// own line — the walk never waits for it to render the rest.
const CatalogFrame: React.FC = () => {
  const { t } = useI18n();
  const catalogLoading = useMcpConsoleStore((state) => state.catalogLoading);
  const catalogError = useMcpConsoleStore((state) => state.catalogError);
  const entries = useMcpConsoleStore((state) => state.catalogEntries);
  const selectCatalogTool = useMcpConsoleStore((state) => state.selectCatalogTool);

  const [filter, setFilter] = React.useState('');
  const needle = filter.trim().toLowerCase();

  const rowsMatch = (tool: McpConsoleTool) => needle === ''
    || tool.name.toLowerCase().includes(needle)
    || tool.description.toLowerCase().includes(needle)
    || summarizeToolInput(tool).some((arg) => arg.name.toLowerCase().includes(needle));

  const alive = entries.filter((entry) => entry.tools != null && entry.error == null);
  const reading = entries.filter((entry) => entry.tools == null && entry.error == null);
  const dead = entries.filter((entry) => entry.error != null);
  const totalTools = alive.reduce((sum, entry) => sum + (entry.tools?.length ?? 0), 0);

  if (catalogError != null) return <p className="typography-meta text-destructive">{catalogError}</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('mcpConsole.catalog.filter')}
          className="h-8 flex-1"
        />
        <span className="shrink-0 typography-meta text-muted-foreground">
          {catalogLoading && entries.length === 0
            ? t('mcpConsole.catalog.loading')
            : t('mcpConsole.catalog.stats', { servers: alive.length, tools: totalTools, failed: dead.length })}
        </span>
      </div>
      {entries.length === 0 && !catalogLoading ? (
        <p className="typography-meta text-muted-foreground">{t('mcpConsole.servers.empty')}</p>
      ) : null}
      <div className="space-y-4">
        {reading.map((entry) => (
          <p key={entry.name} className="typography-meta text-muted-foreground">
            {entry.name} — {t('mcpConsole.tools.loading')}
          </p>
        ))}
        {alive.map((entry) => {
          const rows = (entry.tools ?? []).filter(rowsMatch);
          if (rows.length === 0) return null;
          return (
            <section key={entry.name}>
              <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold">
                {entry.name}
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">{entry.tools?.length ?? 0}</span>
              </h3>
              {rows.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  className="grid w-full grid-cols-[minmax(120px,180px)_minmax(80px,150px)_1fr] items-center gap-2.5 rounded-md px-2.5 py-1 text-start hover:bg-muted/60"
                  onClick={() => selectCatalogTool(entry.name, tool)}
                >
                  <span className="truncate font-mono text-xs font-semibold">{tool.name}</span>
                  <span className="flex flex-wrap gap-1 overflow-hidden">
                    {summarizeToolInput(tool).slice(0, 4).map((arg) => (
                      <span
                        key={arg.name}
                        className={cn(
                          'rounded bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground',
                          arg.required && 'bg-primary/10 text-primary',
                        )}
                      >
                        {arg.name}{arg.required ? '*' : ''}
                      </span>
                    ))}
                    {summarizeToolInput(tool).length > 4 ? <span className="font-mono text-[10px] text-muted-foreground">…</span> : null}
                  </span>
                  <span className="truncate typography-meta text-muted-foreground" title={tool.description}>{tool.description}</span>
                </button>
              ))}
            </section>
          );
        })}
        {dead.length > 0 ? (
          <section>
            <h3 className="mb-1 text-sm font-semibold">{t('mcpConsole.catalog.unavailable')}</h3>
            {dead.map((entry) => (
              <p key={entry.name} className="px-2.5 py-1 typography-meta text-muted-foreground">
                <span className="font-medium text-destructive">{entry.name}</span> — {entry.error}
              </p>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
};

export const McpConsolePane: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { t } = useI18n();
  const frame = useMcpConsoleStore((state) => state.frame);
  const server = useMcpConsoleStore((state) => state.server);
  const tool = useMcpConsoleStore((state) => state.tool);
  const goBack = useMcpConsoleStore((state) => state.goBack);

  const crumb = frame === 'run' && tool
    ? `${server} / ${tool.name}`
    : frame === 'tools' && server
      ? server
      : t('mcpConsole.breadcrumb.catalog');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {frame !== 'servers' ? (
        <div className="flex items-center gap-2 px-3 pt-3">
          <Button variant="ghost" size="icon" className="size-7" onClick={goBack} aria-label={t('mcpConsole.back')}>
            <Icon name="arrow-left" className="size-4" />
          </Button>
          <span className="truncate typography-meta text-muted-foreground">{crumb}</span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {frame === 'servers' ? <ServersFrame active={visible} /> : null}
        {frame === 'catalog' ? <CatalogFrame /> : null}
        {frame === 'tools' ? <ToolsFrame /> : null}
        {frame === 'run' ? <RunFrame /> : null}
      </div>
    </div>
  );
};
