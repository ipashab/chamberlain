/**
 * Parsing and validation of engine descriptors (`engine.json`).
 *
 * This is the one contract behind "add an agent engine any day": onboarding
 * an engine means dropping a descriptor into OC_ENGINES_DIR and running its
 * adapter service — no application code changes.
 *
 * Validation parses once at the I/O boundary with zod (the same pattern as
 * lib/guests and the theme catalog): error messages carry field paths, and
 * everything downstream handles a formed domain object with no per-use type
 * checks.
 *
 * Three deliberate calls:
 *   · unknown *capabilities* are dropped with a warning (forward
 *     compatibility, see capabilities.js);
 *   · unknown *protocols* are rejected outright — the host has no idea how
 *     to drive them, and a "visible but unclickable" engine helps nobody;
 *   · unknown *fields* are ignored (`.passthrough()`, matching guests'
 *     "extra keys drop, not forward").
 */

import { z } from 'zod';
import {
  ENGINE_CAPABILITIES_API_VERSION,
  ENGINE_CAPABILITY_IDS,
  canServeChat,
  engineCapabilitiesSchema,
  missingForChat,
  splitEngineCapabilities,
} from './capabilities.js';

const ENGINE_DESCRIPTOR_API_VERSION = 1;

/** Protocols the host can actually drive. Adding one means adding driver code. */
const ENGINE_PROTOCOLS = Object.freeze(['opencode-v1', 'guest-panel']);

/** Presentation: chat = joins the main chat surface; panel = surfaces in a panel only. */
const ENGINE_SURFACES = Object.freeze(['chat', 'panel']);

export class EngineDescriptorError extends Error {
  constructor(message, { code = 'INVALID_ENGINE_DESCRIPTOR', source = null } = {}) {
    super(message);
    this.name = 'EngineDescriptorError';
    this.code = code;
    this.source = source;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

const nonEmpty = () => z.string().trim().min(1);

const descriptorSchema = z.object({
  apiVersion: z.literal(ENGINE_DESCRIPTOR_API_VERSION),
  id: z.string().trim().regex(ID_PATTERN, 'id must be kebab-case (lowercase letters, digits, hyphens)'),
  name: nonEmpty().optional(),
  protocol: z.enum(ENGINE_PROTOCOLS),
  surface: z.enum(ENGINE_SURFACES).optional(),
  endpoint: z.object({
    healthPath: z.string().trim().startsWith('/', 'healthPath must start with /').optional(),
    // This engine's OWN address. Absent = use the host's single engine address
    // (backwards compatible: that is how the built-in opencode works). With
    // several engines alongside it MUST be set, or probes cannot tell who
    // answered what.
    url: z.string().trim().url('endpoint.url must be a full URL (e.g. http://codex-engine:4096)')
      .refine((value) => /^https?:\/\//i.test(value), 'endpoint.url supports http / https only')
      .optional(),
  }).passthrough().optional(),
  auth: z.object({
    type: z.enum(['none', 'basic']).optional(),
    username: nonEmpty().optional(),
    passwordEnv: nonEmpty().optional(),
  }).passthrough().optional(),
  versionProbe: z.object({
    path: z.string().trim().optional(),
    field: z.string().trim().optional(),
  }).passthrough().optional(),
  capabilities: engineCapabilitiesSchema.optional(),
}).passthrough();

/**
 * The built-in opencode descriptor.
 *
 * The fallback when the descriptor directory has nothing to say, and the
 * only engine that works without a file — so upgrading to this version
 * changes nothing for existing deployments. One engine descriptor below has
 * a hard requirement of behavior preservation: seaming engines in must be
 * behavior-neutral while no descriptor directory is configured.
 */
export const BUILTIN_OPENCODE_DESCRIPTOR = Object.freeze({
  apiVersion: ENGINE_DESCRIPTOR_API_VERSION,
  id: 'opencode',
  name: 'OpenCode',
  protocol: 'opencode-v1',
  surface: 'chat',
  builtin: true,
  endpoint: Object.freeze({ healthPath: '/global/health' }),
  auth: Object.freeze({ type: 'basic', username: 'opencode', passwordEnv: 'OPENCODE_SERVER_PASSWORD' }),
  versionProbe: Object.freeze({ path: '/global/health', field: 'version' }),
  capabilities: Object.freeze([
    'sessions', 'streaming', 'parts', 'tools', 'permissions', 'questions', 'todos',
    'providers', 'agents', 'mcp', 'skills', 'commands', 'diffs', 'attachments', 'projects',
  ]),
});

/** zod issues → one readable line per field path, so "what is wrong" is not a guess. */
const formatIssues = (issues) => issues
  .map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  })
  .join('; ');

/**
 * Validate and normalize one descriptor.
 *
 * @returns {{ descriptor: object, warnings: string[] }}
 * @throws {EngineDescriptorError}
 */
export const normalizeEngineDescriptor = (raw, { source = null } = {}) => {
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineDescriptorError(formatIssues(parsed.error.issues), { source });
  }
  const value = parsed.data;

