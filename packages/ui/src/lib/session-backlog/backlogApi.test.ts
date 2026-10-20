import { describe, expect, test } from 'bun:test';

import { runtimeFetch } from '@/lib/runtime-fetch';

import { backlogApi } from './backlogApi';

// The API client is the wire boundary: a shape the server did not send must
// fail the fetch, and a graded error must keep the server's own words.

const item = { id: 'bl_1', text: 'Do the audit', createdAt: 100 };

type FetchLog = { url: string; init?: RequestInit };

const fetchAnswering = (responses: Record<string, { status?: number; body: unknown }>) => {
  const log: FetchLog[] = [];
  const fetchImpl: typeof runtimeFetch = async (rawInput, init) => {
    const path = String(rawInput);
    log.push({ url: path, init });
    const answer = responses[path];
    if (!answer) {
      return new Response(JSON.stringify({ error: 'unexpected route' }), { status: 404 });
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetchImpl, log };
};

describe('backlogApi', () => {
  test('lists the backlog of a session with its draining flag', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/backlog?sessionID=ses_1': { body: { sessionID: 'ses_1', items: [item], draining: true } },
    });
    const { items, draining } = await backlogApi.list('ses_1', fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('Do the audit');
    expect(draining).toBe(true);
  });

  test('keeps a missing draining flag honest as false', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/backlog?sessionID=ses_1': { body: { sessionID: 'ses_1', items: [] } },
    });
    const { items, draining } = await backlogApi.list('ses_1', fetchImpl);
    expect(items).toEqual([]);
    expect(draining).toBe(false);
  });

  test('fails a list answer that does not match the contract', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/backlog?sessionID=ses_1': { body: { sessionID: 'ses_1' } },
    });
    await expect(backlogApi.list('ses_1', fetchImpl)).rejects.toThrow('expected shape');
  });

  test('carries the server message from a graded failure', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/backlog?sessionID=ses_1': { status: 500, body: { error: 'The backlog for this session could not be read' } },
    });
    await expect(backlogApi.list('ses_1', fetchImpl)).rejects.toThrow('could not be read');
  });

  test('removes one item and clears, both with the session named in the body', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/backlog/remove': { body: { sessionID: 'ses_1', itemID: 'bl_1', removed: true } },
      '/api/openchamber/backlog/clear': { body: { sessionID: 'ses_1', removed: 2 } },
    });
    expect(await backlogApi.remove('ses_1', 'bl_1', fetchImpl)).toBe(true);
    expect(log[0].url).toBe('/api/openchamber/backlog/remove');
    expect(String(log[0].init?.body)).toContain('"sessionID":"ses_1"');
    expect(String(log[0].init?.body)).toContain('"itemID":"bl_1"');
    expect(await backlogApi.clear('ses_1', fetchImpl)).toBe(2);
    expect(log[1].url).toBe('/api/openchamber/backlog/clear');
  });

  test('starts the drain and parses the outcome', async () => {
    const { fetchImpl, log } = fetchAnswering({
      '/api/openchamber/backlog/run': {
        body: { sessionID: 'ses_1', started: true, staged: 3, note: 'Each staged item runs as its own turn' },
      },
    });
    const outcome = await backlogApi.run('ses_1', fetchImpl);
    expect(outcome.started).toBe(true);
    expect(outcome.staged).toBe(3);
    expect(log[0].init?.method).toBe('POST');
  });

  test('trims a drain refusal to the server words', async () => {
    const { fetchImpl } = fetchAnswering({
      '/api/openchamber/backlog/run': { status: 409, body: { error: 'The backlog of this session is empty' } },
    });
    await expect(backlogApi.run('ses_1', fetchImpl)).rejects.toThrow('empty');
  });
});
