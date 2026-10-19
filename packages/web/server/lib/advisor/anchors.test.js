import { describe, expect, it } from 'vitest';
import { verifyAnchors } from './anchors.js';

const recordsWith = (...records) => records;
const resolve = (dir, filePath) => `${dir}/${filePath}`;
const pageSignal = () => ({ throwIfAborted: () => {} });
const fileMap = (files) => {
  const map = new Map(files);
  return async (resolvedPath) => {
    if (!map.has(resolvedPath)) throw new Error('unexpected path');
    const content = map.get(resolvedPath);
    return content === null ? null : content;
  };
};
const dir = '/repo';

describe('edit anchors', () => {
  it('stay silent when the last edit took', async () => {
    const records = recordsWith({ kind: 'edit', path: 'a.py', oldString: 'foo', newString: 'bar' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/a.py`, 'x\nbar\ny\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([]);
  });

  it('call a P1 on an edit that did not take', async () => {
    const records = recordsWith({ kind: 'edit', path: 'a.py', oldString: 'foo', newString: 'bar' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/a.py`, 'still foo\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([{
      severity: 'P1',
      source: 'anchor',
      note: expect.stringContaining('did not take'),
      file: 'a.py',
    }]);
  });

  it('call a P2 when neither text survives a later rewrite', async () => {
    const records = recordsWith({ kind: 'edit', path: 'a.py', oldString: 'foo', newString: 'bar' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/a.py`, 'something else entirely\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings[0].severity).toBe('P2');
  });

  it('accept a surviving duplicate of the old text: only the new text decides', async () => {
    const records = recordsWith({ kind: 'edit', path: 'a.py', oldString: 'dup', newString: 'bar' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/a.py`, 'dup\nbar\ndup\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([]);
  });

  it('flag a deletion edit whose text is still there', async () => {
    const records = recordsWith({ kind: 'edit', path: 'a.py', oldString: 'foo', newString: '' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/a.py`, 'keep\nfoo\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings[0]).toMatchObject({ severity: 'P1', source: 'anchor' });
    expect(findings[0].note).toContain('still in the file');
  });

  it('check only the last of several edits to one file', async () => {
    const records = recordsWith(
      { kind: 'edit', path: 'a.py', oldString: 'first', newString: 'second' },
      { kind: 'edit', path: 'a.py', oldString: 'second', newString: 'third' },
    );
    const findings = await verifyAnchors({
      records,
      // The first edit's text is legitimately gone; only the last is checked.
      readFile: fileMap([[`${dir}/a.py`, 'third\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([]);
  });
});

describe('write integrity and missing files', () => {
  it('report a file different from the turn\u2019s last write as P2', async () => {
    const records = recordsWith({ kind: 'write', path: 'new.txt', content: 'written' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/new.txt`, 'written\nby someone\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings[0]).toMatchObject({ severity: 'P2', source: 'anchor' });
  });

  it('report a disappeared file as P1 and skip files nobody can read', async () => {
    const records = recordsWith(
      { kind: 'edit', path: 'gone.py', oldString: 'foo', newString: 'bar' },
      { kind: 'write', path: 'locked.txt', content: 'irrelevant' },
    );
    const findings = await verifyAnchors({
      records,
      readFile: async (resolvedPath) => {
        if (resolvedPath === `${dir}/gone.py`) return null;
        throw new Error('EACCES');
      },
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'P1', source: 'anchor', file: 'gone.py' });
  });

  it('stay silent for write content that matches disk', async () => {
    const records = recordsWith({ kind: 'write', path: 'same.txt', content: 'written' });
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/same.txt`, 'written']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([]);
  });

  it('are unaffected by patch calls: no string anchor to check', async () => {
    const records = recordsWith({ kind: 'patch', path: 'p.diff', patchText: '+x\n' });
    const findings = await verifyAnchors({
      records,
      readFile: async () => { throw new Error('no file may be read for a patch'); },
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings).toEqual([]);
  });

  it('sort findings back into the turn\u2019s record order', async () => {
    const records = recordsWith(
      { kind: 'write', path: 'z.txt', content: 'a' },
      { kind: 'edit', path: 'a.py', oldString: 'foo', newString: 'bar' },
    );
    const findings = await verifyAnchors({
      records,
      readFile: fileMap([[`${dir}/z.txt`, 'b'], [`${dir}/a.py`, 'foo\n']]),
      resolvePath: (filePath) => resolve(dir, filePath),
      signal: pageSignal(),
    });
    expect(findings.map((finding) => finding.file)).toEqual(['z.txt', 'a.py']);
  });
});
