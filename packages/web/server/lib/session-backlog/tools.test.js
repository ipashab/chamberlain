import { describe, expect, it } from 'vitest';

import { isString } from '../shared/guards.js';
import {
  BACKLOG_ACTION_DEFINITIONS,
  BACKLOG_ACTIONS,
  BACKLOG_PARAMETER_PROPERTIES,
  backlogDrainBounds,
  resolveBacklogAction,
} from './tools.js';

describe('BACKLOG_ACTION_DEFINITIONS', () => {
  it('keeps the queue grammar the agent is taught', () => {
    expect(BACKLOG_ACTIONS).toEqual(['backlog.list', 'backlog.add', 'backlog.remove', 'backlog.clear', 'backlog.run']);
    expect(BACKLOG_ACTION_DEFINITIONS.every(({ action, title, description }) =>
      isString(action)
      && action.length > 0
      && title.length > 0
      && description.length > 0)).toBe(true);
  });

  it('describes every parameter the schema declares', () => {
    const joined = BACKLOG_ACTION_DEFINITIONS.map(({ description }) => description).join(' ');
    for (const parameter of Object.keys(BACKLOG_PARAMETER_PROPERTIES)) {
      expect(joined).toContain(parameter);
    }
  });
});

describe('resolveBacklogAction', () => {
  it('accepts a known action, trimmed and case-insensitive', () => {
    expect(resolveBacklogAction('backlog.run')).toEqual({ action: 'backlog.run' });
    expect(resolveBacklogAction('  Backlog.List ')).toEqual({ action: 'backlog.list' });
  });

  it('names the grammar for everything that is not an action', () => {
    expect(resolveBacklogAction('backlog.send')).toMatchObject({
      error: expect.stringContaining('Unknown backlog action: backlog.send'),
    });
    expect(resolveBacklogAction('').error).toContain('missing');
    expect(resolveBacklogAction(null).error).toContain('Unknown backlog action');
    expect(resolveBacklogAction(42).error).toContain('Unknown backlog action');
  });

  it('bounds the drain the schema teaches', () => {
    expect(backlogDrainBounds.firstIdleWindowMs).toBeGreaterThan(0);
    expect(backlogDrainBounds.itemRunWindowMs).toBeGreaterThan(0);
    expect(backlogDrainBounds.pollIntervalMs).toBeGreaterThan(0);
    expect(backlogDrainBounds.answerPage).toBeGreaterThan(0);
  });
});
