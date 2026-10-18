import React from 'react';

import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import {
  type DebuggerState,
  type DebugStepKind,
  type DebugTestStatus,
  type DebugVariable,
  debuggerApi,
} from '@/lib/debugger/debugger-api';
import { buildTestTree, countTestRun, type TestTreeNode } from '@/lib/debugger/testTree';
import { loadDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

type DebugTargetKind = 'module' | 'program';

type DebugFormState = {
  pythonPath: string;
  cwd: string;
  targetKind: DebugTargetKind;
  module: string;
  program: string;
  args: string;
};

// The last launch the user actually ran is the best default for the next
// one; the panel directory's venv is the best first guess before that.
const LAUNCH_STORAGE_KEY = 'openchamber:debug:launch';

const defaultLaunchForm = (directory: string | null): DebugFormState => ({
  pythonPath: directory != null ? `${directory}/.venv/bin/python` : 'python3',
  cwd: directory ?? '',
  targetKind: 'module',
  module: 'pytest',
  program: '',
  args: '',
});

// A stored form the user never got to run can only be trusted shape-wise,
// never parsed blindly into the launch input.
const storedLaunchFormSchema = z
  .object({
    pythonPath: z.string().min(1),
    cwd: z.string().min(1),
    targetKind: z.enum(['module', 'program']).catch('module'),
    module: z.string().catch(''),
    program: z.string().catch(''),
    args: z.string().catch(''),
  })
  .refine(
    (value) => (value.targetKind === 'module' ? value.module.trim().length > 0 : value.program.trim().length > 0),
    { message: 'the stored target is empty' },
  );

const restoreLaunchForm = (): DebugFormState | null => {
  const raw = window.localStorage.getItem(LAUNCH_STORAGE_KEY);
  if (raw == null) return null;
  try {
    const parsed = storedLaunchFormSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const DEBUG_STATUS_LABEL_KEYS = {
  starting: 'debug.status.starting',
  running: 'debug.status.running',
  stopped: 'debug.status.stopped',
} as const;

const labelClassName = 'text-xs font-medium text-muted-foreground';
const sectionTitleClassName = 'text-xs font-semibold text-muted-foreground uppercase tracking-wide';

// Per-test status → the label word used in tooltips, summaries and arias.
const TEST_STATUS_LABEL_KEYS = {
  pending: 'debug.tests.status.pending',
  running: 'debug.tests.status.running',
  passed: 'debug.tests.status.passed',
  failed: 'debug.tests.status.failed',
  error: 'debug.tests.status.error',
  skipped: 'debug.tests.status.skipped',
} as const;

const formatDuration = (ms: number): string => (ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`);

// PyCharm colors variable values by kind; the same scan by eye here: the
// adapter's own type says it best, the value's shape covers the rest.
const valueToneFor = (variable: DebugVariable): string => {
  const type = (variable.type ?? '').toLowerCase();
  const value = variable.value.trim();
  if (type === 'none' || type === 'nonetype' || value === 'None') return 'italic text-muted-foreground/70';
  if (type === 'bool' || value === 'True' || value === 'False') return 'text-[var(--primary)]';
  if (type === 'int' || type === 'float' || type === 'complex' || /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?j?$/i.test(value)) return 'text-status-info';
  if (type === 'str' || type === 'bytes' || /^b?["']/.test(value)) return 'text-status-success';
  return 'text-muted-foreground';
};

const splitArgs = (raw: string): string[] =>
  raw.trim().length === 0 ? [] : raw.trim().split(/\s+/).filter((part) => part.length > 0);

const basename = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
};

// Mirrors the pytest outcome glyphs of the run tree: a spinner while the
// test runs, a check/cross/dash once it did, a hollow dot before it started.
const TestStatusIcon: React.FC<{ status: DebugTestStatus }> = ({ status }) => {
  if (status === 'running') {
    return <Spinner className="size-3 shrink-0 text-status-info" aria-hidden />;
  }
  const name = status === 'passed'
    ? 'checkbox-circle'
    : status === 'failed'
      ? 'close-circle'
      : status === 'error'
        ? 'error-warning'
        : status === 'skipped'
          ? 'subtract'
          : 'circle';
  const tone = status === 'passed'
    ? 'text-status-success'
    : status === 'failed' || status === 'error'
      ? 'text-status-error'
      : status === 'skipped'
        ? 'text-muted-foreground'
        : 'text-muted-foreground/50';
  return <Icon name={name} className={cn('size-3.5 shrink-0', tone)} aria-hidden />;
};

export const DebugView: React.FC<{
  visible: boolean;
  directory: string | null;
}> = ({ visible, directory }) => {
  const { t } = useI18n();
  const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);

  // The chat a pinned value goes to is the current session, whose directory
  // is not necessarily the debug tab's target: the same resolution the inline
  // comment controller uses, so the chip lands where the composer reads it.
  const currentSessionId = useSessionUIStore(React.useCallback((state) => state.currentSessionId, []));
  const newSessionDraftOpen = useSessionUIStore(React.useCallback((state) => state.newSessionDraft?.open, []));
  const sessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null),
      [currentSessionId],
    ),
  );
  const effectiveDirectory = useEffectiveDirectory();
  const chatSessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
  const chatDirectory = sessionDirectory ?? effectiveDirectory;

  const [state, setState] = React.useState<DebuggerState | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [evaluateResult, setEvaluateResult] = React.useState<{ expression: string; result: string | null; error: string | null } | null>(null);
  const [evaluateExpression, setEvaluateExpression] = React.useState('');
  const [breakpointPath, setBreakpointPath] = React.useState('');
  const [breakpointLine, setBreakpointLine] = React.useState('');
  // The launch form starts folded to one summary row: while a run is up the
  // transports matter, and while idle the last launch is usually the right
  // one, so the fields wait for a deliberate look.
  const [launchOpen, setLaunchOpen] = React.useState(false);
  // Breakpoints live in the same kind of folded block as the launch form: the
  // set usually survives runs untouched, so its editor waits for a click.
  const [breakpointsOpen, setBreakpointsOpen] = React.useState(false);
  const [form, setForm] = React.useState<DebugFormState>(
    // The last run's values first; the panel directory's venv as the first
    // guess when nothing ran yet.
    () => restoreLaunchForm() ?? defaultLaunchForm(null),
  );

  const session = state?.session ?? null;
  const stopped = session?.status === 'stopped';

  const patchForm = React.useCallback((patch: Partial<DebugFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  }, []);

  // The panel directory is the natural working directory of a debug run —
  // and its venv the natural interpreter — until the user types their own.
  React.useEffect(() => {
    setForm((current) => {
      if (directory == null || current.cwd !== '') return current;
      const next = { ...current, cwd: directory };
      if (current.pythonPath === 'python3') {
        next.pythonPath = `${directory}/.venv/bin/python`;
      }
      return next;
    });
  }, [directory]);

  // The configured interpreter outranks both defaults while the field still
  // carries the untouched `python3`; anything the user typed stays as is.
  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopSettings().then((settings) => {
      const configured = settings?.pythonInterpreter?.trim();
      if (cancelled || configured == null || configured.length === 0) return;
      setForm((current) => (current.pythonPath === 'python3' ? { ...current, pythonPath: configured } : current));
    }).catch(() => {
      // No settings endpoint answer just keeps the field defaults.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = React.useCallback(() => {
    let cancelled = false;
    debuggerApi.state().then((next) => {
      if (!cancelled) {
        setState(next);
        setLoadError(null);
      }
    }).catch((error) => {
      if (!cancelled) setLoadError(String(error instanceof Error ? error.message : error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => refresh(), [refresh, visible]);

  // Live updates ride the same broadcast the server sends for every state
  // change; a frame that raced a second change is covered by the refetch.
  React.useEffect(() => (
    subscribeOpenchamberEvents((event) => {
      if (event.type === 'debugger-changed') refresh();
    })
  ), [refresh]);

  const runAction = React.useCallback(async (action: () => Promise<DebuggerState>) => {
    setBusy(true);
    try {
      setState(await action());
      setActionError(null);
    } catch (error) {
      setActionError(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }, []);

  // Variables tree: containers ask the adapter for children once and keep
  // them until the stopped frame moves; then every expansion starts fresh,
  // because references from an old frame are meaningless.
  const [expandedReferences, setExpandedReferences] = React.useState<Set<number>>(() => new Set());
  const [childrenByReference, setChildrenByReference] = React.useState<Map<number, DebugVariable[]>>(new Map());

  const stopFrame = session?.stack[session.currentFrameIndex ?? 0] ?? session?.stack[0] ?? null;
  const stopFrameKey = session != null && stopFrame != null
    ? `${session.launch.startedAt}:${stopFrame.id}:${stopFrame.line ?? 0}`
    : null;
  React.useEffect(() => {
    setExpandedReferences(new Set());
    setChildrenByReference(new Map());
  }, [stopFrameKey]);

  // The pytest tree starts fully expanded (PyCharm does), and a click on a
  // test narrows the output section to that test's own log until it is
  // cleared or a new run begins.
  const [collapsedTestKeys, setCollapsedTestKeys] = React.useState<Set<string>>(() => new Set());
  const [selectedTestId, setSelectedTestId] = React.useState<string | null>(null);
  const runKey = session != null ? `run:${session.launch.startedAt}` : `exit:${state?.lastExit?.finishedAt ?? 'none'}`;
  React.useEffect(() => {
    setCollapsedTestKeys(new Set());
    setSelectedTestId(null);
  }, [runKey]);

  // The stack folds to its header until opened; the stopped frame keeps riding
  // in that header line, so the folded state still says where the run is.
  const [stackOpen, setStackOpen] = React.useState(false);

  const tests = state?.tests ?? null;
  const testTree = React.useMemo(() => (tests != null ? buildTestTree(tests.nodes) : []), [tests]);
  const testCounts = React.useMemo(() => countTestRun(tests?.nodes ?? [], tests?.collected), [tests]);
  const selectedTest = React.useMemo(
    () => (selectedTestId == null || tests == null ? null : tests.nodes.find((entry) => entry.nodeId === selectedTestId) ?? null),
    [selectedTestId, tests],
  );

  const toggleTestCollapsed = (key: string) => {
    setCollapsedTestKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleVariable = (variable: DebugVariable) => {
    const reference = variable.reference;
    if (reference == null) return;
    setExpandedReferences((current) => {
      const next = new Set(current);
      if (next.has(reference)) {
        next.delete(reference);
      } else {
        next.add(reference);
      }
      return next;
    });
    if (childrenByReference.has(reference)) return;
    setBusy(true);
    debuggerApi.variables(reference).then((children) => {
      setChildrenByReference((current) => new Map(current).set(reference, children));
    }).catch((error) => {
      setActionError(String(error instanceof Error ? error.message : error));
    }).finally(() => {
      setBusy(false);
    });
  };

  const copyVariable = (variable: DebugVariable) => {
    void navigator.clipboard?.writeText(`${variable.name} = ${variable.value}`)?.catch(() => {
      // A denied clipboard leaves the value on screen, which is where it was.
    });
  };

  // One pinned debug value rides to the chat as a draft, exactly like a diff
  // line or a PR comment; the composer turns it into a context part on send.
  const shareVariable = (namePath: string, variable: DebugVariable) => {
    const frame = stopFrame;
    if (chatSessionKey == null || chatDirectory == null) {
      toast.error(t('debug.variables.shareNoSession'));
      return;
    }
    useInlineCommentDraftStore.getState().addDraft({ directory: chatDirectory, sessionKey: chatSessionKey }, {
      source: 'debug-variable',
      fileLabel: frame?.path ?? '',
      startLine: frame?.line ?? 0,
      endLine: frame?.line ?? 0,
      code: variable.value,
      language: 'python',
      text: '',
      debugVariable: { name: namePath, type: variable.type ?? null },
    });
    requestAnimationFrame(focusChatInput);
  };

  const renderVariable = (variable: DebugVariable, depth: number, key: string, namePath: string): React.ReactNode => {
    const reference = variable.reference;
    const expanded = reference != null && expandedReferences.has(reference);
    const children = reference != null ? childrenByReference.get(reference) : undefined;
    return (
      <React.Fragment key={key}>
        {/* One aligned row of the table: name and type in the left column,
            the value in the right one, tinted by its kind, rows kept apart
            by hairlines instead of hope. */}
        <div
          className="group/row flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--foreground)_7%,transparent)] py-0.5 pe-1 text-xs last:border-b-0 hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]"
          style={{ paddingInlineStart: `${8 + depth * 12}px` }}
        >
          {reference != null ? (
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-expanded={expanded}
              aria-label={variable.name}
              onClick={() => toggleVariable(variable)}
            >
              <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
            </button>
          ) : (
            <span className="w-3.5 shrink-0" aria-hidden />
          )}
          <span className="w-[38%] min-w-0 shrink-0 truncate font-mono text-foreground" title={namePath}>
            {variable.name}
            {variable.type != null ? <span className="text-muted-foreground/70">: {variable.type}</span> : null}
          </span>
          <span className={cn('min-w-0 flex-1 truncate font-mono', valueToneFor(variable))} title={`${variable.name} = ${variable.value}`}>
            {variable.value}
          </span>
          <button
            type="button"
            className="ms-auto shrink-0 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover/row:opacity-100"
            aria-label={t('debug.variables.share')}
            title={t('debug.variables.share')}
            onClick={() => shareVariable(namePath, variable)}
          >
            <Icon name="add-circle" className="size-3" />
          </button>
          <button
            type="button"
            className="shrink-0 opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover/row:opacity-100"
            aria-label={t('debug.variables.copy')}
            onClick={() => copyVariable(variable)}
          >
            <Icon name="file-copy" className="size-3" />
          </button>
        </div>
        {expanded && children == null ? <Spinner className="ms-6 size-3" /> : null}
        {expanded && children?.map((child, index) => renderVariable(child, depth + 1, `${key}.${index}:${child.name}`, `${namePath}.${child.name}`))}
      </React.Fragment>
    );
  };

  // One row of the pytest tree: containers fold, a test leaf opens its own
  // log in the output section. Status icon and duration ride every row —
  // a container carries the worst of its subtree.
  const renderTestNode = (node: TestTreeNode, depth: number): React.ReactNode => {
    const collapsible = node.children.length > 0;
    const collapsed = collapsible && collapsedTestKeys.has(node.key);
    const selectable = node.test != null;
    const selected = selectable && node.test?.nodeId === selectedTestId;
    return (
      <React.Fragment key={node.key}>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 border-b border-[color-mix(in_srgb,var(--foreground)_7%,transparent)] py-1 pe-2 text-start text-xs last:border-b-0 hover:bg-interactive-hover',
            selected ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)]' : null,
          )}
          style={{ paddingInlineStart: `${8 + depth * 12}px` }}
          aria-expanded={collapsible ? !collapsed : undefined}
          title={node.test?.nodeId ?? node.label}
          onClick={() => {
            if (node.test != null) {
              setSelectedTestId(node.test.nodeId);
              return;
            }
            if (collapsible) toggleTestCollapsed(node.key);
          }}
        >
          {collapsible ? (
            <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <span className="w-3 shrink-0" aria-hidden />
          )}
          <TestStatusIcon status={node.status} />
          <span className={cn('min-w-0 flex-1 truncate font-mono', selectable ? 'text-foreground' : 'text-muted-foreground')}>
            {node.label}
          </span>
          <span className="sr-only">{t(TEST_STATUS_LABEL_KEYS[node.status])}</span>
          {node.durationMs != null && node.durationMs > 0 ? (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">{formatDuration(node.durationMs)}</span>
          ) : null}
        </button>
        {!collapsed && node.children.map((child) => renderTestNode(child, depth + 1))}
      </React.Fragment>
    );
  };

  const startRun = () => {
    const formSnapshot = form;
    void runAction(async () => {
      const next = await debuggerApi.start({
        pythonPath: formSnapshot.pythonPath.trim() || 'python3',
        cwd: formSnapshot.cwd.trim(),
        module: formSnapshot.targetKind === 'module' ? formSnapshot.module.trim() : null,
        program: formSnapshot.targetKind === 'program' ? formSnapshot.program.trim() : null,
        args: splitArgs(formSnapshot.args),
        breakpoints: state?.breakpoints ?? [],
      });
      // A launch the user actually ran is the next default.
      window.localStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify(formSnapshot));
      return next;
    });
  };

  const step = (kind: DebugStepKind) => {
    void runAction(() => debuggerApi.step(kind));
  };

  const addBreakpoint = () => {
    const path = breakpointPath.trim();
    const line = Number.parseInt(breakpointLine, 10);
    if (path.length === 0 || !Number.isInteger(line) || line < 1) {
      setActionError('Breakpoint needs an absolute file path and a 1-based line number');
      return;
    }
    setBreakpointPath('');
    setBreakpointLine('');
    void runAction(() => debuggerApi.setBreakpoints(path, [line]));
  };

  const removeBreakpoint = (path: string, line: number) => {
    const entry = state?.breakpoints.find((candidate) => candidate.path === path);
    const withoutLine = entry ? entry.lines.filter((candidate) => candidate !== line) : null;
    void runAction(() =>
      withoutLine != null && withoutLine.length > 0
        ? debuggerApi.setBreakpoints(path, withoutLine)
        : debuggerApi.setBreakpoints(path, []));
  };

  const runEvaluate = () => {
    const expression = evaluateExpression.trim();
    if (expression.length === 0) return;
    setBusy(true);
    debuggerApi.evaluate(expression).then((result) => {
      setEvaluateResult({ expression, result: result.result, error: result.error ?? null });
    }).catch((error) => {
      setEvaluateResult({ expression, result: null, error: String(error instanceof Error ? error.message : error) });
    }).finally(() => {
      setBusy(false);
    });
  };

  const openFrameAtLine = (path: string | null, line: number | null) => {
    if (path == null || line == null) return;
    const openDirectory = directory ?? form.cwd.trim();
    if (openDirectory.length === 0) return;
    openContextFileAtLine(openDirectory, path, line);
  };

  // Whether the transports render into the panel header; hooks up here so the
  // early error return below cannot skip them.
  const inPanelHeader = useInContextPanelHeader();

  const statusLabel = () => {
    if (session != null) {
      return t(DEBUG_STATUS_LABEL_KEYS[session.status]);
    }
    const exit = state?.lastExit ?? null;
    if (exit == null) return null;
    return exit.exitCode == null ? t('debug.status.ended') : `${t('debug.status.ended')} (${t('debug.status.exitCode', { code: exit.exitCode })})`;
  };

  const launchSummary = [
    form.targetKind === 'module' ? form.module.trim() || t('debug.launch.module.placeholder') : form.program.trim() || t('debug.launch.program.placeholder'),
    form.args.trim(),
  ].filter(Boolean).join(' ');

  const breakpointSummary = state?.breakpoints
    .flatMap((entry) => entry.lines.map((line) => `${basename(entry.path)}:${line}`))
    .join(', ') ?? '';

  if (loadError != null && state == null) {
    return (
      <div className="flex h-full flex-col gap-2 p-3 text-sm text-muted-foreground">
        {loadError}
      </div>
    );
  }

  // Debuggee output, as the adapter reported it; a test selected in the tree
  // narrows it to that one test — its failure stack first, then the captured
  // log — until the selection is cleared. On pytest runs it sits next to the
  // test tree; without a test report it stays a full-width section below.
  const outputSection = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className={sectionTitleClassName}>{t('debug.section.output')}</span>
        {selectedTest != null ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 shrink-0 px-1.5 text-xs"
            onClick={() => setSelectedTestId(null)}
          >
            {t('debug.tests.showAllOutput')}
          </Button>
        ) : null}
      </div>
      {selectedTest != null ? (
        <div className="flex flex-col gap-1">
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={selectedTest.nodeId}>
            {selectedTest.nodeId}
          </p>
          {selectedTest.error != null ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[color-mix(in_srgb,var(--status-error)_8%,transparent)] p-2 font-mono text-xs text-status-error">
              {selectedTest.error}
            </pre>
          ) : null}
          {selectedTest.log != null ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-2 font-mono text-xs">
              {selectedTest.log}
            </pre>
          ) : null}
          {selectedTest.error == null && selectedTest.log == null ? (
            <span className="text-xs text-muted-foreground">{t('debug.output.empty')}</span>
          ) : null}
        </div>
      ) : state != null && state.outputTail.length > 0 ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-2 font-mono text-xs">
          {state.outputTail.map((entry) => entry.output).join('')}
        </pre>
      ) : (
        <span className="text-xs text-muted-foreground">{t('debug.output.empty')}</span>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm">
      {/* Transports pinned into the panel header, like the terminal's tab
          strip: one reach away no matter where the panel scrolled. */}
      <ContextPanelHeaderToolbar>
        <div
          className={cn(
            'app-region-no-drag flex min-w-0 flex-1 items-center justify-end gap-1 text-xs',
            !inPanelHeader && 'sticky top-0 z-20 -mx-3 -mt-3 bg-[var(--surface-background)] px-3 py-1.5',
          )}
        >
          {session == null ? (
            <>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 w-7 p-0"
                disabled={busy || form.cwd.trim().length === 0}
                title={t('debug.launch.start')}
                aria-label={t('debug.launch.start')}
                onClick={startRun}
              >
                {busy ? <Spinner className="size-4" /> : <Icon name="play" className="size-4" />}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 w-7 p-0"
                aria-expanded={launchOpen}
                title={t('debug.launch.settings')}
                aria-label={t('debug.launch.settings')}
                onClick={() => setLaunchOpen((open) => !open)}
              >
                <Icon name={launchOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <span className={cn('me-1 truncate', stopped ? 'text-status-warning' : 'text-status-success')}>
                {busy ? <Spinner className="me-1 inline size-3 align-middle" /> : null}
                {statusLabel()}
              </span>
              <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0" disabled={!stopped || busy} title={t('debug.control.continue')} aria-label={t('debug.control.continue')} onClick={() => { void runAction(() => debuggerApi.continue()); }}>
                <Icon name="play" className="size-4" />
              </Button>
              <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0" disabled={!stopped || busy} title={t('debug.control.stepOver')} aria-label={t('debug.control.stepOver')} onClick={() => step('over')}>
                <Icon name="arrow-right-s" className="size-4" />
              </Button>
              <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0" disabled={!stopped || busy} title={t('debug.control.stepInto')} aria-label={t('debug.control.stepInto')} onClick={() => step('into')}>
                <Icon name="arrow-down-s" className="size-4" />
              </Button>
              <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0" disabled={!stopped || busy} title={t('debug.control.stepOut')} aria-label={t('debug.control.stepOut')} onClick={() => step('out')}>
                <Icon name="arrow-up-s" className="size-4" />
              </Button>
              <Button type="button" size="xs" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" disabled={busy} title={t('debug.control.stop')} aria-label={t('debug.control.stop')} onClick={() => { void runAction(() => debuggerApi.stop()); }}>
                <Icon name="stop" className="size-4" />
              </Button>
            </>
          )}
        </div>
      </ContextPanelHeaderToolbar>

      {session != null && session.error != null ? (
        <p className="text-xs text-status-warning">
          {t('debug.session.error')}: <span className="font-mono">{session.error}</span>
        </p>
      ) : null}
      {session == null && state?.lastExit?.error != null ? (
        <p className="text-xs text-status-warning">
          <span className="font-mono">{state.lastExit.error}</span>
        </p>
      ) : null}
      {actionError != null ? (
        <p className="text-xs text-status-warning">
          <span className="font-mono">{actionError}</span>
        </p>
      ) : null}
      {session == null && statusLabel() != null ? (
        <p className="text-xs text-muted-foreground">{statusLabel()}</p>
      ) : null}

      {/* Launch, folded to one summary row: the last launch usually is the
          right one, and while a run is up the fields only speak for the next. */}
      <div className="rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 py-1.5 text-start text-xs"
          aria-expanded={launchOpen}
          onClick={() => setLaunchOpen((open) => !open)}
        >
          <Icon name={launchOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-muted-foreground" title={launchSummary}>
            {launchSummary}
          </span>
        </button>

        {launchOpen ? (
          <div className="flex flex-col gap-2 border-t border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] py-2">
            <label className="flex flex-col gap-1">
              <span className={labelClassName}>{t('debug.launch.pythonPath')}</span>
              <Input
                value={form.pythonPath}
                placeholder={t('debug.launch.pythonPath.placeholder')}
                onChange={(event) => patchForm({ pythonPath: event.target.value })}
                disabled={session != null}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={labelClassName}>{t('debug.launch.cwd')}</span>
              <Input
                value={form.cwd}
                onChange={(event) => patchForm({ cwd: event.target.value })}
                disabled={session != null}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className="sr-only">{t('debug.launch.target.module')}</span>
              <div className="flex gap-2">
                <Button
                  variant="chip"
                  size="sm"
                  aria-pressed={form.targetKind === 'module'}
                  disabled={session != null}
                  onClick={() => patchForm({ targetKind: 'module' })}
                >
                  {t('debug.launch.target.module')}
                </Button>
                <Button
                  variant="chip"
                  size="sm"
                  aria-pressed={form.targetKind === 'program'}
                  disabled={session != null}
                  onClick={() => patchForm({ targetKind: 'program' })}
                >
                  {t('debug.launch.target.program')}
                </Button>
              </div>
            </div>
            {form.targetKind === 'module' ? (
              <label className="flex flex-col gap-1">
                <span className="sr-only">{t('debug.launch.target.module')}</span>
                <Input
                  value={form.module}
                  placeholder={t('debug.launch.module.placeholder')}
                  onChange={(event) => patchForm({ module: event.target.value })}
                  disabled={session != null}
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1">
                <span className="sr-only">{t('debug.launch.target.program')}</span>
                <Input
                  value={form.program}
                  placeholder={t('debug.launch.program.placeholder')}
                  onChange={(event) => patchForm({ program: event.target.value })}
                  disabled={session != null}
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className={labelClassName}>{t('debug.launch.args')}</span>
              <Input
                value={form.args}
                placeholder={t('debug.launch.args.placeholder')}
                onChange={(event) => patchForm({ args: event.target.value })}
                disabled={session != null}
              />
            </label>
          </div>
        ) : null}
      </div>

      {/* Stack as a frames table, PyCharm style: function on the left, where
          it stopped on the right; the stopped frame carries the accent, every
          row jumps to the file at that line. */}
      {session != null ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-start"
            aria-expanded={stackOpen}
            onClick={() => setStackOpen((open) => !open)}
          >
            <Icon name={stackOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn(sectionTitleClassName, 'shrink-0')}>{t('debug.section.stack')}</span>
            {!stackOpen && stopFrame != null ? (
              <span
                className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                title={stopFrame.path != null && stopFrame.line != null ? `${stopFrame.path}:${stopFrame.line}` : stopFrame.name}
              >
                {stopFrame.name}
                {stopFrame.line != null ? ` ${basename(stopFrame.path ?? '')}:${stopFrame.line}` : ''}
              </span>
            ) : null}
          </button>
          {stackOpen && session.stack.length > 0 ? (
            <div className="overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]">
              {session.stack.map((frame, index) => (
                <button
                  key={frame.id}
                  type="button"
                  className={cn(
                    'group/frame flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs hover:bg-interactive-hover',
                    frame === stopFrame ? 'bg-[color-mix(in_srgb,var(--primary)_12%,transparent)]' : null,
                    index < session.stack.length - 1 ? 'border-b border-[color-mix(in_srgb,var(--foreground)_8%,transparent)]' : null,
                  )}
                  onClick={() => openFrameAtLine(frame.path, frame.line)}
                  title={frame.path != null && frame.line != null ? `${frame.path}:${frame.line}` : frame.name}
                >
                  <span className={cn('min-w-0 flex-1 truncate font-mono', frame === stopFrame ? 'text-foreground' : 'text-muted-foreground')}>
                    {frame.name}
                  </span>
                  {frame.line != null ? (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
                      {basename(frame.path ?? '')}:{frame.line}
                    </span>
                  ) : null}
                  <Icon name="arrow-right-s" className="shrink-0 size-3 text-muted-foreground opacity-0 group-hover/frame:opacity-100" />
                </button>
              ))}
            </div>
          ) : null}
          {stackOpen && session.stack.length === 0 ? (
            <span className="text-xs text-muted-foreground">{t('debug.stack.empty')}</span>
          ) : null}
        </div>
      ) : null}

      {/* pytest runs draw the run itself: the collected tests as a tree with
          outcome icons, the summary over it, every test's log one click away.
          The run's output sits next to the tree in the same block, like the
          PyCharm dashboard, and drops below as its own section when there is
          no pytest report. */}
      {tests != null ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className={sectionTitleClassName}>{t('debug.section.tests')}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px]">
                {testCounts.failed > 0 ? (
                  <span className="shrink-0 text-status-error">{t('debug.tests.failed', { count: testCounts.failed })}</span>
                ) : null}
                {testCounts.passed > 0 ? (
                  <span className="shrink-0 text-status-success">{t('debug.tests.passed', { count: testCounts.passed })}</span>
                ) : null}
                {testCounts.skipped > 0 ? (
                  <span className="shrink-0 text-muted-foreground">{t('debug.tests.skipped', { count: testCounts.skipped })}</span>
                ) : null}
                <span className="shrink-0 font-mono text-muted-foreground">{testCounts.done}/{testCounts.total}</span>
              </span>
            </div>
            {testTree.length > 0 ? (
              <div className="overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]">
                {testTree.map((node) => renderTestNode(node, 0))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{t('debug.tests.collecting')}</span>
            )}
          </div>
          <div className="min-w-[12rem] flex-1">{outputSection}</div>
        </div>
      ) : null}

      {/* Variables of the top frame, grouped by the adapter's scopes. Containers
          with a reference expand in place, fetching children on first open. */}
      {session != null ? (
        <div className="flex flex-col gap-1">
          <span className={sectionTitleClassName}>{t('debug.section.variables')}</span>
          {stopFrame != null ? (
            stopFrame.scopes.map((scope) => (
              <div key={`${scope.name}-${stopFrame.id}`} className="flex flex-col gap-0.5">
                <span className={labelClassName}>{scope.name}</span>
                <div className="overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)]">
                  {scope.variables.map((variable, index) => renderVariable(variable, 0, `${scope.name}:${index}:${variable.name}`, variable.name))}
                </div>
              </div>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">{t('debug.variables.empty')}</span>
          )}
        </div>
      ) : null}

      {/* Breakpoints: kept between runs, live while a run is up. The list and
          its editor share the launch form's folded block; the summary line
          carries the set when it is closed. */}
      <div className="rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] px-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 py-1.5 text-start text-xs"
          aria-expanded={breakpointsOpen}
          onClick={() => setBreakpointsOpen((open) => !open)}
        >
          <Icon name={breakpointsOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn(sectionTitleClassName, 'shrink-0')}>{t('debug.section.breakpoints')}</span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={breakpointSummary === '' ? undefined : breakpointSummary}>
            {breakpointSummary === '' ? t('debug.breakpoints.empty') : breakpointSummary}
          </span>
        </button>

        {breakpointsOpen ? (
          <div className="flex flex-col gap-2 border-t border-[color-mix(in_srgb,var(--foreground)_8%,transparent)] py-2">
            {state?.breakpoints.some((entry) => entry.lines.length > 0) ? (
              state.breakpoints.flatMap((entry) => entry.lines.map((line) => {
                const path = entry.path;
                return (
                  <div key={`${path}:${line}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs">
                    <button
                      type="button"
                      className="truncate text-start font-mono hover:underline"
                      onClick={() => openFrameAtLine(path, line)}
                      title={`${path}:${line}`}
                    >
                      {basename(path)}:{line}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={t('debug.breakpoints.remove')}
                      onClick={() => removeBreakpoint(path, line)}
                    >
                      <Icon name="close" className="size-3.5" />
                    </button>
                  </div>
                );
              }))
            ) : (
              <span className="text-xs text-muted-foreground">{t('debug.breakpoints.empty')}</span>
            )}
            {session == null ? (
              <div className="flex gap-2">
                <Input
                  value={breakpointPath}
                  placeholder={t('debug.breakpoints.path.placeholder')}
                  className="font-mono"
                  onChange={(event) => setBreakpointPath(event.target.value)}
                />
                <Input
                  value={breakpointLine}
                  placeholder={t('debug.breakpoints.line.placeholder')}
                  className="w-16 shrink-0"
                  inputMode="numeric"
                  onChange={(event) => setBreakpointLine(event.target.value)}
                />
                <Button variant="secondary" size="sm" className="shrink-0" disabled={busy} onClick={addBreakpoint}>
                  {t('debug.breakpoints.add')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Without a pytest report the output stands on its own, still ahead of
          the evaluate box that stays at the bottom of the panel. */}
      {tests == null ? outputSection : null}

      {/* Evaluate on the stopped frame. */}
      <div className="flex flex-col gap-1">
        <span className={sectionTitleClassName}>{t('debug.section.evaluate')}</span>
        <div className="flex gap-2">
          <Input
            value={evaluateExpression}
            placeholder={t('debug.evaluate.placeholder')}
            className="font-mono"
            disabled={!stopped}
            onChange={(event) => setEvaluateExpression(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runEvaluate();
            }}
          />
          <Button variant="secondary" size="sm" className="shrink-0" disabled={!stopped || busy} onClick={runEvaluate}>
            {t('debug.section.evaluate')}
          </Button>
        </div>
        {evaluateResult != null ? (
          <p className="px-2 font-mono text-xs text-muted-foreground">
            <span className="text-foreground">{evaluateResult.expression}</span>
            {' → '}
            {evaluateResult.error != null ? <span className="text-status-warning">{evaluateResult.error}</span> : evaluateResult.result}
          </p>
        ) : null}
      </div>
    </div>
  );
};
