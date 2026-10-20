import { describe, expect, it } from 'vitest';

import { isString } from '../shared/guards.js';
import {
  CONTACT_ACTION_DEFINITIONS,
  CONTACT_ACTIONS,
  CONTACT_PARAMETER_PROPERTIES,
  contactRunBounds,
  contactWaitBounds,
  resolveContactAction,
} from './tools.js';

describe('CONTACT_ACTION_DEFINITIONS', () => {
  it('keeps the delegation grammar the agent is taught', () => {
    expect(CONTACT_ACTIONS).toEqual(['contact.list', 'contact.run', 'contact.wait']);
    expect(CONTACT_ACTION_DEFINITIONS.every(({ action, title, description }) =>
      isString(action)
      && action.length > 0
      && title.length > 0
      && description.length > 0)).toBe(true);
  });

  it('describes every parameter the schema declares', () => {
    const joined = CONTACT_ACTION_DEFINITIONS.map(({ description }) => description).join(' ');
    for (const parameter of Object.keys(CONTACT_PARAMETER_PROPERTIES)) {
      expect(joined).toContain(parameter);
    }
  });
});

describe('resolveContactAction', () => {
  it('accepts a known action, trimmed and case-insensitive', () => {
    expect(resolveContactAction('contact.run')).toEqual({ action: 'contact.run' });
    expect(resolveContactAction('  Contact.Wait  ')).toEqual({ action: 'contact.wait' });
  });

  it('names the grammar for everything that is not an action', () => {
    expect(resolveContactAction('contact.send')).toMatchObject({
      error: expect.stringContaining('Unknown contact action: contact.send'),
    });
    expect(resolveContactAction('').error).toContain('missing');
    expect(resolveContactAction(null).error).toContain('Unknown contact action');
    expect(resolveContactAction(42).error).toContain('Unknown contact action');
    expect(resolveContactAction('contact.run').error).toBeUndefined();
  });

  it('bounds the wait window and the run the schema teaches', () => {
    expect(contactWaitBounds).toEqual({ min: 1_000, max: 900_000, default: 300_000 });
    expect(contactRunBounds.taskMax).toBe(40_000);
    expect(contactRunBounds.pollInterval).toBeGreaterThan(0);
    expect(contactRunBounds.answerPage).toBeGreaterThan(0);
  });
});
