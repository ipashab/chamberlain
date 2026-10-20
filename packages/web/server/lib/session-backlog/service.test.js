import { describe, expect, it, vi } from 'vitest';

import { createBacklogService } from './service.js';
import { isString } from '../shared/guards.js';
import { backlogDrainBounds } from './tools.js';

// The drain is watched, not assumed: an item runs only after the caller's
// own turn ends, a turn is finished by its `idle` record standing beyond the
// baseline, and whatever stops the drain leaves the rest staged — the tests
// below take the drain through each of those.

const idleRow = (id) => ({ id, type: 'idle', outcome: 'succeeded' });

const inMemoryStore = (initialItems = []) => {
  const items = [...initialItems];
  const calls = { add: [], remove: [], clear: 0 };
  return {
    list: vi.fn(async () => [...items]),
    add: vi.fn(async (sessionId, { text, createdAt }) => {
      calls.add.push({ sessionId, text });
      const trimmed = isString(text) ? text.trim() : '';
      if (!trimmed) throw new Error('The staged item is empty');
      const item = { id: `bl_${items.length + 1}`, text: trimmed, createdAt };
      items.push(item);
      return item;
    }),
    remove: vi.fn(async (sessionId, itemId) => {
      const index = items.findIndex((item) => item.id === itemId);
      if (index === -1) return false;
      items.splice(index, 1);
      return true;
    }),
    clear: vi.fn(async () => {
      calls.clear += 1;
      const dropped = items.length;
      items.length = 0;
      return dropped;
    }),
    items,
    calls,
  };
};

const flushDrain = async () => {
  await vi.runAllTimersAsync();
  await Promise.resolve();
};

