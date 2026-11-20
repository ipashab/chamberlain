import { z } from 'zod';

import type { SessionPayload, createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import { isRecord } from '../shared/guards.js';

/**
 * Assistants as contacts: named personas the user chats with like people.
 *
 * A contact is a saved assistant — a name, a one-line description and the
 * persona prompt that opens its chat. Opening a contact continues one
 * continuing thread: the first open creates a session and hands it the
 * persona as its opening message, every later open jumps back into that
 * same session while it still exists. The contact outlives the session: if
 * the session is gone, the next open starts a fresh thread for the contact.
 *
 * The contact itself is just state — a list persisted to assistants.json
 * beside teams.json and missions.json. No queue, no watch: the chat is an
 * ordinary session and the user steers it from the conversation itself.
 */

const STATE_FILE_NAME = 'assistants.json';
const PERSIST_DEBOUNCE_MS = 500;
const MAX_ASSISTANTS = 50;

class AssistantError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** A contact as the service stores it; hand-edited state files may omit fields. */
export interface StoredAssistant {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  prompt?: string | null | undefined;
  model?: string | null | undefined;
  agent?: string | null | undefined;
  directory?: string | undefined;
  lastSessionId?: string | null | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
}

const nonEmptyTextSchema = z.string().trim().min(1);
const asNonEmptyString = (value: unknown): string | null => {
  const parsed = nonEmptyTextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const asList = (value: unknown) => (Array.isArray(value) ? value : []);

const assistantNameSchema = z.string().trim().min(1).max(80);
const assistantDescriptionSchema = z.string().trim().max(500);
const assistantPromptSchema = z.string().trim().min(1).max(20_000);
const assistantModelSchema = z.string().trim().regex(/^[^/]+\/[^/]+$/);
const assistantAgentSchema = z.string().trim().min(1).max(120);

interface OptionalField<Value> {
  present: boolean;
  value?: Value | null | undefined;
  invalid?: boolean | undefined;
}

/**
 * A field the request may carry, may omit, or may clear with null/''.
 * `present` distinguishes "the caller wants this changed" from "leave it".
 */
const optionalField = <Value>(value: unknown, schema: z.ZodType<Value>): OptionalField<Value> => {
  if (value === undefined) return { present: false, value: undefined };
  if (value === null || value === '') return { present: true, value: null };
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { present: true, invalid: true };
  return { present: true, value: parsed.data };
};

interface CreateInput {
  name: string;
  description: string;
  prompt: string;
  model: string | null;
  agent: string | null;
  directory: string;
}

/**
 * The create input parses whole at this boundary; the update input parses
 * only the fields the request carries. Both answer with every reason at
 * once so the form can show them together.
 */
const parseCreateInput = (input: unknown): CreateInput => {
  const record = isRecord(input) ? input : {};
  const errors: string[] = [];
  const name = assistantNameSchema.safeParse(record.name);
  if (!name.success) errors.push('name is required: at most 80 characters');
  const description = optionalField(record.description, assistantDescriptionSchema);
  if (description.invalid) errors.push('description is at most 500 characters');
  const prompt = assistantPromptSchema.safeParse(record.prompt);
  if (!prompt.success) errors.push('prompt is required: what this contact opens its chat with, at most 20,000 characters');
  const model = optionalField(record.model, assistantModelSchema);
  if (model.invalid) errors.push('model must look like provider/model');
  const agent = optionalField(record.agent, assistantAgentSchema);
  if (agent.invalid) errors.push('agent must be 1-120 characters');
  const directory = asNonEmptyString(record.directory);
  if (!directory) errors.push('directory is required: where this contact works');
  if (errors.length > 0) throw new AssistantError(errors.join('; '), 400);
  // The throw above is the only way here with a failed field behind.
  return {
    name: name.success ? name.data : '',
    description: description.value ?? '',
    prompt: prompt.success ? prompt.data : '',
    model: model.value ?? null,
    agent: agent.value ?? null,
    directory: directory ?? '',
  };
};

interface UpdatePatch {
  name?: string | undefined;
  description?: string | undefined;
  prompt?: string | null | undefined;
  model?: string | null | undefined;
  agent?: string | null | undefined;
  directory?: string | undefined;
}

const parseUpdateInput = (input: unknown): UpdatePatch => {
  const record = isRecord(input) ? input : {};
  const errors: string[] = [];
  const patch: UpdatePatch = {};
  if (record.name !== undefined) {
    const name = assistantNameSchema.safeParse(record.name);
    if (name.success) patch.name = name.data;
    else errors.push('name must be 1-80 characters');
  }
  const description = optionalField(record.description, assistantDescriptionSchema);
  if (description.invalid) errors.push('description is at most 500 characters');
  else if (description.present) patch.description = description.value ?? '';
  const prompt = optionalField(record.prompt, assistantPromptSchema);
  if (prompt.invalid) errors.push('prompt must be 1-20,000 characters');
  else if (prompt.present) patch.prompt = prompt.value;
  const model = optionalField(record.model, assistantModelSchema);
  if (model.invalid) errors.push('model must look like provider/model');
  else if (model.present) patch.model = model.value;
  const agent = optionalField(record.agent, assistantAgentSchema);
  if (agent.invalid) errors.push('agent must be 1-120 characters');
  else if (agent.present) patch.agent = agent.value;
  const directory = asNonEmptyString(record.directory);
  if (directory) patch.directory = directory;
  if (errors.length > 0) throw new AssistantError(errors.join('; '), 400);
  return patch;
};

const describeFailure = (error: unknown): unknown =>
  (isRecord(error) && 'message' in error ? error.message : undefined) ?? error;

/** The session-create payload the contact chat sends to OpenCode. */
export interface AssistantSessionCreateInput {
  title?: string | null | undefined;
  location?: { directory: string } | null | undefined;
  metadata?: { openchamber: { assistant: { id: string; version: number } } } | null | undefined;
  model?: { id: string; providerID: string } | null | undefined;
  agent?: string | null | undefined;
}

/** What the contact chat needs from the OpenCode client, test stubs included. */
export interface AssistantsContactClient {
  session: {
    create(input: AssistantSessionCreateInput): Promise<{ id?: unknown }>;
    get(input: unknown): Promise<{ id?: unknown; session?: { id?: unknown } }>;
  };
}

export interface AssistantsServiceDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'writeFile' | 'rename'>;
  path: Pick<typeof import('node:path'), 'join' | 'dirname'>;
  dataDir: string;
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: () => HeadersInit;
  waitForOpenCodeReady: (timeoutMs?: number, intervalMs?: number) => Promise<void>;
  createOpenCodeClient: (options: {
    baseUrl: string;
    headers: HeadersInit;
    directory: string | undefined;
  }) => AssistantsContactClient;
  sessionService: Pick<ReturnType<typeof createOpenChamberSessionService>, 'send'>;
  broadcastUiEvent?: ((event: {
    type: 'openchamber:assistant-changed';
    properties: { change: string; assistantId: string };
  }) => void) | null;
  now?: () => number;
}

export const createAssistantsService = (dependencies: AssistantsServiceDependencies) => {
  const {
    fsPromises,
    path,
    dataDir,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    createOpenCodeClient,
    sessionService,
    broadcastUiEvent = null,
    now = Date.now,
  } = dependencies;

  if (!sessionService?.send) {
    throw new Error('assistants service needs a session service with send()');
  }

  const stateFilePath = path.join(dataDir, STATE_FILE_NAME);
  const clientFor = (directory: string | undefined): AssistantsContactClient => createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  let assistants: StoredAssistant[] = [];
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let persistTimer: NodeJS.Timeout | null = null;

  const broadcast = (change: string, assistantId: string) => {
    if (!broadcastUiEvent) return;
    try {
      broadcastUiEvent({ type: 'openchamber:assistant-changed', properties: { change, assistantId } });
    } catch {
      // Best-effort, like every other state frame; the next one repairs it.
    }
  };

  const persist = async (): Promise<void> => {
    const payload = JSON.stringify({ assistants }, null, 2);
    await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
    const temporary = `${stateFilePath}.tmp`;
    await fsPromises.writeFile(temporary, payload, 'utf8');
    await fsPromises.rename(temporary, stateFilePath);
  };

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist().catch((error: unknown) =>
        console.warn('[assistants] could not persist state:', describeFailure(error)));
    }, PERSIST_DEBOUNCE_MS);
  };

  const load = async (): Promise<void> => {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = await fsPromises.readFile(stateFilePath, 'utf8');
          const parsed: unknown = JSON.parse(raw);
          const stored = isRecord(parsed) ? parsed : {};
          assistants = asList(stored.assistants).filter((entry) => asNonEmptyString(entry?.id));
        } catch (error) {
          if (!(isRecord(error) && error.code === 'ENOENT')) {
            console.warn('[assistants] could not load state, starting empty:', describeFailure(error));
          }
          assistants = [];
        }
        loaded = true;
      })();
    }
    await loadPromise;
  };

  const publicAssistant = (assistant: StoredAssistant) => ({ ...assistant });

  const findAssistant = (assistantId: unknown): StoredAssistant => {
    const id = asNonEmptyString(assistantId);
    if (!id) throw new AssistantError('assistantId is required', 400);
    const assistant = assistants.find((entry) => entry.id === id);
    if (!assistant) throw new AssistantError('No such assistant', 404);
    return assistant;
  };

  /**
   * The thread of a contact is its last session, reused while it exists.
   * The probe is a plain session read: an error or a missing body means the
   * session is gone (deleted, archived away from the runtime), and the next
   * open starts a fresh thread for the same contact.
   */
  const sessionStillExists = async (assistant: StoredAssistant): Promise<boolean> => {
    if (!assistant.lastSessionId) return false;
    try {
      const client = clientFor(assistant.directory);
      const session = await client.session.get(assistant.lastSessionId);
      return asNonEmptyString(session?.id ?? session?.session?.id) !== null;
    } catch {
      return false;
    }
  };

  const openChat = async (assistantId: unknown, input: unknown) => {
    await load();
    const assistant = findAssistant(assistantId);
    if (await sessionStillExists(assistant)) {
      broadcast('thread-reused', assistant.id);
      return { assistant: publicAssistant(assistant), sessionId: assistant.lastSessionId, created: false };
    }
    // A fresh chat for the contact: the directory the request carries wins
    // over the saved one, so a contact can move between projects.
    const directory = asNonEmptyString(isRecord(input) ? input.directory : undefined) ?? assistant.directory;
    if (!directory) throw new AssistantError('directory is required to start this contact a chat', 400);
    await waitForOpenCodeReady();
    const client = clientFor(directory);
    const createOptions: AssistantSessionCreateInput = {
      title: assistant.name,
      location: { directory },
      metadata: { openchamber: { assistant: { id: assistant.id, version: 1 } } },
    };
    if (assistant.model) {
      const [providerID = assistant.model, modelID = assistant.model] = assistant.model.split('/');
      createOptions.model = { id: modelID, providerID };
    }
    if (assistant.agent) {
      createOptions.agent = assistant.agent;
    }
    const session = await client.session.create(createOptions);
    const sessionId = asNonEmptyString(session?.id);
    if (!sessionId) throw new AssistantError('OpenCode created no session for the contact', 502);
    assistant.lastSessionId = sessionId;
    assistant.directory = directory;
    assistant.updatedAt = now();
    schedulePersist();
    // The persona is the opening message: the contact speaks as its prompt
    // says from the very first turn.
    const dispatch: SessionPayload = { prompt: assistant.prompt, directory };
    if (assistant.model) dispatch.model = assistant.model;
    if (assistant.agent) dispatch.agent = assistant.agent;
    await sessionService.send(sessionId, dispatch);
    broadcast('thread-started', assistant.id);
    return { assistant: publicAssistant(assistant), sessionId, created: true };
  };

  return {
    init: load,

    listAssistants: async () => {
      await load();
      return assistants.map(publicAssistant);
    },

    createAssistant: async (input: unknown) => {
      await load();
      if (assistants.length >= MAX_ASSISTANTS) {
        throw new AssistantError(`The contact list holds at most ${MAX_ASSISTANTS} contacts`, 409);
      }
      const fields = parseCreateInput(input ?? {});
      const assistant: StoredAssistant = {
        id: `assistant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: fields.name,
        description: fields.description,
        prompt: fields.prompt,
        model: fields.model,
        agent: fields.agent,
        directory: fields.directory,
        lastSessionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      assistants.unshift(assistant);
      schedulePersist();
      broadcast('created', assistant.id);
      return { assistant: publicAssistant(assistant) };
    },

    updateAssistant: async (assistantId: unknown, input: unknown) => {
      await load();
      const assistant = findAssistant(assistantId);
      const patch = parseUpdateInput(input ?? {});
      Object.assign(assistant, patch, { updatedAt: now() });
      schedulePersist();
      broadcast('updated', assistant.id);
      return { assistant: publicAssistant(assistant) };
    },

    deleteAssistant: async (assistantId: unknown) => {
      await load();
      const assistant = findAssistant(assistantId);
      // The contact is forgotten; the chat it started is an ordinary
      // session and stays where its own user can find it.
      assistants = assistants.filter((entry) => entry.id !== assistant.id);
      schedulePersist();
      broadcast('deleted', assistant.id);
      return { deleted: true, assistantId: assistant.id };
    },

    openChat,
  };
};
