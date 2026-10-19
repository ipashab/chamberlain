import fsDefault from 'node:fs';
import os from 'node:os';
import pathDefault from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCheckpointStore } from './store.js';

// The registry is a persisted contract: entries round-trip, malformed bytes
// stay failures instead of turning into empty registries, and eviction hands
// dropped refs to the pruner before they leave the file.

const tempDirs = [];

const createDataDir = () => {
  const dir = fsDefault.mkdtempSync(pathDefault.join(os.tmpdir(), 'openchamber-checkpoints-store-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fsDefault.promises.rm(dir, { recursive: true, force: true })));
});

const entryOf = (userMessageID, createdAt, files = ['a.txt'], directory = '/repo') => ({
  id: userMessageID,
  userMessageID,
  directory,
  tree: 'f'.repeat(40),
  baseRefName: `refs/openchamber/checkpoints/ses_one/${createdAt}/base`,
  createdAt,
  files,
});

describe('createCheckpointStore', () => {
  it('round-trips an entry and answers an unknown session as empty', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    await expect(store.list('ses_one')).resolves.toEqual([]);
    const stored = await store.record('ses_one', entryOf('msg_u1', 100));
    expect(stored).toMatchObject({ id: 'msg_u1', userMessageID: 'msg_u1', truncated: false });
    const entries = await store.list('ses_one');
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual(['a.txt']);
    expect(await store.get('ses_one', 'msg_u1')).toMatchObject({ id: 'msg_u1' });
    expect(await store.get('ses_one', 'missing')).toBeNull();
  });

  it('rejects malformed entries instead of storing them', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    await expect(store.record('ses_one', { ...entryOf('m1', 1), tree: 'short' })).rejects.toThrow(/malformed/);
    await expect(store.record('ses_one', { ...entryOf('m1', 1), directory: '' })).rejects.toThrow(/malformed/);
    await expect(store.record('ses_one', { ...entryOf('m1', 1), files: [] })).rejects.toThrow(/malformed/);
    await expect(store.list('ses_one')).resolves.toEqual([]);
  });

  it('replaces the entry of a continued turn instead of stacking a second one', async () => {
    const dataDir = createDataDir();
    const evicted = [];
    const store = createCheckpointStore({ dataDir, onEvicted: (entries) => evicted.push(...entries) });
    await store.record('ses_one', entryOf('msg_u1', 100, ['a.txt']));
    await store.record('ses_one', entryOf('msg_u1', 200, ['a.txt', 'b.txt']));
    const entries = await store.list('ses_one');
    expect(entries).toHaveLength(1);
    expect(entries[0].files).toEqual(['a.txt', 'b.txt']);
    expect(entries[0].createdAt).toBe(200);
    // The replaced entry's ref was handed to the pruner while still pinned.
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatchObject({ userMessageID: 'msg_u1', createdAt: 100 });
  });

  it('bounds the list, evicting oldest first through the pruner', async () => {
    const dataDir = createDataDir();
    const evicted = [];
    const store = createCheckpointStore({ dataDir, onEvicted: (entries) => evicted.push(...entries) });
    for (let number = 1; number <= 16; number += 1) {
      await store.record('ses_one', entryOf(`msg_u${number}`, number * 100));
    }
    const entries = await store.list('ses_one');
    expect(entries).toHaveLength(15);
    expect(entries[0].createdAt).toBe(1600);
    expect(entries.at(-1).createdAt).toBe(200);
    expect(evicted).toEqual([expect.objectContaining({ createdAt: 100 })]);
  });

  it('caps the stored file list and marks the entry truncated', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    const files = Array.from({ length: 600 }, (_, index) => `file-${index}.txt`);
    const stored = await store.record('ses_one', entryOf('msg_big', 100, files));
    expect(stored.files).toHaveLength(500);
    expect(stored.truncated).toBe(true);
  });

  it('round-trips a restore state and reports the previous one', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    await store.record('ses_one', entryOf('msg_u1', 100));
    const restored = { at: 900, tree: 'e'.repeat(40), refName: 'refs/openchamber/checkpoints/ses_one/100/undo' };
    const previous = await store.markRestored('ses_one', 'msg_u1', restored);
    expect(previous?.restored).toBeNull();
    const next = await store.get('ses_one', 'msg_u1');
    expect(next?.restored).toEqual(restored);
    const beforeToggle = await store.markRestored('ses_one', 'msg_u1', { at: 1000, tree: 'd'.repeat(40), refName: 'refs/openchamber/checkpoints/ses_one/100/undo' });
    expect(beforeToggle?.restored).toEqual(restored);
    expect(await store.markRestored('ses_one', 'missing', restored)).toBeNull();
  });

  it('treats a malformed file as a failure and keeps the bytes for the user', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    await store.record('ses_one', entryOf('msg_u1', 100));
    const filePath = pathDefault.join(dataDir, 'checkpoints', 'ses_one.json');
    await fsDefault.promises.writeFile(filePath, 'not json{', 'utf8');
    await expect(store.list('ses_one')).rejects.toThrow();
    const backup = fsDefault.readdirSync(pathDefault.join(dataDir, 'checkpoints')).find((name) => name.includes('corrupt'));
    expect(backup).toBeTruthy();
    expect(fsDefault.existsSync(filePath)).toBe(false);
  });

  it('separates sessions and keeps writes serialized', async () => {
    const dataDir = createDataDir();
    const store = createCheckpointStore({ dataDir });
    await store.record('ses_one', entryOf('msg_u1', 100));
    await store.record('ses_two', entryOf('msg_x1', 100));
    expect(await store.list('ses_one')).toHaveLength(1);
    expect(await store.list('ses_two')).toHaveLength(1);
    // Two records racing on one session both complete; both reads then see
    // consistent state, not half-persisted bytes.
    await Promise.all([
      store.record('ses_one', entryOf('msg_u2', 200)),
      store.record('ses_one', entryOf('msg_u3', 300)),
    ]);
    const entries = await store.list('ses_one');
    expect([300, 200, 100]).toEqual(entries.map((entry) => entry.createdAt));
  });
});
