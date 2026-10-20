import fsDefault from 'node:fs';
import os from 'node:os';
import pathDefault from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backlogStoreBounds, createBacklogStore } from './store.js';

// The backlog is a persisted contract: items round-trip in run order,
// malformed bytes stay failures instead of turning into empty queues, and a
// full queue refuses the add rather than evicting a task nobody sent.

const tempDirs = [];

const createDataDir = () => {
  const dir = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), 'openchamber-backlog-store-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsDefault.promises.rm(dir, { recursive: true, force: true })));
});

describe('createBacklogStore', () => {
  it('stages items oldest first and answers an unknown session as empty', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    await expect(store.list('ses_one')).resolves.toEqual([]);
    await store.add('ses_one', { text: ' First task ', createdAt: 100 });
    const second = await store.add('ses_one', { text: 'Second task', createdAt: 200 });
    expect(second.text).toBe('Second task');
    const items = await store.list('ses_one');
    expect(items.map(({ text }) => text)).toEqual(['First task', 'Second task']);
    expect(items.map(({ createdAt }) => createdAt)).toEqual([100, 200]);
  });

  it('round-trips through the file, with ids it can speak back', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir, generateId: () => 'bl_fixed' });
    const stored = await store.add('ses_one', { text: 'Do the audit', createdAt: 100 });
    expect(stored.id).toBe('bl_fixed');
    const reRead = createBacklogStore({ dataDir });
    await expect(reRead.list('ses_one')).resolves.toEqual([{ id: 'bl_fixed', text: 'Do the audit', createdAt: 100 }]);
  });

  it('refuses an empty item and one over the limit, by name', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    await expect(store.add('ses_one', { text: '   ', createdAt: 100 })).rejects.toThrow('empty');
    const long = 'x'.repeat(backlogStoreBounds.textLimit + 1);
    await expect(store.add('ses_one', { text: long, createdAt: 100 })).rejects.toThrow('limit is');
  });

  it('refuses the add that would evict a task nobody sent', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    for (let index = 0; index < backlogStoreBounds.listLimit; index += 1) {
      await store.add('ses_one', { text: `task ${index}`, createdAt: index + 1 });
    }
    await expect(store.add('ses_one', { text: 'one too many', createdAt: 999 }))
      .rejects.toThrow('limit is');
    expect((await store.list('ses_one')).map(({ text }) => text)[0]).toBe('task 0');
  });

  it('takes one item out and drops the lot, by exact id', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    const first = await store.add('ses_one', { text: 'first', createdAt: 100 });
    const second = await store.add('ses_one', { text: 'second', createdAt: 200 });
    expect(await store.remove('ses_one', 'bl_missing')).toBe(false);
    expect(await store.remove('ses_one', first.id)).toBe(true);
    await expect(store.list('ses_one')).resolves.toEqual([second]);
    expect(await store.clear('ses_one')).toBe(1);
    await expect(store.list('ses_one')).resolves.toEqual([]);
  });

  it('moves an item and the file keeps the new run order', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    await store.add('ses_one', { text: 'first', createdAt: 100 });
    await store.add('ses_one', { text: 'second', createdAt: 200 });
    const third = await store.add('ses_one', { text: 'third', createdAt: 300 });
    const moved = await store.move('ses_one', third.id, 0);
    expect(moved.map(({ text }) => text)).toEqual(['third', 'first', 'second']);
    // A fresh store reads the same order back: the positions live in the file.
    const reRead = createBacklogStore({ dataDir });
    expect((await reRead.list('ses_one')).map(({ text }) => text)).toEqual(['third', 'first', 'second']);
    // A later add lands behind the reordered items.
    await reRead.add('ses_one', { text: 'fourth', createdAt: 400 });
    expect((await reRead.list('ses_one')).map(({ text }) => text))
      .toEqual(['third', 'first', 'second', 'fourth']);
    await expect(reRead.move('ses_one', 'bl_missing', 1)).resolves.toBeNull();
  });

  it('grades move failures by name: the empty queue and the out-of-range position', async () => {
    const dataDir = createDataDir();
    const store = createBacklogStore({ dataDir });
    await expect(store.move('ses_one', 'bl_1', 0)).rejects.toThrow('empty');
    await store.add('ses_one', { text: 'only', createdAt: 100 });
    await expect(store.move('ses_one', 'bl_1', 1)).rejects.toThrow('within the queue');
    await expect(store.move('ses_one', 'bl_1', -1)).rejects.toThrow('within the queue');
    await expect(store.move('ses_one', 'bl_1', 1.5)).rejects.toThrow('within the queue');
  });

  it('reads a file from before reordering in its chronological order', async () => {
    const dataDir = createDataDir();
    fsDefault.mkdirSync(pathDefault.join(dataDir, 'backlog'), { recursive: true });
    const filePath = pathDefault.join(dataDir, 'backlog', 'ses_one.json');
    // No positions: written before any move. The array order is not the
    // authority; the timestamps are.
    fsDefault.writeFileSync(filePath, JSON.stringify({
      version: 1,
      items: [
        { id: 'bl_2', text: 'second', createdAt: 200 },
        { id: 'bl_1', text: 'first', createdAt: 100 },
      ],
    }), 'utf8');
    const store = createBacklogStore({ dataDir });
    expect((await store.list('ses_one')).map(({ text }) => text)).toEqual(['first', 'second']);
    await store.move('ses_one', 'bl_2', 0);
    expect((await store.list('ses_one')).map(({ text }) => text)).toEqual(['second', 'first']);
  });

  it('keeps malformed bytes as a failure, never an empty queue', async () => {
    const dataDir = createDataDir();
    fsDefault.mkdirSync(pathDefault.join(dataDir, 'backlog'), { recursive: true });
    const filePath = pathDefault.join(dataDir, 'backlog', 'ses_one.json');
    fsDefault.writeFileSync(filePath, '{ not json', 'utf8');
    const store = createBacklogStore({ dataDir });
    await expect(store.list('ses_one')).rejects.toThrow('malformed');
    const backups = fsDefault.readdirSync(pathDefault.join(dataDir, 'backlog'))
      .filter((name) => name.startsWith('ses_one.json.corrupt-'));
    expect(backups).toHaveLength(1);
  });
});
