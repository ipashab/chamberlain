import { describe, expect, it, vi } from 'vitest';

import { classifyJiraFailure, createJiraRequest } from './client.js';

const config = { origin: 'https://jira.example.com', token: 'JIRA-test', verifySsl: true };

describe('classifyJiraFailure', () => {
  it('reads transport trouble as unreachable', () => {
    expect(classifyJiraFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable');
    expect(classifyJiraFailure(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
    expect(classifyJiraFailure(Object.assign(new Error('cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe('unreachable');
    expect(classifyJiraFailure(new Error('anything else'))).toBe('server-error');
  });
});

describe('createJiraRequest', () => {
  it('answers parsed JSON and carries the bearer token to the built URL', async () => {
    const fetchImpl = vi.fn(async ({ url, token }) => ({ status: 200, body: JSON.stringify({ key: 'DEMO-1', fields: { summary: 'Ship it' } }) }));
    const request = createJiraRequest({ fetchImpl });
    const result = await request({ config, path: '/rest/api/2/issue/DEMO-1' });
    expect(result).toEqual({ key: 'DEMO-1', fields: { summary: 'Ship it' } });
    expect(fetchImpl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://jira.example.com/rest/api/2/issue/DEMO-1',
      token: 'JIRA-test',
      verifySsl: true,
    }));
  });

  it('turns the statuses the viewer reads into error kinds', async () => {
    const refusing = async (status) => {
      const fetchImpl = async () => ({ status, body: '' });
      return createJiraRequest({ fetchImpl })({ config, path: '/x' });
    };
    await expect(refusing(401)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(403)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(404)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(refusing(500)).rejects.toMatchObject({ kind: 'server-error' });
  });

  it('refuses to run without a configured instance', async () => {
    const fetchImpl = vi.fn();
    await expect(createJiraRequest({ fetchImpl })({ config: null, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wraps a dying transport as an unreachable error', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('socket gone'), { code: 'ECONNRESET' }); });
    await expect(createJiraRequest({ fetchImpl })({ config, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unreachable' });
  });
});
