import { describe, expect, it, vi } from 'vitest';

import { createContactRunService, ContactRunError } from './service.js';
import { contactRunBounds } from './tools.js';

const CONTACTS = [
  {
    id: 'as_1',
    name: 'Natasha',
    description: 'The code reviewer',
    prompt: 'You are a meticulous code reviewer; answer with findings and a verdict.',
    model: 'okko/Expert',
    agent: 'review',
    directory: '/tmp/repo',
  },
  {
    id: 'as_2',
    name: 'Auditor',
    prompt: '',
    model: '',
    agent: '',
  },
];

const forkResult = (overrides = {}) => ({
  sessionId: 'ses_child',
  directory: '/tmp/repo',
  baselineAssistantMessageId: 'msg_a0',
  baselineIdleRecordId: 'msg_i0',
  model: 'okko/Expert',
  promptDispatched: true,
  ...overrides,
});

const assistantRow = (id, text) => ({
  id,
  type: 'assistant',
  time: { created: 2, completed: 4 },
  content: text == null ? [] : [{ type: 'text', text }],
});

const buildClient = ({ list }) => ({
  message: { list },
});

describe('createContactRunService', () => {
  it('refuses to run without a contacts list and a session fork', () => {
    expect(() => createContactRunService({}))
      .toThrow('contact-run service needs a contacts list and a session fork');
  });

  it('answers every unknown action as a usage error', async () => {
    const contacts = service();
    await expect(contacts.executeAction('contact.merge', {})).rejects.toMatchObject({ statusCode: 400 });
  });

  describe('contact.list', () => {
    it('publishes the saved names, not the ids', async () => {
      const contacts = service();
      const data = await contacts.executeAction('contact.list', {});
      expect(data.contacts.map(({ name }) => name)).toEqual(['Natasha', 'Auditor']);
      expect(data.contacts[0]).not.toHaveProperty('id');
      expect(data.contacts[0]).toMatchObject({
        description: 'The code reviewer',
        model: 'okko/Expert',
        agent: 'review',
      });
      expect(data).not.toHaveProperty('note');
    });

    it('names the empty case honestly', async () => {
      const contacts = service({ listContacts: vi.fn(async () => []) });
      const data = await contacts.executeAction('contact.list', {});
      expect(data.contacts).toEqual([]);
      expect(data.note).toContain('No saved contacts yet');
    });

    it('treats a malformed list answer as no contacts, not a crash', async () => {
      const contacts = service({ listContacts: vi.fn(async () => null) });
      const data = await contacts.executeAction('contact.list', {});
      expect(data.contacts).toEqual([]);
    });
  });

  describe('contact.run', () => {
    it('forks the caller with the persona heading the task and the contact\'s model', async () => {
      const forkSession = vi.fn(async () => forkResult());
      const contacts = service({ forkSession });
      const data = await contacts.executeAction('contact.run', {
        callerSessionID: 'ses_me',
        contact: 'natasha',
        task: 'Audit the checkpoint store for leaks',
      });
      expect(forkSession).toHaveBeenCalledWith('ses_me', {
        prompt: 'You are a meticulous code reviewer; answer with findings and a verdict.\n\nThe task:\nAudit the checkpoint store for leaks',
        model: 'okko/Expert',
        agent: 'review',
      });
      expect(data).toMatchObject({
        sessionID: 'ses_child',
        contact: 'Natasha',
        model: 'okko/Expert',
        directory: '/tmp/repo',
      });
      expect(data.note).toContain('contact.wait');
    });

    it('sends the bare task when the contact carries no persona', async () => {
      const forkSession = vi.fn(async () => forkResult());
      const contacts = service({ forkSession });
      await contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'Auditor', task: 'Check it' });
      expect(forkSession.mock.calls[0][1]).toEqual({ prompt: 'Check it' });
    });

    it('answers usage for what the agent can fix', async () => {
      const contacts = service();
      await expect(contacts.executeAction('contact.run', { contact: 'Natasha', task: 'Do it' }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'Natasha' }))
        .rejects.toMatchObject({ statusCode: 400 });
      const long = 'x'.repeat(contactRunBounds.taskMax + 1);
      await expect(contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'Natasha', task: long }))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'Ghost', task: 'Do it' }))
        .rejects.toMatchObject({ statusCode: 404 });
    });

    it('disambiguates a fragment only when exactly one contact answers to it', async () => {
      const forkSession = vi.fn(async () => forkResult());
      const contacts = service({
        forkSession,
        listContacts: vi.fn(async () => CONTACTS.concat([{ id: 'as_3', name: 'Natasha Jr' }])),
      });
      await contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'aud', task: 'Check' });
      expect(forkSession.mock.calls[0][0]).toBe('ses_me');
      await expect(contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'nat', task: 'Check' }))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('reports a fork that dispatched no prompt as a runtime failure with the child named', async () => {
      const contacts = service({
        forkSession: vi.fn(async () => forkResult({ promptDispatched: false, promptError: 'provider unavailable' })),
      });
      const error = await capture(() =>
        contacts.executeAction('contact.run', { callerSessionID: 'ses_me', contact: 'Natasha', task: 'Do it' }));
      expect(error).toBeInstanceOf(ContactRunError);
      expect(error.statusCode).toBe(502);
      expect(error.message).toContain('provider unavailable');
      expect(error.details).toMatchObject({ sessionID: 'ses_child' });
    });
  });

  describe('contact.wait', () => {
    const startedRun = async (contacts, overrides = {}) => {
      await contacts.executeAction('contact.run', {
        callerSessionID: 'ses_me',
        contact: 'Natasha',
        task: 'Do it',
        ...overrides,
      });
    };

    it('answers usage when no run answers to the session', async () => {
      const contacts = service();
      await expect(contacts.executeAction('contact.wait', { sessionID: 'ses_child' }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(contacts.executeAction('contact.wait', {}))
        .rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns the answer once the turn\'s idle row stands past the baselines', async () => {
      const list = vi.fn(async () => ({
        data: [
          { id: 'msg_a1', type: 'user', text: 'The task:\nDo it' },
          assistantRow('msg_a2', 'The audit found two leaks'),
          { id: 'msg_i1', type: 'idle', outcome: 'succeeded', time: { created: 5, completed: 6 } },
          assistantRow('msg_a0', 'copied history answer'),
          { id: 'msg_i0', type: 'idle', outcome: 'succeeded' },
        ],
      }));
      const contacts = serviceWithClient({ list });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child' });
      expect(data).toMatchObject({ done: true, outcome: 'succeeded', answer: 'The audit found two leaks' });
    });

    it('takes the newest answer, not the first text the window holds', async () => {
      const list = vi.fn(async () => ({
        data: [
          assistantRow('msg_a3', 'the final verdict'),
          { id: 'msg_i1', type: 'idle', outcome: 'succeeded' },
          assistantRow('msg_a2', 'an interim thought'),
          { id: 'msg_i0', type: 'idle', outcome: 'succeeded' },
        ],
      }));
      const contacts = serviceWithClient({ list });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child' });
      expect(data.answer).toBe('the final verdict');
    });

    it('keeps every row when a whole turn crowds the baselines out of the window', async () => {
      const rows = [
        assistantRow('msg_a9', 'the answer'),
        { id: 'msg_i1', type: 'idle', outcome: 'succeeded' },
      ];
      for (let index = 0; index < 3; index += 1) {
        rows.push(assistantRow(`msg_t${index}`, 'turn chatter'));
        rows.push({ id: `msg_u${index}`, type: 'user', text: 'go on' });
      }
      const list = vi.fn(async () => ({ data: rows }));
      const contacts = serviceWithClient({ list, forkOverrides: { baselineAssistantMessageId: 'msg_a0', baselineIdleRecordId: 'msg_i0' } });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child' });
      expect(data.answer).toBe('the answer');
    });

    it('names an answer-less turn honestly, by its outcome', async () => {
      const list = vi.fn(async () => ({
        data: [
          { id: 'msg_i1', type: 'idle', outcome: 'aborted', time: { created: 5, completed: 6 } },
          { id: 'msg_i0', type: 'idle', outcome: 'succeeded' },
        ],
      }));
      const contacts = serviceWithClient({ list });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child' });
      expect(data).toMatchObject({ done: true, outcome: 'aborted', answer: null });
      expect(data.note).toContain('aborted');
    });

    it('polls until the turn ends, then keeps waiting on timeout', async () => {
      vi.useFakeTimers();
      try {
        const list = vi.fn()
          .mockResolvedValueOnce({ data: [assistantRow('msg_a1', 'half an answer')] })
          .mockResolvedValue({ data: [
            assistantRow('msg_a2', 'the whole answer'),
            { id: 'msg_i1', type: 'idle', outcome: 'succeeded' },
            { id: 'msg_i0', type: 'idle', outcome: 'succeeded' },
          ] });
        const contacts = serviceWithClient({ list });
        await startedRun(contacts);
        const waiting = contacts.executeAction('contact.wait', { sessionID: 'ses_child' });
        await vi.advanceTimersByTimeAsync(contactRunBounds.pollInterval);
        await expect(waiting).resolves.toMatchObject({ done: true, answer: 'the whole answer' });
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('answers a timeout with the run still going, honest about the re-call', async () => {
      let tick = 0;
      const list = vi.fn(async () => ({ data: [assistantRow('msg_a1', 'still working')] }));
      const contacts = serviceWithClient({ list, now: () => {
        tick += 600_000;
        return tick;
      } });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child', timeoutMs: 5_000 });
      expect(data).toMatchObject({ done: false, waited: 'timeout' });
      expect(data.note).toContain('call contact.wait again');
    });

    it('clamps the requested window into the taught bounds', async () => {
      const list = vi.fn(async () => ({
        data: [
          { id: 'msg_i1', type: 'idle', outcome: 'succeeded' },
          { id: 'msg_i0', type: 'idle', outcome: 'succeeded' },
        ],
      }));
      const contacts = serviceWithClient({ list });
      await startedRun(contacts);
      const data = await contacts.executeAction('contact.wait', { sessionID: 'ses_child', timeoutMs: 10_000_000 });
      expect(data.done).toBe(true);
    });
  });
});

const capture = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

const serviceWithClient = ({ list, forkOverrides = {}, now } = {}) => service({
  forkSession: vi.fn(async () => forkResult(forkOverrides)),
  createOpenCodeClient: vi.fn(() => buildClient({ list })),
  now,
});

const service = ({
  listContacts = vi.fn(async () => CONTACTS),
  forkSession = vi.fn(async () => forkResult()),
  createOpenCodeClient = vi.fn(() => buildClient({ list: vi.fn(async () => ({ data: [] })) })),
  buildOpenCodeUrl = vi.fn(() => 'http://loopback/'),
  getOpenCodeAuthHeaders = vi.fn(() => ({})),
  now,
} = {}) => createContactRunService({
  listContacts,
  forkSession,
  createOpenCodeClient,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  // The service falls back to Date.now on its own; passing undefined along
  // keeps the helper's default identical to omitting the key.
  now,
});
