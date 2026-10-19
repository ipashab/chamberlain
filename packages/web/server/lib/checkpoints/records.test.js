import { describe, expect, it } from 'vitest';
import { collectTurnFiles } from './records.js';

const editPart = (input, { status = 'completed', id = 'part_1', tool = 'edit' } = {}) => ({
  id,
  type: 'tool',
  tool,
  state: { status, input },
});

const page = (records, next = null) => ({ data: records, cursor: next ? { next } : null });

const assistant = (id, content) => ({
  id,
  type: 'assistant',
  content,
});

describe('collectTurnFiles', () => {
  const edit = editPart({ path: 'a.py', oldString: 'foo', newString: 'bar' }, { id: 'p1' });
  const never = () => {
    throw new Error('pagination must stop once the turn boundary is read');
  };
  const readPageOf = (pages) => () => {
    const next = pages.shift();
    if (!next) return Promise.reject(new Error('no page left'));
    return Promise.resolve(next);
  };

  it('collects the files of the newest turn, first seen first', async () => {
    const records = [
      { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
      assistant('a_1', [
        edit,
        editPart({ path: 'a.py', oldString: 'foo', newString: 'baz' }, { id: 'p2' }),
        editPart({ path: 'b.txt', content: 'written' }, { id: 'p3', tool: 'write' }),
      ]),
      { id: 'u_1', type: 'user', text: 'Fix the bug' },
    ];
    const turn = await collectTurnFiles({ readPage: readPageOf([page(records)]), signal: new AbortController().signal });
    expect(turn).not.toBeNull();
    expect(turn.files).toEqual(['a.py', 'b.txt']);
    expect(turn.userMessageID).toBe('u_1');
    expect(turn.lastAssistantID).toBe('a_1');
  });

  it('accepts a context-text user message as the turn boundary', async () => {
    const records = [
      assistant('a_1', [edit]),
      { id: 'u_1', type: 'user', text: '', metadata: { openchamberContext: { text: 'its prompt' } } },
    ];
    const turn = await collectTurnFiles({ readPage: readPageOf([page(records)]), signal: new AbortController().signal });
    expect(turn?.userMessageID).toBe('u_1');
  });

  it('skips model and agent switches the way the transcript does', async () => {
    const records = [
      { id: 'a_2', type: 'assistant', content: [edit] },
      { id: 'switch_1', type: 'model-switched' },
      { id: 'a_1', type: 'assistant', content: [] },
      { id: 'u_1', type: 'user', text: 'Go' },
    ];
    const turn = await collectTurnFiles({ readPage: readPageOf([page(records)]), signal: new AbortController().signal });
    expect(turn?.lastAssistantID).toBe('a_2');
  });

  it('answers null for a turn without file-changing calls', async () => {
    const records = [
      assistant('a_1', []),
      { id: 'u_1', type: 'user', text: 'Just talk' },
    ];
    await expect(
      collectTurnFiles({ readPage: readPageOf([page(records)]), signal: new AbortController().signal }),
    ).resolves.toBeNull();
  });

  it('stops paging at the turn boundary instead of reading the session', async () => {
    const first = [
      assistant('a_1', [edit]),
      { id: 'u_1', type: 'user', text: 'Fix it' },
    ];
    const turn = await collectTurnFiles({
      readPage: readPageOf([page(first, 'cursor-2'), { data: [never], cursor: null }]),
      signal: new AbortController().signal,
    });
    expect(turn?.files).toEqual(['a.py']);
  });

  it('answers null when the bounded read finds no turn boundary', async () => {
    // The second page repeats the cursor: pagination stops as circular rather
    // than walking the session forever.
    const records = [assistant('a_1', [edit])];
    await expect(
      collectTurnFiles({
        readPage: readPageOf([page(records, 'cursor-2'), page([], 'cursor-2')]),
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it('fails loudly on an unavailable page and honors an aborted signal', async () => {
    await expect(
      collectTurnFiles({ readPage: () => Promise.resolve({ data: null }), signal: new AbortController().signal }),
    ).rejects.toThrow('Session message page is unavailable');
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      collectTurnFiles({ readPage: () => Promise.resolve(page([])), signal: aborted.signal }),
    ).rejects.toThrow();
  });
});
