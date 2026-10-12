import { describe, expect, it } from 'vitest';

import { JIRA_ISSUE_KEY_PATTERN, parseJiraIssueRef } from './url.js';

describe('parseJiraIssueRef', () => {
  it('parses a full browse URL into origin, context and key', () => {
    expect(parseJiraIssueRef('https://jira.example.com/browse/DEMO-3223')).toEqual({
      scheme: 'https',
      origin: 'https://jira.example.com',
      context: '',
      key: 'DEMO-3223',
      canonicalUrl: 'https://jira.example.com/browse/DEMO-3223',
    });
  });

  it('parses a URL with a trailing slash and rebuilds the canonical form', () => {
    const ref = parseJiraIssueRef('http://jira.example.com:8080/browse/AQA-12/');
    expect(ref).toEqual({
      scheme: 'http',
      origin: 'http://jira.example.com:8080',
      context: '',
      key: 'AQA-12',
      canonicalUrl: 'http://jira.example.com:8080/browse/AQA-12',
    });
  });

  it('captures a context path so another deployment behind the same host can be refused', () => {
    const ref = parseJiraIssueRef('https://jira.example.com/jira/browse/DEMO-1');
    expect(ref?.context).toBe('/jira');
    expect(ref?.origin).toBe('https://jira.example.com');
  });

  it('parses a bare issue key against no named instance', () => {
    expect(parseJiraIssueRef('DEMO-3223')).toEqual({ origin: null, context: '', key: 'DEMO-3223', canonicalUrl: null });
    expect(parseJiraIssueRef('  AQA-7 ')).toEqual({ origin: null, context: '', key: 'AQA-7', canonicalUrl: null });
  });

  it('refuses what is neither a browse URL nor an issue key', () => {
    expect(parseJiraIssueRef('')).toBeNull();
    expect(parseJiraIssueRef('   ')).toBeNull();
    expect(parseJiraIssueRef('https://jira.example.com/projects/IDP/issues/DEMO-1')).toBeNull();
    expect(parseJiraIssueRef('https://jira.example.com/browse/idp-1')).toBeNull();
    expect(parseJiraIssueRef('https://jira.example.com/browse/1DEMO-1')).toBeNull();
    expect(parseJiraIssueRef('https://jira.example.com/browse/IDPD-')).toBeNull();
    expect(parseJiraIssueRef('idp-123')).toBeNull();
    expect(parseJiraIssueRef('concat DEMO-1 DEMO-2')).toBeNull();
    expect(parseJiraIssueRef(null)).toBeNull();
  });
});

describe('JIRA_ISSUE_KEY_PATTERN', () => {
  it('accepts real project keys and refuses look-alikes', () => {
    expect(JIRA_ISSUE_KEY_PATTERN.test('DEMO-3223')).toBe(true);
    expect(JIRA_ISSUE_KEY_PATTERN.test('AQA-7')).toBe(true);
    expect(JIRA_ISSUE_KEY_PATTERN.test('X1-123')).toBe(true);
    expect(JIRA_ISSUE_KEY_PATTERN.test('idp-123')).toBe(false);
    expect(JIRA_ISSUE_KEY_PATTERN.test('DEMO-')).toBe(false);
    expect(JIRA_ISSUE_KEY_PATTERN.test('-123')).toBe(false);
  });
});
