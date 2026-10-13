import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createConfluenceConfigStore } from './config-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-confluence-'));
  temporaryDirectories.push(dataDir);
  return {
    store: createConfluenceConfigStore({ fsPromises: fs, path, dataDir }),
    dataDir,
  };
};

const waitForWrites = async () => new Promise((resolve) => { setTimeout(resolve, 25); });

describe('createConfluenceConfigStore', () => {
  it('answers an unconfigured state before anything is saved', async () => {
    const { store } = await makeStore();
    expect(await store.readPublic()).toEqual({ configured: false });
    expect((await store.read()).instance).toBeNull();
  });

  it('saves a connection, persists it, and never answers the token back', async () => {
    const { store, dataDir } = await makeStore();
    await store.save({ origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: false });
    await waitForWrites();

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'confluence.json'), 'utf8'));
    expect(stored.instance.token).toBe('CONF-secret');

    expect(await store.readPublic()).toEqual({
      configured: true,
      origin: 'https://confluence.example.com',
      hasToken: true,
      verifySsl: false,
    });

    const fresh = createConfluenceConfigStore({ fsPromises: fs, path, dataDir });
    expect((await fresh.read()).instance).toEqual({
      origin: 'https://confluence.example.com',
      token: 'CONF-secret',
      verifySsl: false,
    });
  });

  it('keeps the stored token when a save carries none, clears it on an empty string', async () => {
    const { store } = await makeStore();
    await store.save({ origin: 'https://confluence.example.com', token: 'CONF-secret', verifySsl: true });
    await store.save({ origin: 'https://confluence.example.com', verifySsl: false });
    expect((await store.read()).instance).toEqual({
      origin: 'https://confluence.example.com',
      token: 'CONF-secret',
      verifySsl: false,
    });
    await store.save({ token: '' });
    expect(await store.readPublic()).toEqual({ configured: false });
  });

  it('drops the connection when disconnect arrives', async () => {
    const { store } = await makeStore();
    await store.save({ origin: 'https://confluence.example.com', token: 'CONF-secret' });
    await store.save({ disconnect: true, origin: 'https://elsewhere.example.com' });
    expect(await store.readPublic()).toEqual({ configured: false });
  });

  it('rejects an invalid origin without writing anything', async () => {
    const { store } = await makeStore();
    await expect(store.save({ origin: 'not an address', token: 'CONF-secret' })).rejects.toMatchObject({ statusCode: 400 });
    expect((await store.read()).instance).toBeNull();
  });

  it('rejects a token that arrives before any instance', async () => {
    const { store } = await makeStore();
    await expect(store.save({ token: 'CONF-secret' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('boots an unreadable file as an empty state', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-confluence-'));
    temporaryDirectories.push(dataDir);
    await fs.writeFile(path.join(dataDir, 'confluence.json'), '{broken', 'utf8');
    const store = createConfluenceConfigStore({ fsPromises: fs, path, dataDir });
    expect(await store.readPublic()).toEqual({ configured: false });
  });
});
