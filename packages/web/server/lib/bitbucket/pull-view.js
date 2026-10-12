/**
 * The pull request as the PR viewer reads it: the meta with reviewers and
 * checks, the commits, the files with their locally rebuilt unified diffs,
 * and the comments. Everything comes from GETs to the pull's own resources; the
 * view is assembled here, on the user's machine, and nothing is ever
 * written back to the instance — the request module this reads through has
 * GET as its only verb.
 *
 * Representation decisions, kept honest rather than guessed:
 * - DC answers diffs as JSON with interleaved segments; the unified patch
 *   is rebuilt here because that is the one diff form the app's readers
 *   (the viewer and the chat's context material) both consume. The JSON
 *   never leaves this module.
 * - Comments come from the activities feed, paged; only COMMENTED
 *   activities carry a comment. Replies ride inside the comment.
 * - Checks arrive through the same rollup the chip's summary reads, built
 *   from the same requests.
 */

import { z } from 'zod';

import { BitbucketError } from './client.js';
import { summarizeBuildStatuses } from './pull-summary.js';
import { bitbucketApiPath } from './url.js';

const personBodySchema = z.object({
  displayName: z.string().nullish(),
  name: z.string().nullish(),
  slug: z.string().nullish(),
});

// A pull's author arrives as a participant — a person wrapped in a role —
// while comment authors arrive bare. The reader accepts a bare author too:
// an older DC answering the plain person is read, not rejected.
const authorBodySchema = z.object({
  displayName: z.string().nullish(),
  name: z.string().nullish(),
  slug: z.string().nullish(),
  user: personBodySchema.nullish(),
});

const pathRefSchema = z.object({
  toString: z.string().nullish(),
});

const branchRefSchema = z.object({
  id: z.string().nullish(),
  displayId: z.string().nullish(),
  latestCommit: z.string().nullish(),
});

const commentBodySchema = z.object({
  id: z.number().nullish(),
  text: z.string().nullish(),
  createdDate: z.number().nullish(),
  threadResolved: z.boolean().nullish(),
  severity: z.string().nullish(),
  author: personBodySchema.nullish(),
  anchor: z.object({
    path: z.string().nullish(),
    line: z.number().nullish(),
    lineType: z.string().nullish(),
  }).nullish(),
  comments: z.array(z.lazy(() => commentBodySchema)).nullish(),
});

const pullViewBodySchema = z.object({
  title: z.string().nullish(),
  description: z.string().nullish(),
  state: z.string().nullish(),
  createdDate: z.number().nullish(),
  updatedDate: z.number().nullish(),
  author: authorBodySchema.nullish(),
  reviewers: z.array(z.object({
    approved: z.boolean().nullish(),
    status: z.string().nullish(),
    user: personBodySchema.nullish(),
  })).nullish(),
  fromRef: branchRefSchema.nullish(),
  toRef: branchRefSchema.nullish(),
});

const buildStatusesBodySchema = z.object({
  values: z.array(z.object({
    state: z.string().nullish(),
  })).nullish(),
});

// DC answers the commit list as git commits: the author is the git author
// name (not the account's display name) and the timestamp is seconds.
const commitsPageSchema = z.object({
  isLastPage: z.boolean().nullish(),
  values: z.array(z.object({
    id: z.string(),
    displayId: z.string().nullish(),
    message: z.string().nullish(),
    authorTimestamp: z.number().nullish(),
    author: z.object({
      name: z.string().nullish(),
    }).nullish(),
  })).nullish(),
});

const COMMITS_LIMIT = 25;

const diffBodySchema = z.object({
  truncated: z.boolean().nullish(),
  diffs: z.array(z.object({
    truncated: z.boolean().nullish(),
    source: pathRefSchema.nullish(),
    destination: pathRefSchema.nullish(),
    hunks: z.array(z.object({
      sourceLine: z.number().nullish(),
      sourceSpan: z.number().nullish(),
      destinationLine: z.number().nullish(),
      destinationSpan: z.number().nullish(),
      segments: z.array(z.object({
        type: z.string().nullish(),
        truncated: z.boolean().nullish(),
        lines: z.array(z.object({
          source: z.number().nullish(),
          destination: z.number().nullish(),
          line: z.string().nullish(),
          truncated: z.boolean().nullish(),
        })).nullish(),
      })).nullish(),
    })).nullish(),
  })).nullish(),
});

