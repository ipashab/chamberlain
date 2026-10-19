import { describe, expect, it, vi } from 'vitest';

import { JiraError } from './client.js';
import { readMyJiraIssues } from './issue-mine.js';

const config = { origin: 'https://jira.example.com', token: 'JIRA-test', verifySsl: true };

describe('readMyJiraIssues', () => {
  it('asks the instance for the account\'s own open issues and maps the rows', async () => {
    const request = vi.fn(async ({ path }) => {
      expect(path).toBe('/rest/api/2/search');
      return {
        issues: [
          {
            key: 'DEMO-100',
            fields: { summary: 'отчёт allure', updated: '2026-10-12T10:00:00.000+0300', status: { name: 'В работе' }, issuetype: { name: 'История' } },
          },
          { key: null, fields: { summary: 'dropped' } },
        ],
      };
    });
    const result = await readMyJiraIssues({ request, config, limit: 50 });
    expect(result.issues).toEqual([
      {
        key: 'DEMO-100',
        url: 'https://jira.example.com/browse/DEMO-100',
        summary: 'отчёт allure',
        updated: '2026-10-12T10:00:00.000+0300',
        statusName: 'В работе',
        typeName: 'История',
      },
    ]);
    const { search } = request.mock.calls[0][0];
    expect(decodeURIComponent(search)).toContain('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
    expect(search).toContain('maxResults=50');
    expect(request.mock.calls[0][0].search).toContain('fields=summary,updated,status,issuetype');
  });

  it('never carries a caller word into the instance query', async () => {
    const request = vi.fn(async () => ({ issues: [] }));
    await readMyJiraIssues({ request, config, limit: 25 });
    // The JQL is the route's own fixed words: no caller input at all.
    expect(request).toHaveBeenCalledTimes(1);
    expect(Object.keys(request.mock.calls[0][0])).not.toContain('query');
  });

  it('classifies a shape the list cannot read as a server error', async () => {
    const request = vi.fn(async () => ({ issues: 'no' }));
    await expect(readMyJiraIssues({ request, config, limit: 50 })).rejects.toMatchObject({ kind: 'server-error' });
  });
});
