/**
 * The `openchamber_contacts` managed tool's static surface: the action
 * grammar, the parameter schema, and the action resolver.
 *
 * The tool is the delegation half of the contacts list (the assistants
 * store): one action starts a task — a fork of the calling conversation
 * that inherits its context — and one action waits for the answer. A
 * contact is named, never addressed by id: the user says the name in chat,
 * and the agent passes it through.
 */

import { isString } from '../shared/guards.js';

export const CONTACT_ACTION_DEFINITIONS = Object.freeze([
  { action: 'contact.list', title: 'List the saved contacts', description: 'Every contact with its name, what it is for, model and agent. No parameters' },
  { action: 'contact.run', title: 'Start a task with a contact', description: 'Forks the calling conversation into a child the contact answers in — the child inherits this dialog\'s context — and dispatches the task. Returns at once: wait for the answer with contact.wait. Parameters: contact, task' },
  { action: 'contact.wait', title: 'Wait for the contact\'s answer', description: 'Waits until the child run\'s turn finishes and returns its answer text; timeoutMs in 1000-900000, default 300000, on timeout returns the run state it reached. Resolves inside one call. Parameters: sessionID, timeoutMs' },
]);

export const CONTACT_ACTIONS = Object.freeze(CONTACT_ACTION_DEFINITIONS.map(({ action }) => action));

const CONTACT_ACTION_NAMES = new Set(CONTACT_ACTIONS);

export const CONTACT_PARAMETER_PROPERTIES = Object.freeze({
  contact: { type: 'string', description: 'contact.run: the contact\'s name, as contact.list shows it' },
  task: { type: 'string', description: 'contact.run: the task for the contact, plain text, 1 to 40000 characters' },
  sessionID: { type: 'string', description: 'contact.wait: the session id contact.run returned' },
  timeoutMs: { type: 'number', description: 'contact.wait: the wait window in milliseconds, 1000-900000, default 300000' },
});

/**
 * One requested action against the grammar. Everything that is not an
 * action answers by naming what is — a bare "unsupported" leaves the
 * agent to guess a second wrong name.
 */
export const resolveContactAction = (requested) => {
  const action = isString(requested) ? requested.trim().toLowerCase() : '';
  if (CONTACT_ACTION_NAMES.has(action)) return { action };
  return { error: `Unknown contact action: ${action || 'missing'}. Actions: ${CONTACT_ACTIONS.join(', ')}` };
};

const WAIT_TIMEOUT_MIN_MS = 1_000;
const WAIT_TIMEOUT_MAX_MS = 900_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_500;
const TASK_MAX_LENGTH = 40_000;
const ANSWER_PAGE_LIMIT = 100;

export const contactWaitBounds = {
  min: WAIT_TIMEOUT_MIN_MS,
  max: WAIT_TIMEOUT_MAX_MS,
  default: DEFAULT_WAIT_TIMEOUT_MS,
};

export const contactRunBounds = {
  pollInterval: POLL_INTERVAL_MS,
  taskMax: TASK_MAX_LENGTH,
  answerPage: ANSWER_PAGE_LIMIT,
};
