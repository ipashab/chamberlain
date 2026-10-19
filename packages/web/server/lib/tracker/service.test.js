import { describe, expect, it, vi } from 'vitest';

import { createTrackerService } from './service.js';
import { BitbucketError } from '../bitbucket/client.js';
import { JiraError } from '../jira/client.js';

const PR_URL = 'https://bitbucket.example.com/projects/OC/repos/core/pull-requests/42';
const PR_REF_FORM = `pr://${PR_URL}`;

const configured = (origin, token = 'TOKEN') => ({
  read: vi.fn(async () => ({ instance: { origin, token, verifySsl: true } })),
});

const empty = { read: vi.fn(async () => ({ instance: null })) };

const service = ({
  bitbucketConfigStore = configured('https://bitbucket.example.com'),
  jiraConfigStore = configured('https://jira.example.com'),
  pullMutation = vi.fn(async () => ({ id: 101 })),
  jiraMutation = vi.fn(async () => null),
  jiraRead = vi.fn(async () => ({
    transitions: [
      { id: '31', name: 'Start Progress', to: { name: 'In Progress' } },
      { id: '41', name: 'Done', to: { name: 'Closed' } },
    ],
  })),
  readPullView = vi.fn(async () => ({ view: 'pull' })),
  readJiraIssueView = vi.fn(async () => ({ view: 'issue' })),
} = {}) => createTrackerService({
  bitbucketConfigStore,
  jiraConfigStore,
  createBitbucketRead: () => vi.fn(async () => ({})),
  createBitbucketWrite: () => pullMutation,
  createJiraRead: () => jiraRead,
  createJiraWrite: () => jiraMutation,
  readPullView,
  readJiraIssueView,
});