describe('createBacklogService', () => {
  it('refuses to run without a store and a session send', () => {
    expect(() => createBacklogService({}))
      .toThrow('backlog service needs a store');
    expect(() => createBacklogService({ store: inMemoryStore() }))
      .toThrow('backlog service needs a session service with send()');
  });

  it('answers every unknown action as a usage error', async () => {
    const backlog = service();
    await expect(backlog.executeAction('backlog.merge', { sessionID: 'ses_one' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(backlog.executeAction('backlog.list', {}))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('reads, stages, removes and clears through the store, and grades its failures', async () => {
    const store = inMemoryStore();
    const backlog = service({ store });
    await backlog.executeAction('backlog.add', { sessionID: 'ses_one', text: 'first' });
    await backlog.executeAction('backlog.add', { sessionID: 'ses_one', text: 'second' });
    const list = await backlog.executeAction('backlog.list', { sessionID: 'ses_one' });
    expect(list.items.map(({ text }) => text)).toEqual(['first', 'second']);
    expect(list.draining).toBe(false);
    const listByCaller = await backlog.executeAction('backlog.list', { callerSessionID: 'ses_one' });
    expect(listByCaller.items).toHaveLength(2);
    await backlog.executeAction('backlog.remove', { sessionID: 'ses_one', itemID: list.items[0].id });
    expect(store.items).toHaveLength(1);
    const cleared = await backlog.executeAction('backlog.clear', { sessionID: 'ses_one' });
    expect(cleared.removed).toBe(1);
    await expect(backlog.executeAction('backlog.add', { sessionID: 'ses_one', text: '' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(backlog.executeAction('backlog.add', { sessionID: 'ses_one' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses the run of an empty queue and of a drain already going', async () => {
    const backlog = service({ store: inMemoryStore() });
    await expect(backlog.executeAction('backlog.run', { sessionID: 'ses_one' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses the run of a second drain while one is going', async () => {
    vi.useFakeTimers();
    try {
      const store = inMemoryStore([{ id: 'bl_1', text: 'first', createdAt: 1 }]);
      const send = vi.fn(async () => ({ promptDispatched: true }));
      const messageList = vi.fn()
        .mockResolvedValueOnce({ data: [idleRow('i1')] })
        .mockResolvedValue({ data: [idleRow('i2'), idleRow('i1')] });
      const stateAnswers = [{ status: 'busy' }];
      const backlog = service({
        store,
        send,
        messageList,
        getSessionState: () => stateAnswers.shift() ?? { status: 'idle' },
      });
      const started = await backlog.executeAction('backlog.run', { sessionID: 'ses_one' });
      expect(started).toMatchObject({ started: true, staged: 1 });
      await expect(backlog.executeAction('backlog.run', { sessionID: 'ses_one' }))
        .rejects.toMatchObject({ statusCode: 409 });
      await flushDrain();
      const settled = await backlog.executeAction('backlog.list', { sessionID: 'ses_one' });
      expect(settled.draining).toBe(false);
      expect(store.items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the run before the session\'s directory can be resolved', async () => {
    const backlog = service({
      store: inMemoryStore([{ id: 'bl_1', text: 'first', createdAt: 1 }]),
      resolveSessionDirectory: vi.fn(async () => {
        throw new Error('unknown session');
      }),
    });
    const error = await capture(() => backlog.executeAction('backlog.run', { sessionID: 'ses_one' }));
    expect(error.statusCode).toBe(500);
    expect(error.message).toContain('unknown session');
  });

  it('drains items in order, one turn each, and empties the queue', async () => {
    vi.useFakeTimers();
    try {
      const store = inMemoryStore([
        { id: 'bl_1', text: 'first task', createdAt: 1 },
        { id: 'bl_2', text: 'second task', createdAt: 2 },
      ]);
      const send = vi.fn(async () => ({ promptDispatched: true }));
      const messageList = vi.fn()
        .mockResolvedValueOnce({ data: [idleRow('i0')] })
        .mockResolvedValueOnce({ data: [idleRow('i1'), idleRow('i0')] })
        .mockResolvedValueOnce({ data: [idleRow('i1'), idleRow('i0')] })
        .mockResolvedValueOnce({ data: [idleRow('i2'), idleRow('i1'), idleRow('i0')] });
      const backlog = service({ store, send, messageList });
      const started = await backlog.executeAction('backlog.run', { sessionID: 'ses_one' });
      expect(started.started).toBe(true);
      await flushDrain();
      expect(send.mock.calls.map(([, payload]) => payload.prompt)).toEqual(['first task', 'second task']);
      expect(send.mock.calls.map(([, payload]) => payload.directory)).toEqual(['/repo', '/repo']);
      expect(store.items).toEqual([]);
      const settled = await backlog.executeAction('backlog.list', { sessionID: 'ses_one' });
      expect(settled.draining).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the caller\'s busy turn to end before the first item', async () => {
    vi.useFakeTimers();
    try {
      const store = inMemoryStore([{ id: 'bl_1', text: 'first task', createdAt: 1 }]);
      const send = vi.fn(async () => ({ promptDispatched: true }));
      const messageList = vi.fn()
        .mockResolvedValueOnce({ data: [idleRow('i1')] })
        .mockResolvedValue({ data: [idleRow('i2'), idleRow('i1')] });
      const stateAnswers = [{ status: 'busy' }, { status: 'retry' }];
      const backlog = service({ store, send, messageList, getSessionState: () => stateAnswers.shift() ?? { status: 'idle' } });
      await backlog.executeAction('backlog.run', { sessionID: 'ses_one' });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).not.toHaveBeenCalled();
      await flushDrain();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when the session would not take the item, leaving the rest staged', async () => {
    vi.useFakeTimers();
    try {
      const store = inMemoryStore([{ id: 'bl_1', text: 'first task', createdAt: 1 }]);
      const backlog = service({
        store,
        send: vi.fn(async () => ({ promptDispatched: false, promptError: 'provider unavailable' })),
      });
      await backlog.executeAction('backlog.run', { sessionID: 'ses_one' });
      await flushDrain();
      expect(store.items).toHaveLength(1);
      const settled = await backlog.executeAction('backlog.list', { sessionID: 'ses_one' });
      expect(settled.draining).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops when an item\'s turn does not end inside the window, honest about the rest', async () => {
    vi.useFakeTimers();
    try {
      const store = inMemoryStore([{ id: 'bl_1', text: 'first task', createdAt: 1 }]);
      const send = vi.fn(async () => ({ promptDispatched: true }));
      const clock = vi.fn(() => {
        clock.ticks = (clock.ticks ?? 0) + 1;
        return clock.ticks * 3 * 60 * 60 * 1000;
      });
      const backlog = service({
        store,
        send,
        messageList: vi.fn(async () => ({ data: [idleRow('i0')] })),
        now: clock,
      });
      await backlog.executeAction('backlog.run', { sessionID: 'ses_one' });
      await flushDrain();
      expect(send).toHaveBeenCalledTimes(1);
      expect(store.items).toHaveLength(1);
      const settled = await backlog.executeAction('backlog.list', { sessionID: 'ses_one' });
      expect(settled.draining).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

const service = ({
  store = inMemoryStore(),
  send = vi.fn(async () => ({ promptDispatched: true })),
  resolveSessionDirectory = vi.fn(async () => '/repo'),
  getSessionState = () => ({ status: 'idle' }),
  messageList = vi.fn(async () => ({ data: [idleRow('i1'), idleRow('i0')] })),
  broadcastUiEvent = () => {},
  now,
} = {}) => createBacklogService({
  store,
  sessionService: { send },
  resolveSessionDirectory,
  getSessionState,
  createOpenCodeClient: vi.fn(() => ({ message: { list: messageList } })),
  buildOpenCodeUrl: vi.fn(() => 'http://loopback/'),
  getOpenCodeAuthHeaders: vi.fn(() => ({})),
  broadcastUiEvent,
  // The service falls back to Date.now on its own; passing undefined along
  // keeps the helper's default identical to omitting the key.
  now,
});