const activitiesPageSchema = z.object({
  size: z.number().nullish(),
  limit: z.number().nullish(),
  start: z.number().nullish(),
  isLastPage: z.boolean().nullish(),
  values: z.array(z.object({
    id: z.number().nullish(),
    createdDate: z.number().nullish(),
    action: z.string().nullish(),
    comment: commentBodySchema.nullish(),
    commentAnchor: z.object({
      path: z.string().nullish(),
      line: z.number().nullish(),
      lineType: z.string().nullish(),
    }).nullish(),
  })).nullish(),
});

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BitbucketError('server-error', `${what} did not answer the shape the view reads`);
  }
  return parsed.data;
};

/**
 * One pages reader: walks DC's paged activities until the last page or the
 * cap, the same honest-abstention the summary layer uses — the cap is
 * reported, not hidden behind a silent cut.
 */
const readAllActivities = async ({ request, config, ref, maxPages = 3 }) => {
  const activities = [];
  let start = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const body = parseBody(
      activitiesPageSchema,
      await request({ config, path: bitbucketApiPath(ref, '/activities'), search: '?start=' + start + '&limit=100' }),
      'the pull activities',
    );
    const values = body.values ?? [];
    activities.push(...values);
    if (body.isLastPage !== false || values.length === 0) {
      return { activities, truncated: false };
    }
    start += values.length;
  }
  return { activities, truncated: true };
};

/**
 * One file's hunks turned into a unified patch, locally: DC answers hunks
 * with source/destination line ranges and segments of context, added and
 * removed lines — exactly the three things a unified diff needs.
 */
const buildUnifiedPatch = (fileDiff) => {
  const sourcePath = fileDiff.source?.toString ?? null;
  const destinationPath = fileDiff.destination?.toString ?? null;
  const before = sourcePath ?? destinationPath ?? '(unknown)';
  const after = destinationPath ?? sourcePath ?? '(unknown)';
  const lines = [
    `diff --git a/${before} b/${after}`,
    `--- ${sourcePath ? `a/${sourcePath}` : '/dev/null'}`,
    `+++ ${destinationPath ? `b/${destinationPath}` : '/dev/null'}`,
  ];
  for (const hunk of fileDiff.hunks ?? []) {
    lines.push(
      `@@ -${hunk.sourceLine ?? 0},${hunk.sourceSpan ?? 0} +${hunk.destinationLine ?? 0},${hunk.destinationSpan ?? 0} @@`,
    );
    for (const segment of hunk.segments ?? []) {
      const prefix = segment.type === 'ADDED' ? '+' : segment.type === 'REMOVED' ? '-' : ' ';
      for (const item of segment.lines ?? []) {
        lines.push(`${prefix}${item.line ?? ''}`);
      }
    }
  }
  return lines.join('\n');
};

const pullStateOf = (state) => {
  if (state === 'MERGED') return 'merged';
  if (state === 'OPEN') return 'open';
  return 'closed';
};

const personNameOf = (person) => person?.displayName || person?.name || person?.slug || null;

// The slug is the instance's stable handle on a person: the name can be
// retyped, the slug is what the avatar URL is built from.
const personSlugOf = (person) => person?.slug || null;

// A participant's name lives one level in, a bare person's on itself.
const authorNameOf = (author) => (author?.user ? personNameOf(author.user) : personNameOf(author));
const authorSlugOf = (author) => (author?.user ? personSlugOf(author.user) : personSlugOf(author));

/**
 * The comment's place in the diff, in the shape the UI quotes by. An anchor
 * without a path anchors nothing: it reads back as null, and the comment
 * joins the pull-level crowd.
 */
const anchorOf = (anchor) =>
  anchor?.path
    ? { path: anchor.path, line: anchor.line ?? null, lineType: anchor.lineType ?? null }
    : null;

/**
 * The full view of one pull. The meta walks first (the checks need its head
 * commit), then the diff, then the build statuses, then the commits page,
 * then the activities pages. The reader returns the assembled view or throws
 * the client's own error kinds.
 */
