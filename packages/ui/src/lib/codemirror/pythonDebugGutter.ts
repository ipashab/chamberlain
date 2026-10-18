import { RangeSetBuilder, type Extension, type RangeSet, type Text } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

// The Python debug gutter: the left-hand strip where PyCharm puts its run
// arrows and red dots. Clicking a line toggles a breakpoint; clicking the
// arrow on a top-level `def` launches that def as a pytest node id, or the
// whole file as a script. The stopped line gets a background stripe.
//
// The extension is built from live panel data; when breakpoints or the
// stopped position change, the host reconfigures it as a whole.

export type PythonRunTarget = { kind: 'test' | 'script'; name: string };

type PythonDebugGutterOptions = {
  // 1-based lines carrying a breakpoint in this file.
  breakpointLines: number[];
  // The line the stopped frame sits on, when the stop is in this file.
  executionLine: number | null;
  onToggleBreakpoint: (line: number) => void;
  onRun: (target: PythonRunTarget, line: number) => void;
  labels: { breakpoint: string; runTest: string; runScript: string };
};

// A top-level def is what pytest and `python file.py` can start from; nested
// defs belong to an outer function and are not entry points. Class methods
// get no marker: this project's tests are module-level functions.
const TOP_LEVEL_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*[(]/;

const computePythonRunTargets = (doc: Text): Map<number, PythonRunTarget> => {
  const targets = new Map<number, PythonRunTarget>();
  for (let line = 1; line <= doc.lines; line += 1) {
    const match = TOP_LEVEL_DEF.exec(doc.line(line).text);
    const name = match?.[1];
    if (name == null) continue;
    targets.set(line, name.startsWith('test')
      ? { kind: 'test', name }
      : { kind: 'script', name });
  }
  return targets;
};

class BreakpointMarker extends GutterMarker {
  private readonly label: string;

  constructor(label: string) {
    super();
    this.label = label;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof BreakpointMarker && other.label === this.label;
  }

  toDOM(): Node {
    const element = document.createElement('div');
    element.className = 'cm-pydbg-breakpoint';
    element.title = this.label;
    return element;
  }
}

class RunMarker extends GutterMarker {
  private readonly target: PythonRunTarget;
  private readonly label: string;

  constructor(target: PythonRunTarget, label: string) {
    super();
    this.target = target;
    this.label = label;
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RunMarker
      && other.target.kind === this.target.kind
      && other.target.name === this.target.name
      && other.label === this.label;
  }

  toDOM(): Node {
    const element = document.createElement('div');
    // The class is the click target inside the gutter's own handler.
    element.className = `cm-pydbg-run cm-pydbg-run-${this.target.kind}`;
    element.title = `${this.label}: ${this.target.name}`;
    return element;
  }
}

class PythonDebugGutterPlugin {
  readonly view: EditorView;
  runTargets: Map<number, PythonRunTarget> = new Map();
  markers: RangeSet<GutterMarker> = new RangeSetBuilder<GutterMarker>().finish();
  decorations: DecorationSet = Decoration.none;

  private readonly options: PythonDebugGutterOptions;

  constructor(view: EditorView, options: PythonDebugGutterOptions) {
    this.view = view;
    this.options = options;
    this.recompute();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.recompute();
  }

  private recompute(): void {
    const doc = this.view.state.doc;
    this.runTargets = computePythonRunTargets(doc);

    const breakpointLines = new Set(this.options.breakpointLines);
    const markerBuilder = new RangeSetBuilder<GutterMarker>();
    const markAt = (line: number, marker: GutterMarker) => {
      if (line < 1 || line > doc.lines) return;
      markerBuilder.add(doc.line(line).from, doc.line(line).from, marker);
    };
    const decoratedLines: number[] = [];
    for (let line = 1; line <= doc.lines; line += 1) {
      if (breakpointLines.has(line)) markAt(line, new BreakpointMarker(this.options.labels.breakpoint));
      const target = this.runTargets.get(line);
      if (target != null) {
        markAt(line, new RunMarker(target, target.kind === 'test' ? this.options.labels.runTest : this.options.labels.runScript));
      }
      if (this.options.executionLine === line) decoratedLines.push(line);
    }
    this.markers = markerBuilder.finish();

    this.decorations = Decoration.set(decoratedLines.map((line) => Decoration.line({
      class: 'cm-pydbg-stop-line',
    }).range(doc.line(line).from)), true);
  }
}

const makePlugin = (options: PythonDebugGutterOptions) => ViewPlugin.define(
  (view) => new PythonDebugGutterPlugin(view, options),
  { decorations: (plugin) => plugin.decorations },
);

/**
 * The gutter plus the stopped-line stripe. Feed it fresh options whenever the
 * debugger state moves; the host reconfigures the extension as a unit.
 */
export const pythonDebugGutter = (options: PythonDebugGutterOptions): Extension => {
  const plugin = makePlugin(options);
  return [
    plugin,
    gutter({
      class: 'cm-pydbg-gutter',
      markers: (view) => view.plugin(plugin)?.markers ?? new RangeSetBuilder<GutterMarker>().finish(),
      renderEmptyElements: true,
      domEventHandlers: {
        mousedown: (view, line, event) => {
          const element = event.target;
          const lineNumber = view.state.doc.lineAt(line.from).number;
          const target = view.plugin(plugin)?.runTargets.get(lineNumber) ?? null;
          if (element instanceof HTMLElement && element.closest('.cm-pydbg-run') != null) {
            if (target != null) {
              options.onRun(target, lineNumber);
              return true;
            }
            return false;
          }
          options.onToggleBreakpoint(lineNumber);
          return true;
        },
      },
    }),
    EditorView.theme({
      '.cm-pydbg-gutter': { width: '18px' },
      '.cm-pydbg-gutter .cm-gutterElement': { position: 'relative', cursor: 'pointer' },
      '.cm-pydbg-breakpoint': {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '10px',
        height: '10px',
        borderRadius: '50%',
        backgroundColor: 'var(--status-error)',
      },
      '.cm-pydbg-run': {
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '0',
        height: '0',
        borderTop: '5px solid transparent',
        borderBottom: '5px solid transparent',
        borderLeft: '8px solid var(--status-success)',
      },
      '.cm-pydbg-run-script': { borderLeftColor: 'var(--status-info)' },
      '.cm-pydbg-stop-line': { backgroundColor: 'color-mix(in srgb, var(--status-warning) 16%, transparent)' },
    }),
  ];
};
