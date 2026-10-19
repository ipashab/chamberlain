import { describe, expect, it } from 'vitest';
import {
  addedText,
  buildReviewDigest,
  collectTurnEdits,
  lastRecordPerFile,
  normalizeToolName,
  readToolRecord,
} from './records.js';

const editPart = (input, { status = 'completed', id = 'part_1', tool = 'edit' } = {}) => ({
  id,
  type: 'tool',
  tool,
  state: { status, input },
});

const page = (records, next = null) => ({ data: records, cursor: next ? { next } : null });

const assistant = (id, content, extra = {}) => ({
  id,
  type: 'assistant',
  content,
  model: { providerID: 'prov', id: 'model-a' },
  time: { created: 10, completed: 11 },
  ...extra,
});

describe('normalizeToolName', () => {
  it('keeps the comparable form the UI defines', () => {
    expect(normalizeToolName('Edit')).toBe('edit');
    expect(normalizeToolName('edit:2')).toBe('edit');
    expect(normalizeToolName('opencode.edit')).toBe('edit');
    expect(normalizeToolName(undefined)).toBe('');
  });
});

describe('readToolRecord', () => {
  it('reads a completed edit call with either path field', () => {
    expect(readToolRecord(editPart({ path: 'a.py', oldString: 'foo', newString: 'bar' }))).toMatchObject({
      kind: 'edit', path: 'a.py', oldString: 'foo', newString: 'bar',
    });
    expect(readToolRecord(editPart({ filePath: 'a.py', oldString: 'foo', newString: 'bar' }))).toMatchObject({ path: 'a.py' });
  });

  it('keeps a deletion edit: empty new text is a valid edit, not a skip', () => {
    expect(readToolRecord(editPart({ path: 'a.py', oldString: 'gone', newString: '' }))).toMatchObject({
      oldString: 'gone', newString: '',
    });
  });

  it('drops anything unfinished or malformed', () => {
    expect(readToolRecord(editPart({ path: 'a.py', oldString: 'foo', newString: 'bar' }, { status: 'running' }))).toBeNull();
    expect(readToolRecord(editPart({ path: 'a.py', oldString: 'foo' }))).toBeNull();
    expect(readToolRecord(editPart({ oldString: 'foo', newString: 'bar' }))).toBeNull();
    expect(readToolRecord(editPart({ path: 'a.py', content: 'x' }, { tool: 'read' }))).toBeNull();
  });

  it('reads write content and patch text', () => {
    expect(readToolRecord(editPart({ path: 'a.txt', content: 'hello' }, { tool: 'write' }))).toMatchObject({
      kind: 'write', content: 'hello',
    });
    expect(readToolRecord(editPart({ path: 'a.diff', patchText: '--- a\n+++ b\n+new' }, { tool: 'patch' }))).toMatchObject({
      kind: 'patch', patchText: '--- a\n+++ b\n+new',
    });
  });
});

describe('addedText', () => {
  it('contributes only what a call added to the file', () => {
    expect(addedText({ kind: 'edit', newString: 'new' })).toBe('new');
    expect(addedText({ kind: 'write', content: 'file' })).toBe('file');
    expect(addedText({ kind: 'patch', patchText: '+++ b/f\n+a\n context\n+c\n+++ done' })).toBe('a\nc');
  });
});

describe('lastRecordPerFile', () => {
  it('lets the last call per file decide; patch calls do not decide', () => {
    const records = [
      { kind: 'edit', path: 'a.py' },
      { kind: 'edit', path: 'a.py' },
      { kind: 'patch', path: 'b.py' },
    ];
    const last = lastRecordPerFile(records);
    expect(last.size).toBe(1);
    expect(last.get('a.py')).toBe(records[1]);
  });
});

describe('buildReviewDigest', () => {
  it('says when it dropped earlier work for size', () => {
    const records = Array.from({ length: 14 }, (_, index) => ({
      kind: 'write', path: `file-${index}.txt`, content: 'x'.repeat(900),
    }));
    const digest = buildReviewDigest(records);
    expect(digest).toContain('write file-13.txt');
    expect(digest).toContain('earlier change(s) omitted for size]');
    expect(digest.length).toBeLessThan(16_000);
  });

  it('is silent when everything fits', () => {
    const digest = buildReviewDigest([{ kind: 'write', path: 'a.txt', content: 'hi' }]);
    expect(digest).toBe('write a.txt (2 chars)\nhi');
  });
});

describe('collectTurnEdits', () => {
  const edit = editPart({ path: 'a.py', oldString: 'foo', newString: 'bar' }, { id: 'p1' });
  const never = () => { throw new Error('pagination must stop once the turn boundary is read'); };
  const readPageOf = (pages) => () => {
    const next = pages.shift();
    if (!next) return Promise.reject(new Error('no page left'));
    return Promise.resolve(next);
  };

  it('collects the completed file changes after the newest user message', async () => {
    const records = [
      { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
      assistant('a_1', [edit]),
      { id: 'u_1', type: 'user', text: 'Fix the bug' },
    ];
    const turn = await collectTurnEdits({ readPage: readPageOf([page(records)]), signal: new AbortController().signal });
    expect(turn).not.toBeNull();
    expect(turn.records).toHaveLength(1);
    expect(turn.lastAssistantId).toBe('a_1');
    expect(turn.preferred).toEqual({ providerID: 'prov', modelID: 'model-a' });
    expect(turn.humanText).toBe('Fix the bug');
  });

  it('stops paging at the turn boundary instead of reading the session', async () => {
    const first = [
      { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
      assistant('a_1', [edit]),
      { id: 'u_1', type: 'user', text: 'Fix it' },
    ];
    const turn = await collectTurnEdits({
      readPage: readPageOf([page(first, 'cursor-2'), { data: [never], cursor: null }]),
      signal: new AbortController().signal,
    });
    // cursor-2 was returned but never followed: the boundary was in page one.
    expect(turn.records).toHaveLength(1);
  });

  it('returns null for a turn without file changes, reading on over the cursor', async () => {
    const pages = [
      page([{ id: 'idle_1', type: 'idle', outcome: 'succeeded' }, assistant('a_1', [{ type: 'text', text: 'done' }]), { id: 'u_1', type: 'user', text: 'Hi' }]),
    ];
    await expect(collectTurnEdits({ readPage: readPageOf(pages), signal: new AbortController().signal })).resolves.toBeNull();
  });

  it('ignores agent and model switches while finding the turn', async () => {
    const records = [
      { id: 'idle_1', type: 'idle', outcome: 'succeeded' },
      { id: 'sw_1', type: 'model-switched', model: {} },
      assistant('a_1', [edit]),
      { id: 'u_1', type: 'user', text: 'Go' },
    ];
    const turn = await collectTurnEdits({ readPage: readPageOf([page(records)]), signal: new AbortController().signal });
    expect(turn.records).toHaveLength(1);
  });

  it('throws when a page is malformed or pagination circles, so one broken read is not a clean no-findings', async () => {
    await expect(collectTurnEdits({ readPage: async () => ({ cursor: null }), signal: new AbortController().signal })).rejects.toThrow('unavailable');
    await expect(collectTurnEdits({
      readPage: readPageOf([page([assistant('a_1', [edit])], 'cursor-2'), page([{ id: 'a_2' }], 'cursor-2')]),
      signal: new AbortController().signal,
    })).rejects.toThrow('made no progress');
  });
});