describe('createTrackerService', () => {
  it('refuses to run without both config stores', () => {
    expect(() => createTrackerService({ bitbucketConfigStore: configured('https://x') }))
      .toThrow('tracker service needs a bitbucket and a jira config store');
  });

  it('answers every unknown action as a usage error', async () => {
    const tracker = service();
    await expect(tracker.executeAction('pr.merge', {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(tracker.executeAction('nope', {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers a ref no parser accepts as a usage error', async () => {
    const tracker = service();
    await expect(tracker.executeAction('pr.comment', { ref: 'https://example.com/x', text: 'hi' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(tracker.executeAction('issue.comment', { ref: '', text: 'hi' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('pr actions', () => {
  it('pr.view reads the ref and hands the configured connection to the view assembler', async () => {
    const readPullView = vi.fn(async () => ({ view: 'pull' }));
    const tracker = service({ readPullView });
    const view = await tracker.executeAction('pr.view', { ref: PR_REF_FORM });
    expect(view).toEqual({ view: 'pull' });
    expect(readPullView).toHaveBeenCalledTimes(1);
    const { config, ref } = readPullView.mock.calls[0][0];
    expect(config).toMatchObject({ origin: 'https://bitbucket.example.com', token: 'TOKEN' });
    expect(ref.canonicalUrl).toBe(PR_URL);
  });

  it('pr.comment posts the text under the pull and answers the new comment id', async () => {
    const pullMutation = vi.fn(async () => ({ id: 101, text: 'Ship it' }));
    const tracker = service({ pullMutation });
    const result = await tracker.executeAction('pr.comment', { ref: PR_REF_FORM, text: '  Ship it  ' });
    expect(result).toEqual({ commented: true, url: PR_URL, commentId: 101 });
    expect(pullMutation).toHaveBeenCalledWith(expect.objectContaining({
      path: '/rest/api/1.0/projects/OC/repos/core/pull-requests/42/comments',
      json: { text: 'Ship it' },
    }));
  });

  it('pr.approve posts one approval without a body', async () => {
    const pullMutation = vi.fn(async () => null);
    const tracker = service({ pullMutation });
    const result = await tracker.executeAction('pr.approve', { ref: PR_REF_FORM });
    expect(result).toEqual({ approved: true, url: PR_URL });
    expect(pullMutation).toHaveBeenCalledWith(expect.objectContaining({
      path: '/rest/api/1.0/projects/OC/repos/core/pull-requests/42/approve',
      json: null,
    }));
  });

  it('pr.comment rejects empty and runaway text without posting', async () => {
    const pullMutation = vi.fn();
    const tracker = service({ pullMutation });
    await expect(tracker.executeAction('pr.comment', { ref: PR_REF_FORM, text: '   ' }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(tracker.executeAction('pr.comment', { ref: PR_REF_FORM, text: 'x'.repeat(10_001) }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(pullMutation).not.toHaveBeenCalled();
  });

  it('answers unconfigured as a usage-grade error naming the settings card', async () => {
    const tracker = service({ bitbucketConfigStore: empty });
    const failure = tracker.executeAction('pr.comment', { ref: PR_REF_FORM, text: 'Ship it' });
    await expect(failure).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('No Bitbucket connection') });
  });

  it('answers a ref of another instance, never a request against it', async () => {
    const pullMutation = vi.fn();
    const tracker = service({ pullMutation });
    await expect(tracker.executeAction('pr.approve', { ref: 'https://elsewhere.example.com/projects/OC/repos/core/pull-requests/1' }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(tracker.executeAction('pr.approve', { ref: 'https://bitbucket.example.com/bitbucket/projects/OC/repos/core/pull-requests/1' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('another Bitbucket instance') });
    expect(pullMutation).not.toHaveBeenCalled();
  });

  it('carries the client failures through with usage/runtime grades', async () => {
    const conflict = vi.fn(async () => { throw new BitbucketError('conflict', 'You cannot approve your own pull request', 409); });
    const down = vi.fn(async () => { throw new BitbucketError('unreachable', 'Bitbucket request failed', null); });
    await expect(service({ pullMutation: conflict }).executeAction('pr.approve', { ref: PR_REF_FORM }))
      .rejects.toMatchObject({ statusCode: 409, message: 'You cannot approve your own pull request' });
    await expect(service({ pullMutation: down }).executeAction('pr.approve', { ref: PR_REF_FORM }))
      .rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('issue actions', () => {
  it('issue.view hands the configured connection to the issue assembler', async () => {
    const readJiraIssueView = vi.fn(async () => ({ view: 'issue' }));
    const tracker = service({ readJiraIssueView });
    const view = await tracker.executeAction('issue.view', { ref: 'issue://OC-42' });
    expect(view).toEqual({ view: 'issue' });
    const { config, ref } = readJiraIssueView.mock.calls[0][0];
    expect(config).toMatchObject({ origin: 'https://jira.example.com', token: 'TOKEN' });
    expect(ref.key).toBe('OC-42');
  });

  it('issue.comment posts the body on the issue and answers the new comment id', async () => {
    const jiraMutation = vi.fn(async () => ({ id: '10' }));
    const tracker = service({ jiraMutation });
    const result = await tracker.executeAction('issue.comment', { ref: 'issue://OC-42', text: 'Agent note' });
    expect(result).toEqual({ commented: true, issue: 'OC-42', url: 'https://jira.example.com/browse/OC-42', commentId: '10' });
    expect(jiraMutation).toHaveBeenCalledWith(expect.objectContaining({
      path: '/rest/api/2/issue/OC-42/comment',
      json: { body: 'Agent note' },
    }));
  });

  it('issue.transitions lists what Jira allows the issue now', async () => {
    const jiraRead = vi.fn(async () => ({
      transitions: [
        { id: '31', name: 'Start Progress', to: { name: 'In Progress' } },
        { id: '41', name: 'Done', extra: true },
      ],
    }));
    const tracker = service({ jiraRead });
    const result = await tracker.executeAction('issue.transitions', { ref: 'issue://OC-42' });
    expect(result).toEqual({
      issue: 'OC-42',
      url: 'https://jira.example.com/browse/OC-42',
      transitions: [
        { id: '31', name: 'Start Progress', to: 'In Progress' },
        { id: '41', name: 'Done', to: null },
      ],
    });
    expect(jiraRead).toHaveBeenCalledWith(expect.objectContaining({
      path: '/rest/api/2/issue/OC-42/transitions',
    }));
  });

  it('issue.transition moves the issue by id or by name, case-insensitively', async () => {
    const jiraMutation = vi.fn(async () => null);
    const tracker = service({ jiraMutation });
    await expect(tracker.executeAction('issue.transition', { ref: 'issue://OC-42', transition: '31' }))
      .resolves.toMatchObject({ transitioned: true, issue: 'OC-42', to: 'Start Progress' });
    await expect(tracker.executeAction('issue.transition', { ref: 'issue://OC-42', transition: 'done' }))
      .resolves.toMatchObject({ transitioned: true, issue: 'OC-42', to: 'Done' });
    expect(jiraMutation).toHaveBeenCalledTimes(2);
    expect(jiraMutation.mock.calls[0][0]).toMatchObject({
      path: '/rest/api/2/issue/OC-42/transitions',
      json: { transition: { id: '31' } },
    });
  });

  it('issue.transition names the transitions that exist on a miss, and posts nothing', async () => {
    const jiraMutation = vi.fn();
    const tracker = service({ jiraMutation });
    await expect(tracker.executeAction('issue.transition', { ref: 'issue://OC-42', transition: 'Reopen' }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Start Progress (31)') });
    await expect(tracker.executeAction('issue.transition', { ref: 'issue://OC-42', transition: '  ' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(jiraMutation).not.toHaveBeenCalled();
  });

  it('answers an unreadable transition list as runtime trouble', async () => {
    const tracker = service({ jiraRead: vi.fn(async () => ({ nope: true })) });
    await expect(tracker.executeAction('issue.transitions', { ref: 'issue://OC-42' }))
      .rejects.toMatchObject({ statusCode: 502 });
  });

  it('answers unconfigured and wrong-instance the way the viewer routes do', async () => {
    const tracker = service({ jiraConfigStore: empty });
    await expect(tracker.executeAction('issue.comment', { ref: 'issue://OC-42', text: 'note' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('No Jira connection') });
    const elsewhere = service();
    await expect(elsewhere.executeAction('issue.comment', { ref: 'issue://https://elsewhere.example.com/browse/OC-42', text: 'note' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('another Jira instance') });
  });

  it('carries a jira client failure through with its grade', async () => {
    const rejecting = vi.fn(async () => { throw new JiraError('invalid', 'The transition is not valid for this issue.', 400); });
    const tracker = service({ jiraMutation: rejecting });
    await expect(tracker.executeAction('issue.comment', { ref: 'issue://OC-42', text: 'note' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'The transition is not valid for this issue.' });
  });
});
