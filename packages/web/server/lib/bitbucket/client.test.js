import { describe, expect, it, vi } from 'vitest';

import { createBitbucketRequest, classifyBitbucketFailure } from './client.js';

const config = { origin: 'https://bitbucket.example.com', context: '', token: 'BBDC-test', verifySsl: true };

describe('classifyBitbucketFailure', () => {
  it('reads transport trouble as unreachable', () => {
    expect(classifyBitbucketFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable');
    expect(classifyBitbucketFailure(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe('unreachable');
    expect(classifyBitbucketFailure(Object.assign(new Error('cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe('unreachable');
    expect(classifyBitbucketFailure(new Error('anything else'))).toBe('server-error');
  });
});

describe('createBitbucketRequest', () => {
  it('answers parsed JSON and carries the bearer token to the built URL', async () => {
    const fetchImpl = vi.fn(async ({ url, token }) => ({ status: 200, body: JSON.stringify({ title: 'Ship it', state: 'OPEN' }) }));
    const request = createBitbucketRequest({ fetchImpl });
    const result = await request({ config, path: '/rest/api/1.0/projects/OC/repos/core/pull-requests/42' });
    expect(result).toEqual({ title: 'Ship it', state: 'OPEN' });
    expect(fetchImpl).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://bitbucket.example.com/rest/api/1.0/projects/OC/repos/core/pull-requests/42',
      token: 'BBDC-test',
      verifySsl: true,
    }));
  });

  it('keeps a context path between the origin and the API path', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, body: '{}' }));
    await createBitbucketRequest({ fetchImpl })({
      config: { ...config, context: '/bitbucket' },
      path: '/rest/api/1.0/projects/OC/repos/core/pull-requests/1',
    });
    expect(fetchImpl.mock.calls[0][0].url).toBe('https://bitbucket.example.com/bitbucket/rest/api/1.0/projects/OC/repos/core/pull-requests/1');
  });

  it('turns the statuses the board reads into error kinds', async () => {
    const refusing = async (status) => {
      const fetchImpl = async () => ({ status, body: '' });
      return createBitbucketRequest({ fetchImpl })({ config, path: '/x' });
    };
    await expect(refusing(401)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(403)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(refusing(404)).rejects.toMatchObject({ kind: 'not-found' });
    await expect(refusing(500)).rejects.toMatchObject({ kind: 'server-error' });
  });

  it('refuses to run without a configured instance', async () => {
    const fetchImpl = vi.fn();
    await expect(createBitbucketRequest({ fetchImpl })({ config: null, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wraps a dying transport as an unreachable error', async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error('socket gone'), { code: 'ECONNRESET' }); });
    await expect(createBitbucketRequest({ fetchImpl })({ config, path: '/x' }))
      .rejects.toMatchObject({ kind: 'unreachable' });
  });
});
