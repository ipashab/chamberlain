/**
 * The `openchamber_backlog` managed tool's static surface: the action
 * grammar, the parameter schema, and the action resolver.
 *
 * The backlog is the caller session's own staged follow-ups — prompts the
 * user asked to be queued in this dialog without being run yet. The tool
 * reads and runs the queue the session it is called in owns, so every
 * action works from that session and takes no session id.
 */

import { isString } from '../shared/guards.js';

export const BACKLOG_ACTION_DEFINITIONS = Object.freeze([
  { action: 'backlog.list', title: 'Read the session\'s staged items', description: 'The backlog of this dialog: every staged item in run order, oldest first. No parameters' },
  { action: 'backlog.add', title: 'Stage a follow-up', description: 'Adds an item to the back of the queue without running it; the drain runs items later, one turn each. Parameters: text' },
  { action: 'backlog.remove', title: 'Take one item out', description: 'Takes one staged item out of the queue. Parameters: itemID, as backlog.list shows it' },
  { action: 'backlog.clear', title: 'Drop every staged item', description: 'Drops every staged item of this dialog\'s backlog. No parameters' },
  { action: 'backlog.run', title: 'Run the queue', description: 'Starts the drain: each staged item is sent into this dialog as its own turn, in order, the next only after the previous turn ends. The current turn finishes first. Returns at once. No parameters' },
]);

export const BACKLOG_ACTIONS = Object.freeze(BACKLOG_ACTION_DEFINITIONS.map(({ action }) => action));

const BACKLOG_ACTION_NAMES = new Set(BACKLOG_ACTIONS);

export const BACKLOG_PARAMETER_PROPERTIES = Object.freeze({
  text: { type: 'string', description: 'backlog.add: the prompt to stage, 1 to 40000 characters' },
  itemID: { type: 'string', description: 'backlog.remove: the staged item\'s id, as backlog.list shows it' },
});

/**
 * One requested action against the grammar. Everything that is not an
 * action answers by naming what is — a bare "unsupported" leaves the
 * agent to guess a second wrong name.
 */
export const resolveBacklogAction = (requested) => {
  const action = isString(requested) ? requested.trim().toLowerCase() : '';
  if (BACKLOG_ACTION_NAMES.has(action)) return { action };
  return { error: `Unknown backlog action: ${action || 'missing'}. Actions: ${BACKLOG_ACTIONS.join(', ')}` };
};

const DRAIN_POLL_INTERVAL_MS = 1_500;

export const backlogDrainBounds = Object.freeze({
  // The window that waits for the caller's own turn to end before the first
  // item is sent — a drain started from a tool call runs inside that turn.
  firstIdleWindowMs: 30 * 60 * 1000,
  // The window one staged item's turn may run before the drain gives up on
  // it and leaves the rest of the queue staged, honest about what ran.
  itemRunWindowMs: 60 * 60 * 1000,
  pollIntervalMs: DRAIN_POLL_INTERVAL_MS,
  answerPage: 200,
});
