import { describe, expect, it } from 'vitest';
import { applyRules, compileUserRules, DEFAULT_RULES } from './rules.js';

const editRecord = (path, newString) => ({ kind: 'edit', path, oldString: 'old', newString });
const writeRecord = (path, content) => ({ kind: 'write', path, content });

describe('default rules', () => {
  it('catch the suppression patterns the fork bans', () => {
    const findings = applyRules([
      editRecord('service.py', 'value = compute()  # type: ignore[no-any-return]'),
      editRecord('linted.py', 'x = 1  # noqa: F401'),
      editRecord('widget.tsx', 'console.log("here")\n' + 'debugger;\n'),
      editRecord('handler.py', 'try:\n    run()\nexcept Exception:\n    pass\n'),
      editRecord('handler.py', 'except:\n'),
    ]);
    const notes = findings.map((finding) => `${finding.severity}:${finding.note}`);
    expect(notes.join('\n')).toContain('type-ignore');
    expect(notes.join('\n')).toContain('noqa');
    expect(notes.join('\n')).toContain('console.log');
    expect(notes.join('\n')).toContain('debugger');
    expect(notes.join('\n')).toContain('swallows');
    expect(notes.join('\n')).toContain('bare except');
    expect(findings.every((finding) => finding.source === 'rules' && finding.file)).toBe(true);
  });

  it('leave untouched files alone: extension filters work', () => {
    const findings = applyRules([editRecord('notes.md', 'console.log("nope")\n' + 'debugger;\n')]);
    expect(findings).toEqual([]);
    expect(applyRules([editRecord('service.py', 'value = 1\n')])).toEqual([]);
  });

  it('report one finding per rule per file, however often it hits', () => {
    const findings = applyRules([editRecord('app.py', 'a  # type: ignore\nb  # type: ignore\nc  # type: ignore\n')]);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('app.py');
    expect(findings[0].severity).toBe('P2');
  });

  it('apply to write content and patch added lines like edit text', () => {
    expect(applyRules([writeRecord('gen.py', 'import pdb\npdb.set_trace()\n')])).toHaveLength(1);
    expect(applyRules([{ kind: 'patch', path: 'x.py', patchText: '+++ b/x.py\n+foo = 1  # type: ignore\n' }])).toHaveLength(1);
  });
});

describe('user rules', () => {
  it('compile a valid advisor-rules.json array and apply it after the defaults', () => {
    const { compiled, rejected } = compileUserRules([
      { pattern: 'MAGIC_TODO\\(', flags: 'i', message: 'A magic call was left in.', severity: 'P1', extensions: ['.py'] },
    ]);
    expect(rejected).toEqual([]);
    const findings = applyRules([editRecord('run.py', 'MAGIC_TODO(1)\nMAGIC_TODO(2)\n')], compiled);
    expect(findings).toEqual([{
      severity: 'P1',
      source: 'rules',
      note: 'A magic call was left in.',
      file: 'run.py',
    }]);
  });

  it('skip malformed entries with a reason, not a throw', () => {
    const { compiled, rejected } = compileUserRules([
      'a string, not an object',
      { pattern: '', message: 'x' },
      { pattern: '(', message: 'x' },
      { pattern: 'ok', flags: 'g', message: 'x' },
      { pattern: 'ok', message: 'x', severity: 'P9' },
      { pattern: 'ok', message: '', severity: 'P1' },
      { pattern: 'fine', message: 'works', severity: 'P0' },
    ]);
    expect(compiled).toHaveLength(1);
    expect(rejected.join('\n')).toContain('not an object');
    expect(rejected.join('\n')).toContain('no pattern');
    expect(rejected.join('\n')).toContain('does not compile');
    expect(rejected.join('\n')).toContain('unsupported flags');
    expect(rejected.join('\n')).toContain('P0-P3');
    expect(rejected.join('\n')).toContain('no message');
  });

  it('reject a payload that is not an array', () => {
    const { compiled, rejected } = compileUserRules({ pattern: 'x' });
    expect(compiled).toEqual([]);
    expect(rejected).toEqual(['the file must hold a JSON array']);
  });

  it('keep the default rules themselves compilable', () => {
    for (const rule of DEFAULT_RULES) {
      expect(() => new RegExp(rule.pattern, rule.flags)).not.toThrow();
    }
  });
});
