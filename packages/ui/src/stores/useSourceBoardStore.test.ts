import { describe, expect, test } from 'bun:test';

import { useSourceBoardStore } from './useSourceBoardStore';

// What localStorage may hold: the store's own shape, an older or broken one, or anything else.
type StoredValue = string | { choices: string | Record<string, Record<string, string | number>> };

const merge = (persisted: StoredValue, current: ReturnType<typeof useSourceBoardStore.getState>) => {
  const options = useSourceBoardStore.persist.getOptions();
  if (!options.merge) throw new Error('The board store reads its own persisted shape');
  return options.merge(persisted, current);
};

describe('source board choice', () => {
  test('remembers the tab per runtime', () => {
    useSourceBoardStore.setState({ choices: {} });
    useSourceBoardStore.getState().update({ tab: 'issues' });
    const choices = Object.values(useSourceBoardStore.getState().choices);
    expect(choices).toEqual([{ tab: 'issues' }]);
  });

  test('keeps the readable parts of stored data and drops the rest', () => {
    const current = useSourceBoardStore.getState();
    // A tab an older build saved — the repository or Linear lists the board
    // no longer has, their project and team — reads back as the first tab.
    expect(merge({ choices: { local: { tab: 'repository', projectId: 'p1', linearTeamId: 't1' } } }, current).choices)
      .toEqual({ local: { tab: 'pulls' } });
    expect(merge({ choices: { local: { tab: 'nonsense' } } }, current).choices)
      .toEqual({ local: { tab: 'pulls' } });
    expect(merge('garbage', current).choices).toEqual({});
    expect(merge({ choices: 'garbage' }, current).choices).toEqual({});
  });
});
