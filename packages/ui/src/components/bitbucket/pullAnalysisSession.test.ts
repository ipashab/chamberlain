import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The session module reads its memory through the safe storage; the tests
// own what sits under the keys by installing an in-memory storage before
// the module ever loads. The start action itself needs the full store
// stack, so what is tested here is the memory's own contract: v2 lists,
// the newest first, and the v1 lift that keeps an old single reading
// answering.
const backing = new Map<string, string>();
const sessionBacking = new Map<string, string>();
const makeStorage = (map: Map<string, string>): Storage => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => void map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  });
// The test owns what sits under the keys: an in-memory storage answers
// every getter the chain of the session module's imports asks of the
// real module — a plain JSON persist storage will do for all of them, the
// flush deferral is not what these tests read.
mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => makeStorage(backing),
  getSafeSessionStorage: () => makeStorage(sessionBacking),
  getDeferredSafeStorage: () => makeStorage(backing),
  createDeferredSafeJSONStorage: () => ({
    getItem: (name: string) => backing.get(name) ?? null,
    setItem: (name: string, value: string) => void backing.set(name, value),
    removeItem: (name: string) => void backing.delete(name),
  }),
}));

const { recallPullAnalysisHistory } = await import('./pullAnalysisSession');

const V2 = 'oc.bitbucket.pullAnalysis.v2';
const V1 = 'oc.bitbucket.pullAnalysis.v1';

const url = 'https://bitbucket.example/projects/DEMO/repos/demo-service/pull-requests/4242';

describe('pull analysis memory', () => {
  beforeEach(() => {
    backing.clear();
  });

  test('an empty memory answers no readings', () => {
    expect(recallPullAnalysisHistory(url)).toEqual([]);
  });

  test('v2 keeps the list newest first, per pull', () => {
    backing.set(V2, JSON.stringify({
      [url]: [
        { sessionId: 'ses_new', directory: '/work', startedAt: 200 },
        { sessionId: 'ses_old', directory: '/work', startedAt: 100 },
      ],
      'https://bitbucket.example/projects/DEMO/repos/demo-service/pull-requests/8500': [
        { sessionId: 'ses_other', directory: '/work', startedAt: 300 },
      ],
    }));
    expect(recallPullAnalysisHistory(url)).toEqual([
      { sessionId: 'ses_new', directory: '/work', startedAt: 200 },
      { sessionId: 'ses_old', directory: '/work', startedAt: 100 },
    ]);
  });

  test('a v1 single reading is lifted into a one-entry list', () => {
    backing.set(V1, JSON.stringify({
      [url]: { sessionId: 'ses_legacy', directory: '/work', startedAt: 50 },
    }));
    expect(recallPullAnalysisHistory(url)).toEqual([
      { sessionId: 'ses_legacy', directory: '/work', startedAt: 50 },
    ]);
  });

  test('a v2 list wins over the v1 entry it replaces', () => {
    backing.set(V1, JSON.stringify({
      [url]: { sessionId: 'ses_legacy', directory: '/work', startedAt: 50 },
    }));
    backing.set(V2, JSON.stringify({
      [url]: [{ sessionId: 'ses_new', directory: '/work', startedAt: 200 }],
    }));
    expect(recallPullAnalysisHistory(url)).toEqual([
      { sessionId: 'ses_new', directory: '/work', startedAt: 200 },
    ]);
  });

  test('a v1 reading of another pull still answers beside a v2 one', () => {
    const other = 'https://bitbucket.example/projects/DEMO/repos/demo-service/pull-requests/8500';
    backing.set(V2, JSON.stringify({
      [url]: [{ sessionId: 'ses_new', directory: '/work', startedAt: 200 }],
    }));
    backing.set(V1, JSON.stringify({
      [other]: { sessionId: 'ses_legacy', directory: '/work', startedAt: 50 },
    }));
    expect(recallPullAnalysisHistory(other)).toEqual([
      { sessionId: 'ses_legacy', directory: '/work', startedAt: 50 },
    ]);
  });

  test('foreign or half-written maps read as an empty memory', () => {
    backing.set(V2, '{not json');
    expect(recallPullAnalysisHistory(url)).toEqual([]);
    backing.set(V2, JSON.stringify({ [url]: 'not-a-list' }));
    expect(recallPullAnalysisHistory(url)).toEqual([]);
  });
});
