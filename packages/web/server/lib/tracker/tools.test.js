import { describe, expect, it } from 'vitest';

import { isString } from '../shared/guards.js';
import {
  TRACKER_ACTION_DEFINITIONS,
  TRACKER_ACTIONS,
  parseTrackerRef,
  resolveTrackerAction,
} from './tools.js';

describe('TRACKER_ACTION_DEFINITIONS', () => {
  it('keeps the entity grammar the agent is taught', () => {
    expect(TRACKER_ACTIONS).toEqual([
      'pr.view',
      'pr.comment',
      'pr.approve',
      'issue.view',
      'issue.comment',
      'issue.transitions',
      'issue.transition',
    ]);
    expect(TRACKER_ACTION_DEFINITIONS.every(({ action, title, description }) =>
      isString(action)
      && action.length > 0
      && title.length > 0
      && description.length > 0)).toBe(true);
  });
});

describe('parseTrackerRef', () => {
  it('reads a pr:// scheme off a full pull URL', () => {
    const ref = parseTrackerRef('pr', 'pr://https://bitbucket.example.com/projects/OC/repos/core/pull-requests/42');
    expect(ref).toMatchObject({
      origin: 'https://bitbucket.example.com',
      project: 'OC',
      slug: 'core',
      number: 42,
    });
  });

  it('reads a bare Bitbucket pull URL the same way', () => {
    const ref = parseTrackerRef('pr', 'https://bitbucket.example.com/projects/OC/repos/core/pull-requests/42');
    expect(ref?.number).toBe(42);
  });

  it('reads an issue:// scheme off a bare key and off a browse URL', () => {
    expect(parseTrackerRef('issue', 'issue://OC-42')?.key).toBe('OC-42');
    const ref = parseTrackerRef('issue', 'issue://https://jira.example.com/browse/OC-42');
    expect(ref).toMatchObject({ origin: 'https://jira.example.com', key: 'OC-42' });
  });

  it('answers null for refs that name no entity, not a throw', () => {
    expect(parseTrackerRef('pr', null)).toBeNull();
    expect(parseTrackerRef('pr', '')).toBeNull();
    expect(parseTrackerRef('pr', 42)).toBeNull();
    expect(parseTrackerRef('pr', 'pr://https://example.com/not-a-pull')).toBeNull();
    expect(parseTrackerRef('issue', null)).toBeNull();
    expect(parseTrackerRef('issue', 'issue://not a key')).toBeNull();
    expect(parseTrackerRef('issue', 'issue://')).toBeNull();
  });
});

describe('resolveTrackerAction', () => {
  it('resolves every action the grammar names', () => {
    for (const action of TRACKER_ACTIONS) {
      expect(resolveTrackerAction(action)).toEqual({ action });
    }
  });

  it('answers pr-prefixed misses with the pull actions only', () => {
    const resolution = resolveTrackerAction('pr.merge');
    expect(resolution.error).toContain('Unsupported pull request action: pr.merge');
    expect(resolution.error).toContain('pr.view, pr.comment, pr.approve');
  });

  it('answers issue-prefixed misses with the issue actions only', () => {
    const resolution = resolveTrackerAction('issue.assign');
    expect(resolution.error).toContain('Unsupported issue action: issue.assign');
    expect(resolution.error).toContain('issue.view, issue.comment, issue.transitions, issue.transition');
  });

  it('answers anything else with the whole grammar and both ref forms', () => {
    const resolution = resolveTrackerAction('merge');
    expect(resolution.error).toContain('Unsupported tracker action: merge.');
    expect(resolution.error).toContain('pr://<full Bitbucket pull-request URL>');
    expect(resolution.error).toContain('issue://<Jira browse URL or issue key>');
    expect(resolveTrackerAction('').error).toContain('missing');
  });
});
