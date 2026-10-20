import { asNonEmptyString } from '../shared/guards.js';
import { contactRunBounds, contactWaitBounds } from './tools.js';

/**
 * Contact delegation: the `openchamber_contacts` tool's executor.
 *
 * A contact is one saved assistant (the contacts list in the UI, the
 * assistants store on disk). `contact.run` hands the contact a task by
 * forking the calling conversation: the child inherits the dialog's context —
 * an audit needs what was said and written before it — runs with the
 * contact's own model and agent, and receives the contact's persona heading
 * the task. The run returns at once; `contact.wait` resolves inside one call
 * by watching the child's records, never its clock: the turn is finished
 * when a new `idle` record stands beyond the baselines the fork handed back.
 *
 * Runs live only as long as the server process. A restarted server answers
 * `contact.wait` honestly — the baselines that mark the fork's boundary are
 * gone, and guessing them could read the copied history as an answer.
 */

export class ContactRunError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.name = 'ContactRunError';
    this.statusCode = statusCode;
    this.details = details ?? null;
  }
}

const delay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const isAssistantAnswer = (record) => record?.type === 'assistant'
  && Number.isFinite(record?.time?.completed)
  && Array.isArray(record?.content)
  && record.content.some((part) => part?.type === 'text' && asNonEmptyString(part.text));

const assistantText = (record) => record.content
  .filter((part) => part?.type === 'text' && asNonEmptyString(part.text))
  .map((part) => part.text)
  .join('')
  .trim();