  if (value.protocol === 'opencode-v1' && !value.endpoint?.healthPath) {
    throw new EngineDescriptorError(
      'opencode-v1 requires endpoint.healthPath (the host probes it for liveness)',
      { code: 'MISSING_HEALTH_PATH', source },
    );
  }

  const warnings = [];
  const { known: capabilities, unknown: unknownCapabilities } = splitEngineCapabilities(value.capabilities ?? []);
  if (unknownCapabilities.length > 0) {
    warnings.push(
      `Unknown capabilities ignored: ${unknownCapabilities.join(', ')} (the host vocabulary lives in capabilities.js; known ids: ${ENGINE_CAPABILITY_IDS.join(', ')})`,
    );
  }
  if (!value.capabilities) {
    warnings.push('No capabilities declared — treated as "cannot serve the chat surface"');
  }

  // Default surface follows the declared capabilities, so a descriptor cannot
  // contradict itself: chat-capable engines join the chat surface, the rest
  // stay panel-only.
  const surface = value.surface ?? (canServeChat(capabilities) ? 'chat' : 'panel');
  if (surface === 'chat' && !canServeChat(capabilities)) {
    warnings.push(
      `surface=chat declared but ${missingForChat(capabilities).join(', ')} missing — the UI still renders it as a panel (the verdict walks capabilities, not surface)`,
    );
  }

  const auth = value.auth?.type === 'basic'
    ? { type: 'basic', username: value.auth.username ?? 'opencode', passwordEnv: value.auth.passwordEnv ?? 'OPENCODE_SERVER_PASSWORD' }
    : { type: 'none' };

  const versionProbe = {};
  if (value.versionProbe?.path) versionProbe.path = value.versionProbe.path;
  if (value.versionProbe?.field) versionProbe.field = value.versionProbe.field;

  const descriptor = {
    apiVersion: ENGINE_DESCRIPTOR_API_VERSION,
    id: value.id,
    name: value.name ?? value.id,
    protocol: value.protocol,
    surface,
    builtin: false,
    source,
    auth,
    capabilities,
    capabilitiesApiVersion: ENGINE_CAPABILITIES_API_VERSION,
  };
  // Present-when-present fields are assigned explicitly, not conditionally
  // spread — the latter hides "the field is absent" inside an empty object.
  if (value.endpoint?.healthPath || value.endpoint?.url) {
    descriptor.endpoint = {};
    if (value.endpoint.healthPath) descriptor.endpoint.healthPath = value.endpoint.healthPath;
    if (value.endpoint.url) descriptor.endpoint.url = value.endpoint.url.replace(/\/+$/, '');
  }
  if (Object.keys(versionProbe).length > 0) descriptor.versionProbe = versionProbe;

  return { descriptor: Object.freeze(descriptor), warnings };
};

/** Parse descriptor text from disk (JSON syntax errors carry the file name). */
export const parseEngineDescriptor = (text, { source = null } = {}) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EngineDescriptorError(`Not valid JSON: ${error?.message ?? error}`, { code: 'INVALID_JSON', source });
  }
  return normalizeEngineDescriptor(raw, { source });
};

/** The public shape for API/UI consumers. */
export const describeEngineForApi = (descriptor) => {
  const capabilities = descriptor.capabilities ?? [];
  const api = {
    id: descriptor.id,
    name: descriptor.name,
    protocol: descriptor.protocol,
    surface: descriptor.surface,
    builtin: descriptor.builtin === true,
    source: descriptor.source ?? null,
    capabilities: [...capabilities],
    capabilitiesApiVersion: descriptor.capabilitiesApiVersion ?? ENGINE_CAPABILITIES_API_VERSION,
    canServeChat: canServeChat(capabilities),
    missingForChat: missingForChat(capabilities),
    healthPath: descriptor.endpoint?.healthPath ?? null,
    endpointUrl: descriptor.endpoint?.url ?? null,
    authType: descriptor.auth?.type ?? 'none',
  };
  if (descriptor.versionProbe) api.versionProbe = { ...descriptor.versionProbe };
  return api;
};
