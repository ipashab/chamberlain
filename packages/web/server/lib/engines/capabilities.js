/**
 * Engine capability vocabulary: a closed, versioned set of ids an engine
 * descriptor may declare.
 *
 * The onboarding contract is "the engine declares what it can do, the UI
 * degrades by capability", which only works when both sides share one fixed
 * vocabulary — otherwise every engine invents its own strings and neither
 * the chat-surface gate nor a degradation note can be answered.
 *
 * Versioning: adding a capability is additive (older surfaces ignore ids
 * they do not know); changing what an id *means* bumps apiVersion. Same
 * shape as the guests' `openchamber.apiVersion`.
 *
 * Deliberately set arithmetic only, no type checks: the descriptor schema
 * (descriptor.js) parses at the I/O boundary, so this code receives a string
 * array already.
 */

import { z } from 'zod';

export const ENGINE_CAPABILITIES_API_VERSION = 1;

/**
 * The full vocabulary. Membership rule: an id belongs here only when it
 * changes a UI rendering or interaction branch. Purely internal backend
 * concepts (an engine's storage format, say) stay out.
 */
export const ENGINE_CAPABILITY_IDS = Object.freeze([
  'sessions',    // session CRUD (list, create, delete, archive)
  'streaming',   // token-by-token streaming, including event streams
  'parts',       // message parts (text/reasoning/tool calls are structured, not one blob)
  'tools',       // tool calls are visible (rendering "running which command")
  'permissions', // permission asks and answers (the agent stops to ask)
  'questions',   // asking the user (separate from permissions: consent vs content)
  'todos',       // the task checklist
  'providers',  // model providers and credentials
  'agents',      // agent definitions
  'mcp',         // MCP server configuration and status
  'skills',      // the skills catalog
  'commands',    // custom commands
  'diffs',       // file changes and snapshots (diff view, rollback)
  'attachments', // files uploaded into a session
  'projects',    // project and directory context
]);

const CAPABILITY_SET = new Set(ENGINE_CAPABILITY_IDS);

/** The declared list inside a descriptor must be an array of strings. */
export const engineCapabilitiesSchema = z.array(z.string());

/**
 * The minimum required to serve the main chat surface.
 *
 * Exactly these two: able to create sessions and able to stream. Everything
 * else missing is a degradation (hide the matching panel), not "unusable".
 * Set the bar higher and no second engine ever qualifies; set it lower and
 * the chat surface renders blanks.
 */
export const REQUIRED_FOR_CHAT = Object.freeze(['sessions', 'streaming']);

export const isKnownEngineCapability = (id) => CAPABILITY_SET.has(id);

/**
 * Split a declared list into known and unknown ids.
 *
 * Unknown ids are dropped but reported, silently neither failing nor
 * vanishing: failing would keep a newer engine's descriptor off an older
 * host (the worst compatibility story there is), while silence would turn
 * a mistyped `streamingg` into "this engine mysteriously cannot chat".
 */
export const splitEngineCapabilities = (list = []) => {
  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const id of list) {
    // Empty ids are skipped without counting as unknown: an empty string is
    // not a mistyped capability.
    if (!id) continue;
    if (!CAPABILITY_SET.has(id)) {
      if (!unknown.includes(id)) unknown.push(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    known.push(id);
  }
  return { known, unknown };
};

/** Whether this capability set qualifies for the main chat surface. */
export const canServeChat = (capabilities = []) => (
  REQUIRED_FOR_CHAT.every((id) => capabilities.includes(id))
);

/** Which required capabilities are missing, for a reason the UI can show. */
export const missingForChat = (capabilities = []) => (
  REQUIRED_FOR_CHAT.filter((id) => !capabilities.includes(id))
);