export const readPullView = async ({ request, config, ref }) => {
  const pull = parseBody(
    pullViewBodySchema,
    await request({ config, path: bitbucketApiPath(ref) }),
    'the pull request',
  );

  const diffBody = await request({
    config,
    path: bitbucketApiPath(ref, '/diff'),
    search: '?contextLines=3&withComments=false',
  }).then((body) => parseBody(diffBodySchema, body, 'the pull diff'));

  // Build statuses hang off the head commit; they are decoration, not the
  // pull's identity — an instance without the build-status plugin answers
  // 404 and the view still opens: unknown checks, known pull.
  let checks = null;
  const latestCommit = pull.fromRef?.latestCommit ?? null;
  if (latestCommit) {
    try {
      const builds = parseBody(
        buildStatusesBodySchema,
        await request({
          config,
          path: `/rest/build-status/1.0/commits/${encodeURIComponent(latestCommit)}`,
        }),
        'the commit build statuses',
      );
      checks = summarizeBuildStatuses(builds.values);
    } catch (error) {
      if (!(error instanceof BitbucketError) || (error.kind !== 'not-found' && error.kind !== 'server-error')) {
        throw error;
      }
      checks = { state: 'unknown', total: 0 };
    }
  }

  /**
   * The pull's own commits: one paged GET, capped at one page. The first
   * line of the message is the summary the UI lists; the rest of the body
   * stays behind, as it does in DC's own commit list.
   */
  const commitsBody = parseBody(
    commitsPageSchema,
    await request({ config, path: bitbucketApiPath(ref, '/commits'), search: `?start=0&limit=${COMMITS_LIMIT}` }),
    'the pull commits',
  );
  const commits = (commitsBody.values ?? [])
    .map((commit) => ({
      sha: commit.id,
      shortSha: commit.displayId ?? commit.id.slice(0, 12),
      author: commit.author?.name ?? null,
      summary: (commit.message ?? '').split('\n')[0] || null,
      // A commit without a timestamp never happened: absent reads back
      // null, and the UI draws what it has.
      date: commit.authorTimestamp ? commit.authorTimestamp * 1000 : null,
    }));

  const files = (diffBody.diffs ?? []).map((fileDiff) => {
    const sourcePath = fileDiff.source?.toString ?? null;
    const destinationPath = fileDiff.destination?.toString ?? null;
    return {
      path: destinationPath ?? sourcePath ?? '(unknown)',
      changeType: sourcePath && destinationPath ? 'modify' : destinationPath ? 'add' : 'delete',
      truncated: fileDiff.truncated === true,
      diffText: buildUnifiedPatch(fileDiff),
    };
  });

  const { activities, truncated: commentsTruncated } = await readAllActivities({ request, config, ref });
  const comments = activities
    .filter((activity) => activity.action === 'COMMENTED' && activity.comment)
    .map((activity) => ({
      id: activity.comment?.id ?? activity.id ?? 0,
      author: personNameOf(activity.comment?.author),
      authorSlug: personSlugOf(activity.comment?.author),
      text: activity.comment?.text ?? '',
      createdAt: activity.comment?.createdDate ?? activity.createdDate ?? null,
      resolved: activity.comment?.threadResolved === true,
      severity: activity.comment?.severity ?? null,
      // Where the comment hangs: DC anchors review comments to a file and a
      // line of the diff (lineType tells added, context or removed lines);
      // a comment of the overview carries no anchor and belongs to the pull
      // as a whole. The UI groups by this and quotes the anchored hunk.
      anchor: anchorOf(activity.commentAnchor ?? activity.comment?.anchor),
      replies: (activity.comment?.comments ?? []).map((reply) => ({
        author: personNameOf(reply.author),
        authorSlug: personSlugOf(reply.author),
        text: reply.text ?? '',
        createdAt: reply.createdDate ?? null,
      })),
    }))
    .sort((one, two) => (one.createdAt ?? 0) - (two.createdAt ?? 0));

  return {
    pull: {
      number: ref.number,
      url: `${ref.origin}${ref.context}/projects/${ref.project}/repos/${ref.slug}/pull-requests/${ref.number}`,
      title: pull.title ?? `#${ref.number}`,
      description: pull.description ?? '',
      state: pullStateOf(pull.state ?? ''),
      author: authorNameOf(pull.author),
      authorSlug: authorSlugOf(pull.author),
      createdAt: pull.createdDate ?? null,
      updatedAt: pull.updatedDate ?? null,
      fromBranch: pull.fromRef?.displayId ?? null,
      toBranch: pull.toRef?.displayId ?? null,
      reviewers: (pull.reviewers ?? []).map((reviewer) => ({
        name: personNameOf(reviewer.user),
        slug: reviewer.user?.slug ?? null,
        approved: reviewer.status === 'APPROVED' || reviewer.approved === true,
      })),
      checks,
    },
    commits,
    files,
    comments,
    truncated: {
      diff: diffBody.truncated === true || files.some((file) => file.truncated),
      comments: commentsTruncated,
      commits: commitsBody.isLastPage === false || (commitsBody.values ?? []).length > COMMITS_LIMIT,
    },
  };
};
