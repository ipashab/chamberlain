import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createJiraConfigStore } from './config-store.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeStore = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-jira-'));
  temporaryDirectories.push(dataDir);
  return {
    store: createJiraConfigStore({ fsPromises: fs, path, dataDir }),
    dataDir,
  };
};

const waitForWrites = async () => new Promise((resolve) => { setTimeout(resolve, 25); });

describe('createJiraConfigStore', () => {
  it('answers an unconfigured state before anything is saved', async () => {
    const { store } = await makeStore();
    expect(await store.readPublic()).toEqual({ configured: false });
    expect((await store.read()).instance).toBeNull();
  });

  it('saves a connection, persists it, and never answers the token back', async () => {
    const { store, dataDir } = await makeStore();
    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-secret', verifySsl: false });
    await waitForWrites();

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'jira.json'), 'utf8'));
    expect(stored.instance.token).toBe('JIRA-secret');

    expect(await store.readPublic()).toEqual({
      configured: true,
      origin: 'https://jira.example.com',
      hasToken: true,
      verifySsl: false,
    });

    const fresh = createJiraConfigStore({ fsPromises: fs, path, dataDir });
    expect((await fresh.read()).instance).toEqual({
      origin: 'https://jira.example.com',
      token: 'JIRA-secret',
      verifySsl: false,
    });
  });

  it('keeps the stored token when a save updates only the TLS policy', async () => {
    const { store } = await makeStore();
    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-one' });
    await store.save({ verifySsl: false });
    const { instance } = await store.read();
    expect(instance).toEqual({ origin: 'https://jira.example.com', token: 'JIRA-one', verifySsl: false });
    // A read that follows sees the in-flight write, not the old file.
    await store.save({ verifySsl: true });
    expect((await store.read()).instance.verifySsl).toBe(true);
  });

  it('refuses invalid origins and tokens without touching the stored connection', async () => {
    const { store } = await makeStore();
    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-one' });
    await expect(store.save({ origin: 'https://jira.example.com/some/path' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.save({ origin: 'http://jira.example.com' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.save({ token: 'x'.repeat(401) })).rejects.toMatchObject({ statusCode: 400 });
    // HTTP stays legal for a loopback address, and keeps the stored token.
    await expect(store.save({ origin: 'http://localhost:8080' }))
      .resolves.toMatchObject({ configured: true, origin: 'http://localhost:8080', hasToken: true });
    expect((await store.read()).instance.token).toBe('JIRA-one');
  });

  it('refuses a token when no instance is stored yet', async () => {
    const { store } = await makeStore();
    await expect(store.save({ token: 'JIRA-orphan' })).rejects.toMatchObject({ statusCode: 400 });
    expect((await store.read()).instance).toBeNull();
  });

  it('clears the connection on disconnect and on the empty token', async () => {
    const { store } = await makeStore();
    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-one' });
    await store.save({ token: '' });
    expect((await store.read()).instance).toBeNull();

    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-two' });
    expect(await store.clear()).toEqual({ configured: false });
    expect((await store.read()).instance).toBeNull();
  });

  it('treats a corrupt file as no connection rather than a broken boot', async () => {
    const { store, dataDir } = await makeStore();
    await fs.writeFile(path.join(dataDir, 'jira.json'), '{ not json', 'utf8');
    expect(await store.readPublic()).toEqual({ configured: false });
    await store.save({ origin: 'https://jira.example.com', token: 'JIRA-fresh' });
    expect((await store.read()).instance.token).toBe('JIRA-fresh');
  });
});
