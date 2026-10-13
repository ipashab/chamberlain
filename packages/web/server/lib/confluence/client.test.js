import { describe, expect, it, vi } from 'vitest';

import { classifyConfluenceFailure, createConfluenceRequest } from './client.js';

const config = { origin: 'https://confluence.example.com', token: 'CONF-test', verifySsl: true };

describe('classifyConfluenceFailure', () => {
  it('reads transport trouble as unreachable', () => {
    expect(classifyConfluenceFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable');
    expect(classifyConfluenceFailure(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
    expect(classifyConfluenceFailure(Object.assign(new Error('cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe('unreachable');
    expect(classifyConfluenceFailure(new Error('anything else'))).toBe('server-error');
  });
});

describe('createConfluenceRequest', () => {
  it('answers parsed JSON and carries the bearer token to the built URL', async () => {
    const fetchImpl = vi.fn(async ({ url, token }) => ({ status: 200, body: JSON.stringify({ id: '9001', title: 'Release checklist' }) }));
    const request = createConfluenceRequest({ fetchImpl });
    const result = await request({ config, path: '/rest/api/content/9001', search: '?expand=body.view' });
    expect(result).toEqual({ id: '9001', title: 'Release checklist' });
    expect(fetchImpl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://confluence.example.com/rest/api/content/9001?expand=body.view',
      token: 'CONF-test',
      verifySsl: true,
    }));
  });

  it('turns the statuses the reader reads into error kinds', async () => {
    const refusing = async (status) => {
      const fetchImpl = async () => ({ status, body: '' });
      return createConfluenceRequest({ fetchImpl })({ config, path: '/x' });
    };
    await expect(refusing(401)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(403)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(404)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(refusing(500)).rejects.toMatchObject({ kind: 'server-error' });
  });

  it('refuses to run without a configured instance', async () => {
    const fetchImpl = vi.fn();
    await expect(createConfluenceRequest({ fetchImpl })({ config: null, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wraps a dying transport as an unreachable error', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('socket gone'), { code: 'ECONNRESET' }); });
    await expect(createConfluenceRequest({ fetchImpl })({ config, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unreachable' });
  });
});
