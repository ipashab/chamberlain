// The pull request as text, for the "ask about this pull request" flow.
//
// The viewer already renders the view from the server's one read; this
// module turns the same view into the material the chat carries: the
// pinned context quote behind the composer chip. Everything is assembled
// locally from what was read — the instance never hears about it.
//
// The cap keeps one pull from crowding the message: the material ends with
// an explicit truncation note, so the reader knows the cut happened and
// can ask for the rest by opening the view again.

import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';

const MATERIAL_CAP = 48_000;

const stampOf = (ms: number | null | undefined): string => {
  const value = ms ?? null;
  return value === null ? 'unknown time' : new Date(value).toISOString();
};

const stateWord = (state: 'open' | 'merged' | 'closed'): string => {
  if (state === 'open') return 'open';
  if (state === 'merged') return 'merged';
  return 'closed';
};

const changeWord = (changeType: 'add' | 'delete' | 'modify'): string => {
  if (changeType === 'add') return 'added';
  if (changeType === 'delete') return 'deleted';
  return 'modified';
};

const checksWord = (view: BitbucketPullView): string => {
  const checks = view.pull.checks;
  if (!checks) return 'no build statuses';
  if (checks.total === 0) return 'no build statuses';
  return `build statuses: ${checks.state} (${checks.total})`;
};

const reviewLines = (view: BitbucketPullView): string[] => {
  if (view.pull.reviewers.length === 0) return [];
  return [
    '## Reviewers',
    ...view.pull.reviewers.map((reviewer) =>
      `- ${reviewer.name ?? reviewer.slug ?? 'unknown'}${reviewer.approved ? ' — approved' : ''}`,
    ),
  ];
};

const fileLines = (view: BitbucketPullView): string[] => {
  if (view.files.length === 0) return [];
  return [
    `## Changed files (${view.files.length})`,
    ...view.files.map((file) => `- ${file.path} — ${changeWord(file.changeType)}`),
  ];
};

const commentLines = (view: BitbucketPullView): string[] => {
  if (view.comments.length === 0) return [];
  const lines = [`## Comments (${view.comments.length})`];
  for (const comment of view.comments) {
    const who = comment.author ?? 'unknown';
    lines.push(`### ${who} — ${stampOf(comment.createdAt)}${comment.resolved ? ' (resolved)' : ''}`);
    lines.push(comment.text);
    for (const reply of comment.replies) {
      lines.push(`> ${reply.author ?? 'unknown'} (${stampOf(reply.createdAt)}): ${reply.text}`);
    }
    lines.push('');
  }
  return lines;
};

/**
 * The whole pull as markdown. The meta leads — the reader knows what it is
 * before the bulk — then the description, the reviewers, the file list, the
 * comments and the diff.
 */
export const buildPullViewMaterial = (view: BitbucketPullView): string => {
  const pull = view.pull;
  const head = [
    `Bitbucket pull request #${pull.number}: ${pull.title}`,
    `URL: ${pull.url}`,
    [
      `State: ${stateWord(pull.state)}`,
      pull.author ? `Author: ${pull.author}` : null,
      pull.fromBranch && pull.toBranch ? `${pull.fromBranch} → ${pull.toBranch}` : null,
      checksWord(view),
    ].filter((part) => part !== null).join(' · '),
    '',
  ];

  const description = pull.description
    ? ['## Description', pull.description, '']
    : [];

  const diff = view.files.length > 0
    ? ['## Diff', ...view.files.map((file) => file.diffText)]
    : [];

  const body = [
    ...head,
    ...description,
    ...reviewLines(view),
    ...fileLines(view),
    ...commentLines(view),
    ...diff,
  ];

  const text = body.join('\n');
  if (text.length <= MATERIAL_CAP) {
    return view.truncated.diff || view.truncated.comments
      ? `${text}\n\n(Something was truncated: ${[
        view.truncated.diff ? 'the diff' : null,
        view.truncated.comments ? 'the comments' : null,
      ].filter(Boolean).join(' and ')} on the Bitbucket side.)`
      : text;
  }
  return `${text.slice(0, MATERIAL_CAP)}\n\n(The material was cut to fit the message; open the pull view again for the rest.)`;
};