export const createContactRunService = (dependencies) => {
  const {
    listContacts,
    forkSession,
    createOpenCodeClient,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    now = Date.now,
  } = dependencies;

  if (!listContacts || !forkSession) {
    throw new Error('contact-run service needs a contacts list and a session fork');
  }

  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  const readContacts = async () => {
    const contacts = await listContacts();
    return Array.isArray(contacts) ? contacts : [];
  };

  const namedContactNames = (contacts) => contacts
    .map((contact) => asNonEmptyString(contact?.name))
    .filter(Boolean)
    .join(', ');

  /** Exact name first, then a unique fragment — a typo should still resolve. */
  const findContact = async (requested) => {
    const name = asNonEmptyString(requested);
    if (!name) throw new ContactRunError(`contact is required: name it as contact.list shows it (saved contacts: ${namedContactNames(await readContacts()) || 'none'})`, 400);
    const contacts = await readContacts();
    const exact = contacts.find((contact) => asNonEmptyString(contact?.name).toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    const fragment = name.toLowerCase();
    const matches = contacts.filter((contact) => asNonEmptyString(contact?.name).toLowerCase().includes(fragment));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ContactRunError(`"${name}" answers to several contacts: pick one of ${matches.map((contact) => contact.name).join(', ')}`, 400);
    }
    throw new ContactRunError(`No saved contact answers to "${name}"; saved contacts: ${namedContactNames(contacts) || 'none'}`, 404);
  };

  const composeTaskPrompt = (contact, task) => {
    const persona = asNonEmptyString(contact?.prompt);
    return persona ? `${persona}\n\nThe task:\n${task}` : task;
  };

  /**
   * @type {Map<string, object>} sessionID -> the fork's baselines.
   */
  const runs = new Map();

  /**
   * The child session's newest records, newest first. The window tells the
   * truth whatever the turn's size: the records after the fork's baselines
   * are either all of the turn's (a turn larger than the window crowds the
   * baselines out of it) or a prefix of them ending at a baseline row.
   */
  const readTurnWindow = async (run, sessionID) => {
    const page = await clientFor(run.directory).message.list({
      sessionID,
      limit: contactRunBounds.answerPage,
      order: 'desc',
    });
    const rows = Array.isArray(page?.data) ? page.data : [];
    const after = [];
    for (const row of rows) {
      const id = asNonEmptyString(row?.id);
      if (!id) continue;
      if (run.baselineAssistantMessageId === id || run.baselineIdleRecordId === id) break;
      after.push(row);
    }
    return after;
  };

  /**
   * The wait mirrors the debugger's: one call resolves — poll the child's
   * records until its turn's `idle` row appears, then report the answer.
   * On timeout the run goes on, and calling again keeps waiting.
   */
  const waitForAnswer = async (run, sessionID, requestedTimeoutMs) => {
    const raw = Number(requestedTimeoutMs);
    const timeoutMs = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(Math.trunc(raw), contactWaitBounds.min), contactWaitBounds.max)
      : contactWaitBounds.default;
    const deadline = now() + timeoutMs;
    for (;;) {
      const window = await readTurnWindow(run, sessionID);
      const idleRow = window.find((row) => row?.type === 'idle');
      if (idleRow != null) {
        const answerRow = window.find(isAssistantAnswer);
        const answer = answerRow ? assistantText(answerRow) : '';
        const outcome = asNonEmptyString(idleRow?.outcome) || 'succeeded';
        return {
          done: true,
          contact: run.contact,
          outcome,
          ...(answer
            ? { answer }
            : { answer: null, note: outcome === 'succeeded'
              ? 'The contact finished its turn without an answer text'
              : 'The contact aborted its turn before answering' }),
        };
      }
      if (now() >= deadline) {
        return {
          done: false,
          waited: 'timeout',
          contact: run.contact,
          note: 'The contact run is still going; call contact.wait again to keep waiting',
        };
      }
      await delay(contactRunBounds.pollInterval);
    }
  };

  const listAction = async () => {
    const contacts = await readContacts();
    // Each entry grows statement by statement: a field the contact does not
    // carry stays absent from its listing.
    const listing = {
      contacts: contacts.map((contact) => {
        const entry = { name: asNonEmptyString(contact?.name) };
        if (asNonEmptyString(contact?.description)) entry.description = contact.description;
        if (asNonEmptyString(contact?.model)) entry.model = contact.model;
        if (asNonEmptyString(contact?.agent)) entry.agent = contact.agent;
        if (asNonEmptyString(contact?.directory)) entry.directory = contact.directory;
        return entry;
      }),
    };
    if (contacts.length === 0) listing.note = 'No saved contacts yet; the user creates them in the Contacts list';
    return listing;
  };

  const runAction = async (input) => {
    const callerSessionID = asNonEmptyString(input?.callerSessionID);
    if (!callerSessionID) {
      throw new ContactRunError('contact.run works from a session: it forks the conversation it is called in', 400);
    }
    const task = asNonEmptyString(input?.task);
    if (!task) throw new ContactRunError('task is required: what the contact should do, 1 to 40000 characters', 400);
    if (task.length > contactRunBounds.taskMax) {
      throw new ContactRunError(`task is ${task.length} characters; keep it within ${contactRunBounds.taskMax}`, 400);
    }
    const contact = await findContact(input?.contact);
    // The fork payload grows statement by statement: a contact without its
    // own model or agent keeps the session's, so the key stays absent.
    const forkPayload = { prompt: composeTaskPrompt(contact, task) };
    if (asNonEmptyString(contact.model)) forkPayload.model = contact.model;
    if (asNonEmptyString(contact.agent)) forkPayload.agent = contact.agent;
    const result = await forkSession(callerSessionID, forkPayload);
    const childSessionID = asNonEmptyString(result?.sessionId);
    if (!childSessionID) {
      throw new ContactRunError('The contact fork reported no session id', 502);
    }
    const childDirectory = asNonEmptyString(result?.directory);
    if (asNonEmptyString(result?.promptError)) {
      throw new ContactRunError(`The contact's session was created but the prompt did not reach it: ${result.promptError}`, 502, { sessionID: childSessionID, directory: childDirectory });
    }
    runs.set(childSessionID, {
      directory: childDirectory,
      contact: asNonEmptyString(contact.name),
      startedAt: now(),
      baselineAssistantMessageId: asNonEmptyString(result?.baselineAssistantMessageId) || null,
      baselineIdleRecordId: asNonEmptyString(result?.baselineIdleRecordId) || null,
      callerSessionID,
    });
    // The answer grows statement by statement: what the fork did not report
    // stays absent from it.
    const runAnswer = {
      sessionID: childSessionID,
      contact: contact.name,
      note: 'The contact answers in the child session; wait for its answer with contact.wait',
    };
    if (childDirectory) runAnswer.directory = childDirectory;
    if (asNonEmptyString(result?.model)) runAnswer.model = result.model;
    if (asNonEmptyString(result?.agent)) runAnswer.agent = result.agent;
    return runAnswer;
  };

  const waitAction = async (input) => {
    const sessionID = asNonEmptyString(input?.sessionID);
    if (!sessionID) throw new ContactRunError('sessionID is required: the child session id contact.run returned', 400);
    const run = runs.get(sessionID);
    if (!run) {
      throw new ContactRunError(`No contact run answers to session ${sessionID}; runs live only as long as the server — after a restart, start another with contact.run`, 404);
    }
    return waitForAnswer(run, sessionID, input?.timeoutMs);
  };

  return {
    executeAction: async (action, input = {}) => {
      switch (action) {
        case 'contact.list':
          return listAction();
        case 'contact.run':
          return runAction(input);
        case 'contact.wait':
          return waitAction(input);
        default:
          throw new ContactRunError(`Unknown contact action: ${action || 'missing'}`, 400);
      }
    },
  };
};
