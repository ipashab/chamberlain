import { describe, expect, test } from 'bun:test';
import type { JsonValue, Session } from '@/lib/opencode/model';
import { getCurrentSessionAdvisor } from './advisorMetadata';

// SAFETY: fixture carries only the fields getCurrentSessionAdvisor reads plus the required identity fields.
// The raw stored value is free-form JSON, so malformed fixtures type as JsonValue.
const session = (time: Session['time'], advisor: JsonValue): Session => ({
  id: 'ses_1',
  projectID: 'prj',
  directory: '/repo',
  title: 't',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time,
  metadata: { openchamber: { advisor } },
} as Session);

const payload: JsonValue = {
  at: 160,
  forMessageID: 'msg_1',
  findings: [
    { severity: 'P1', source: 'anchor', note: 'The last edit did not take.', file: 'src/app.py' },
    { severity: 'P3', source: 'rules', note: 'A noqa comment.' },
  ],
};

describe('getCurrentSessionAdvisor', () => {
  test('returns findings written after the last turn ended', () => {
    const advisor = getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, payload));
    expect(advisor?.forMessageID).toBe('msg_1');
    expect(advisor?.findings).toHaveLength(2);
    expect(advisor?.findings[0]).toEqual({ severity: 'P1', source: 'anchor', note: 'The last edit did not take.', file: 'src/app.py' });
    expect(advisor?.findings[1]).toEqual({ severity: 'P3', source: 'rules', note: 'A noqa comment.' });
  });

  test('a later turn retires it', () => {
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 300, idle: 300 }, payload))).toBeNull();
  });

  test('a reverted session has no current findings', () => {
    // SAFETY: the fixture is a Session; only the optional revert field is added.
    const reverted = { ...session({ created: 1, updated: 200, idle: 100 }, payload), revert: { messageID: 'msg_1' } } as Session;
    expect(getCurrentSessionAdvisor(reverted)).toBeNull();
  });

  test('a finding that fails its contract rejects the whole payload, never a half list', () => {
    // The server's own runtime writes these payloads, so a malformed entry
    // means corruption; silence is the honest answer, not a partial list.
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, {
      at: 160,
      forMessageID: 'msg_1',
      findings: [{ severity: 'P9', source: 'anchor', note: 'no such severity' }],
    }))).toBeNull();
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, {
      at: 160,
      forMessageID: 'msg_1',
      findings: [
        { severity: 'P1', source: 'rules', note: 'Good finding.' },
        { severity: 'P2', source: 'guess', note: 'no such source' },
      ],
    }))).toBeNull();
    // Keys the schema does not know are stripped by the parse, not carried:
    // the whole point of the boundary parse is a domain-shaped answer.
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, {
      at: 160,
      forMessageID: 'msg_1',
      findings: [{ severity: 'P2', source: 'model', note: 'Kept.', hint: 'unknown key' }],
    }))?.findings).toEqual([{ severity: 'P2', source: 'model', note: 'Kept.' }]);
  });

  test('an empty or malformed findings list is no payload', () => {
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, { at: 160, forMessageID: 'msg_1', findings: [] }))).toBeNull();
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, null))).toBeNull();
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, { at: 0, forMessageID: '', findings: payload.findings }))).toBeNull();
    expect(getCurrentSessionAdvisor(session({ created: 1, updated: 200, idle: 100 }, { at: 160, forMessageID: 'msg_1', findings: 'not a list' }))).toBeNull();
  });
});
