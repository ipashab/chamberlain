import { describe, expect, it, vi } from 'vitest';

import { JiraError } from './client.js';
import { readJiraIssueSearch } from './issue-search.js';

const config = { origin: 'https://jira.example.com', token: 'JIRA-test', verifySsl: true };

describe('readJiraIssueSearch', () => {
  it('matches plain words and maps the rows', async () => {
    const request = vi.fn(async ({ path }) => {
      expect(path).toBe('/rest/api/2/search');
      return {
        issues: [
          {
            key: 'DEMO-100',
            fields: { summary: 'allure report', updated: '2026-10-12T10:00:00.000+0300', status: { name: 'В работе' }, issuetype: { name: 'История' } },
          },
          { key: null, fields: { summary: 'dropped' } },
        ],
      };
    });
    const result = await readJiraIssueSearch({ request, config, query: 'allure report', limit: 10 });
    expect(result.issues).toEqual([
      {
        key: 'DEMO-100',
        url: 'https://jira.example.com/browse/DEMO-100',
        summary: 'allure report',
        updated: '2026-10-12T10:00:00.000+0300',
        statusName: 'В работе',
        typeName: 'История',
      },
    ]);
    const { search } = request.mock.calls[0][0];
    expect(decodeURIComponent(search)).toContain('text ~ "allure report*" ORDER BY updated DESC');
    expect(search).toContain('maxResults=10');
  });

  it('looks an issue key up exactly before falling back to the text match', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readJiraIssueSearch({ request, config, query: 'DEMO-3223' });
    const { search } = request.mock.calls[0][0];
    expect(decodeURIComponent(search)).toContain('issuekey = "DEMO-3223"');
  });

  it('turns prefix filters into equality clauses ANDed onto the text match', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readJiraIssueSearch({ request, config, query: 'allure assignee: ivanov status: In Progress' });
    const { search } = request.mock.calls[0][0];
    const jql = decodeURIComponent(search);
    expect(jql).toContain('text ~ "allure*"');
    expect(jql).toContain('assignee = "ivanov"');
    expect(jql).toContain('status = "In Progress"');
    expect(jql).not.toContain('text ~ "allure assignee"');
  });

  it('reads the value in the prefix token and uppercases project keys', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readJiraIssueSearch({ request, config, query: 'project:demo reporter:acoder' });
    const { search } = request.mock.calls[0][0];
    const jql = decodeURIComponent(search);
    expect(jql).toContain('project = "DEMO"');
    expect(jql).toContain('reporter = "acoder"');
  });

  it('sanitizes a clause value the same way it sanitizes words', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readJiraIssueSearch({ request, config, query: 'assignee: iv"an/ov' });
    const { search } = request.mock.calls[0][0];
    expect(decodeURIComponent(search)).toContain('assignee = "ivanov"');
  });

  it('answers an empty list without asking the instance when a prefix values nothing', async () => {
    const request = vi.fn();
    expect(await readJiraIssueSearch({ request, config, query: 'assignee:' })).toEqual({ issues: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('drops JQL metacharacters before the words reach the instance', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readJiraIssueSearch({ request, config, query: 'all"ure \\report/' });
    const { search } = request.mock.calls[0][0];
    expect(decodeURIComponent(search)).toContain('text ~ "allure report*"');
  });

  it('answers an empty list without asking the instance when nothing is left', async () => {
    const request = vi.fn();
    expect(await readJiraIssueSearch({ request, config, query: '" " ' })).toEqual({ issues: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it('classifies a search failure into the viewer kinds', async () => {
    const request = vi.fn(async () => { throw new JiraError('unauthorized', 'no', 401); });
    await expect(readJiraIssueSearch({ request, config, query: 'allure' })).rejects.toMatchObject({ kind: 'unauthorized' });
    const malformed = vi.fn(async () => ({ nothing: true }));
    await expect(readJiraIssueSearch({ request: malformed, config, query: 'allure' })).rejects.toMatchObject({ kind: 'server-error' });
  });
});
