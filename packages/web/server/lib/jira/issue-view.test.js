import { describe, expect, it } from 'vitest';

import { JiraError } from './client.js';
import { readJiraIssueView } from './issue-view.js';

const config = { origin: 'https://jira.example.com', token: 'JIRA-test', verifySsl: true };

const person = (name, key) => ({
  displayName: name,
  key,
  name: key,
  avatarUrls: { '48x48': key ? `https://jira.example.com/secure/useravatar?ownerId=${key}` : undefined },
});

const makeIssueBody = ({ commentTotal = 2 } = {}) => ({
  key: 'DEMO-3223',
  names: {
    customfield_10014: 'Epic Link',
    customfield_10020: 'Sprint',
    customfield_10026: 'Story Points',
    customfield_10001: 'Teams',
    customfield_10002: 'Something Rich',
  },
  fields: {
    summary: 'Отладка автотестов',
    description: 'h2. wiki markup',
    created: '2026-09-30T15:35:00.000+0300',
    updated: '2026-10-12T10:38:00.000+0300',
    issuetype: { name: 'История', iconUrl: 'https://jira.example.com/images/icons/issuetypes/story.svg' },
    status: { name: 'В работе', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
    priority: { name: 'Medium', iconUrl: '/secure/viewavatar' },
    resolution: null,
    assignee: person('Alex Coder', 'a.coder'),
    reporter: person('Robin Stone', 'boris'),
    creator: person('Robin Stone', 'boris'),
    labels: ['automation'],
    components: [],
    fixVersions: [{ name: 'v2.2' }],
    versions: [],
    comment: {
      comments: [
        { id: '10001', body: 'wiki body', created: '2026-10-01T10:00:00.000+0300', updated: null, author: person('Alex Coder', 'a.coder'), updateAuthor: null },
        { id: '10002', body: 'edited wiki', created: '2026-10-01T11:00:00.000+0300', updated: '2026-10-02T11:00:00.000+0300', author: person('Robin Stone', 'boris'), updateAuthor: person('Alex Coder', 'a.coder') },
      ],
      total: commentTotal,
    },
    issuelinks: [
      {
        type: { name: 'Relation', inward: 'is related to', outward: 'relates to' },
        inwardIssue: { key: 'DEMO-3221', fields: { summary: 'первая', status: { name: 'ГОТОВО', statusCategory: { key: 'done', name: 'Done' } }, issuetype: { name: 'Task' } } },
      },
      {
        type: { name: 'Dependency', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { key: 'DEMO-2222', fields: { summary: 'блокер', status: { name: 'В РАБОТЕ', statusCategory: { key: 'indeterminate', name: 'In Progress' } }, issuetype: { name: 'Task' } } },
      },
      { type: null, inwardIssue: null, outwardIssue: null },
    ],
    subtasks: [
      { key: 'DEMO-9001', fields: { summary: 'подзадача', status: { name: 'Открыто', statusCategory: { key: 'new', name: 'To Do' } }, issuetype: { name: 'Sub-task' } } },
    ],
    attachment: [
      { id: '900', filename: 'report.zip', size: 1234, created: '2026-10-01T09:00:00.000+0300', author: person('Alex Coder', 'a.coder') },
    ],
    watches: { watchCount: 1 },
    customfield_10014: 'DEMO-210',
    customfield_10020: [{ name: '[AutoProduct] Sprint 2026Q4S1' }, { name: '[AutoProduct] Sprint 2026Q3S6' }],
    customfield_10026: 5,
    customfield_10001: { value: 'QA Auto Product' },
    customfield_10002: { someRichObject: { nested: true } },
    customfield_99999: 'not in the names map',
  },
  renderedFields: {
    description: '<p>rendered description</p>',
    comment: {
      comments: [
        { id: '10001', body: '<p>first html</p>' },
        { id: '10002', body: '<p>second html</p>' },
      ],
    },
  },
});

const makeRequest = ({ issueBody = makeIssueBody(), watchersBody = null, epicBody = null, failures = {} } = {}) =>
  async ({ path }) => {
    if (failures[path]) throw failures[path];
    if (path === '/rest/api/2/issue/DEMO-3223') return issueBody;
    if (path === '/rest/api/2/issue/DEMO-3223/watchers')
      return watchersBody ?? { watchCount: 1, watchers: [person('Alex Coder', 'a.coder')] };
    if (path === '/rest/api/2/issue/DEMO-210') return epicBody ?? { fields: { summary: 'Техдолг', status: { name: 'Blocked', statusCategory: { key: 'indeterminate', name: 'In Progress' } } } };
    throw new Error(`unexpected path ${path}`);
  };

const ref = { origin: null, context: '', key: 'DEMO-3223', canonicalUrl: null };

describe('readJiraIssueView', () => {
  it('assembles the whole view from the issue, the watchers and the epic', async () => {
    const request = makeRequest();
    const view = await readJiraIssueView({ request, config, ref });

    expect(view.issue).toMatchObject({
      key: 'DEMO-3223',
      url: 'https://jira.example.com/browse/DEMO-3223',
      summary: 'Отладка автотестов',
      type: { name: 'История', iconPath: '/images/icons/issuetypes/story.svg' },
      status: { name: 'В работе', category: 'indeterminate' },
      resolution: null,
      priority: { name: 'Medium', iconPath: '/secure/viewavatar' },
      created: '2026-09-30T15:35:00.000+0300',
      updated: '2026-10-12T10:38:00.000+0300',
      labels: ['automation'],
      fixVersions: ['v2.2'],
      watchCount: 1,
      watcherNames: ['Alex Coder'],
    });
    expect(view.issue.assignee).toEqual({
      name: 'Alex Coder',
      key: 'a.coder',
      avatarPath: '/secure/useravatar?ownerId=a.coder',
    });

    // Only what the names map names and what parses as a display shape: the
    // rich extension and the unnamed field are skipped, not guessed.
    expect(view.issue.customFields).toEqual([
      { id: 'customfield_10014', name: 'Epic Link', text: 'DEMO-210' },
      { id: 'customfield_10020', name: 'Sprint', text: '[AutoProduct] Sprint 2026Q4S1, [AutoProduct] Sprint 2026Q3S6' },
      { id: 'customfield_10026', name: 'Story Points', text: '5' },
      { id: 'customfield_10001', name: 'Teams', text: 'QA Auto Product' },
    ]);
    expect(view.issue.sprints).toEqual(['[AutoProduct] Sprint 2026Q4S1', '[AutoProduct] Sprint 2026Q3S6']);
    expect(view.issue.epic).toEqual({ key: 'DEMO-210', name: 'Техдолг', statusName: 'Blocked' });

    expect(view.description).toEqual({ wiki: 'h2. wiki markup', html: '<p>rendered description</p>' });
    expect(view.comments).toEqual([
      {
        id: '10001',
        author: { name: 'Alex Coder', key: 'a.coder', avatarPath: '/secure/useravatar?ownerId=a.coder' },
        created: '2026-10-01T10:00:00.000+0300',
        updated: null,
        edited: false,
        html: '<p>first html</p>',
        text: 'wiki body',
      },
      {
        id: '10002',
        author: { name: 'Robin Stone', key: 'boris', avatarPath: '/secure/useravatar?ownerId=boris' },
        created: '2026-10-01T11:00:00.000+0300',
        updated: '2026-10-02T11:00:00.000+0300',
        edited: true,
        html: '<p>second html</p>',
        text: 'edited wiki',
      },
    ]);

    expect(view.issueLinks).toEqual([
      {
        typeName: 'Relation',
        relation: 'is related to',
        issue: { key: 'DEMO-3221', summary: 'первая', statusName: 'ГОТОВО', typeName: 'Task' },
      },
      {
        typeName: 'Dependency',
        relation: 'blocks',
        issue: { key: 'DEMO-2222', summary: 'блокер', statusName: 'В РАБОТЕ', typeName: 'Task' },
      },
    ]);
    expect(view.subtasks).toEqual([
      { key: 'DEMO-9001', summary: 'подзадача', statusName: 'Открыто', typeName: 'Sub-task' },
    ]);
    expect(view.attachments).toEqual([
      { id: '900', filename: 'report.zip', size: 1234, created: '2026-10-01T09:00:00.000+0300', author: 'Alex Coder' },
    ]);
    expect(view.truncated).toEqual({ comments: false });
  });

  it('answers the canonical URL of a full-URL ref without re-asking the configured origin', async () => {
    const view = await readJiraIssueView({
      request: makeRequest(),
      config,
      ref: { origin: 'https://jira.example.com', context: '', key: 'DEMO-3223', canonicalUrl: 'https://jira.example.com/browse/DEMO-3223' },
    });
    expect(view.issue.url).toBe('https://jira.example.com/browse/DEMO-3223');
  });

  it('degrades the watchers when the page is permission-walled', async () => {
    const request = makeRequest({
      failures: { '/rest/api/2/issue/DEMO-3223/watchers': new JiraError('unauthorized', 'no', 403) },
    });
    const view = await readJiraIssueView({ request, config, ref });
    expect(view.issue.watchCount).toBe(1);
    expect(view.issue.watcherNames).toBeNull();
  });

  it('degrades the epic to its key when the epic read fails', async () => {
    const request = makeRequest({
      failures: { '/rest/api/2/issue/DEMO-210': new JiraError('not-found', 'no', 404) },
    });
    const view = await readJiraIssueView({ request, config, ref });
    expect(view.issue.epic).toEqual({ key: 'DEMO-210', name: null, statusName: null });
  });

  it('lets an unexpected error out instead of degrading to a quiet half-view', async () => {
    const request = makeRequest({
      failures: { '/rest/api/2/issue/DEMO-3223/watchers': new Error('boom') },
    });
    await expect(readJiraIssueView({ request, config, ref })).rejects.toThrow('boom');
  });

  it('answers no rendered HTML when the instance answers no render, not guessed markup', async () => {
    const body = makeIssueBody();
    delete body.renderedFields;
    const view = await readJiraIssueView({ request: makeRequest({ issueBody: body }), config, ref });
    expect(view.description.html).toBeNull();
    expect(view.comments.map((comment) => comment.html)).toEqual([null, null]);
  });

  it('reports comments truncation when the total holds more than the array', async () => {
    const view = await readJiraIssueView({
      request: makeRequest({ issueBody: makeIssueBody({ commentTotal: 45 }) }),
      config,
      ref,
    });
    expect(view.comments).toHaveLength(2);
    expect(view.truncated.comments).toBe(true);
  });

  it('refuses an avatar URL of another origin instead of proxying a stranger', async () => {
    const body = makeIssueBody();
    body.fields.assignee = person('Alex Coder', 'a.coder');
    body.fields.assignee.avatarUrls = { '48x48': 'https://evil.example.com/secure/useravatar?avatarId=1' };
    const view = await readJiraIssueView({ request: makeRequest({ issueBody: body }), config, ref });
    expect(view.issue.assignee.avatarPath).toBeNull();
  });

  it('classifies a body that answers no recognizable shape as a server error', async () => {
    const request = makeRequest({ issueBody: { wrong: true } });
    await expect(readJiraIssueView({ request, config, ref })).rejects.toMatchObject({ kind: 'server-error' });
  });
});
