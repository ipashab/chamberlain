/**
 * Engine registry: reads `*.json` descriptors from OC_ENGINES_DIR into a
 * descriptor list and decides which engine is active right now.
 *
 * Why a directory and not an array inside a config file: onboarding an
 * engine should be "drop one file, start one service", never "edit the
 * host's config" — that is where "my change collides with the host's
 * change" is born. One directory, one file per engine; deleting the file
 * removes the engine, and no host restart is needed (every registry read
 * re-reads the directory; see the caches in index.js).
 *
 * The built-in opencode descriptor is ALWAYS in the list unless overridden
 * by a file with the same id: upgrading to this version is zero behavior
 * change for existing deployments.
 */

import { z } from 'zod';
import { hasProperties } from '../shared/guards.js';
import { BUILTIN_OPENCODE_DESCRIPTOR, parseEngineDescriptor } from './descriptor.js';
import type { EngineDescriptor } from './descriptor.js';

export const DEFAULT_ENGINES_DIR = '/etc/oc-engines';

/** String hygiene at the I/O boundary — env vars, settings and file names pass through here. */
export const asNonEmptyString = (value: unknown): string => {
  const parsed = z.string().trim().min(1).safeParse(value);
  return parsed.success ? parsed.data : '';
};

const isJsonFile = (name: string) => String(name).toLowerCase().endsWith('.json');

/** `error.code`, затем `error.message`, затем сам error — как раньше читал шаблон. */
const codeOrMessageOrError = (error: unknown): string => {
  const props = hasProperties(error) ? error : null;
  return String(props?.code ?? props?.message ?? error);
};

/** Только `error.message`, затем сам error. */
const messageOrError = (error: unknown): string => {
  const props = hasProperties(error) ? error : null;
  return String(props?.message ?? error);
};

export interface EngineRegistryLoaderOptions {
  dir?: unknown;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  logger?: Pick<Console, 'warn'>;
}

export interface EngineRegistry {
  descriptors: EngineDescriptor[];
  warnings: string[];
  dir: string;
  dirReadable: boolean;
}

/**
 * Load the descriptors from a directory.
 *
 * Fault tolerance: one broken file must not fail the whole registry — a
 * bad file warns and is skipped, the rest keep working. A mistyped
 * `codex.json` should not take the entire workbench down.
 *
 * @returns {Promise<{ descriptors: object[], warnings: string[], dir: string, dirReadable: boolean }>}
 */
export const loadEngineDescriptors = async ({ dir, readdir, readFile, logger = console }: EngineRegistryLoaderOptions): Promise<EngineRegistry> => {
  const warnings: string[] = [];
  const byId = new Map<string, EngineDescriptor>();

  // The builtin goes in first; a file may override it (explicit config
  // beats implicit default).
  byId.set(BUILTIN_OPENCODE_DESCRIPTOR.id, BUILTIN_OPENCODE_DESCRIPTOR);

  const targetDir = z.string().trim().min(1).catch(DEFAULT_ENGINES_DIR).parse(dir);
  let names: string[] = [];
  let dirReadable = false;
  try {
    names = await readdir(targetDir);
    dirReadable = true;
  } catch (error) {
    // A missing directory is a NORMAL state (no external engines
    // configured), not an error.
    const props = hasProperties(error) ? error : null;
    if (props?.code !== 'ENOENT') {
      const detail = `Cannot read engine directory ${targetDir}: ${codeOrMessageOrError(error)}`;
      warnings.push(detail);
      logger.warn?.(`[engines] ${detail}`);
    }
    return { descriptors: [...byId.values()], warnings, dir: targetDir, dirReadable };
  }

  for (const name of [...names].filter(isJsonFile).sort()) {
    const file = `${targetDir}/${name}`;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      warnings.push(`${name}: unreadable (${codeOrMessageOrError(error)})`);
      continue;
    }
    try {
      const { descriptor, warnings: fileWarnings } = parseEngineDescriptor(String(text), { source: file });
      for (const w of fileWarnings) warnings.push(`${name}: ${w}`);
      const previous = byId.get(descriptor.id);
      if (previous && previous.builtin !== true) {
        // Two files fighting over one id: the first (sorted) file wins, the
        // later one is skipped and reported. Neither silent nor last-wins —
        // nobody could predict either.
        warnings.push(`${name}: id=${descriptor.id} is already defined by ${previous.source ?? 'an earlier file'}; this file is skipped`);
        continue;
      }
      if (previous) {
        warnings.push(`${name}: overrides the built-in engine ${descriptor.id} (explicit config beats implicit default)`);
      }
      byId.set(descriptor.id, descriptor);
    } catch (error) {
      warnings.push(`${name}: ${messageOrError(error)}`);
      logger.warn?.(`[engines] skipping ${file}: ${messageOrError(error)}`);
    }
  }

  const descriptors = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { descriptors, warnings, dir: targetDir, dirReadable };
};

/**
 * Decide which engine is active.
 *
 * Priority: an explicit request (OC_ENGINE) → the single descriptor when
 * there is exactly one → the built-in opencode.
 *
 * Why "the only one wins": that matches "I dropped an engine in, so it is
 * the engine" — and NOT defaulting to the first file, because with two
 * engines present, alphabetical order must never decide who serves.
 */
export interface ResolveActiveEngineInput {
  descriptors?: readonly EngineDescriptor[];
  requestedId?: unknown;
  env?: NodeJS.ProcessEnv | undefined;
}

export const resolveActiveEngine = ({ descriptors, requestedId, env }: ResolveActiveEngineInput = {}): { engine: EngineDescriptor; reason: string } => {
  const list = descriptors ?? [];
  const wanted = [requestedId, env?.OC_ENGINE].map(asNonEmptyString).filter(Boolean);

  for (const id of wanted) {
    const hit = list.find((d) => d.id === id);
    if (hit) return { engine: hit, reason: 'requested' };
  }

  const nonBuiltin = list.filter((d) => d.builtin !== true);
  const [only] = list;
  if (list.length === 1 && only) return { engine: only, reason: 'only-one' };
  if (nonBuiltin.length === 1 && list.length === 2) {
    // Built-in opencode plus exactly one external engine: still the builtin
    // (no guessing), and the reason says so.
    return { engine: BUILTIN_OPENCODE_DESCRIPTOR, reason: 'builtin-default-with-alternatives' };
  }
  return { engine: BUILTIN_OPENCODE_DESCRIPTOR, reason: 'builtin-default' };
};
