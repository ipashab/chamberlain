/**
 * The tracker actions' one executor: every `pr.*` action against the
 * bitbucket module, every `issue.*` against the jira module, both through
 * the connections the user configured under Settings → Integrations.
 *
 * Reads reuse the modules' own assemblers (`readPullView`,
 * `readJiraIssueView`) — the agent sees the same view the user's panels
 * do. Writes go through the clients' mutation factories, so a comment or
 * an approval goes out under the configured user's own token and name,
 * never the agent's. The connections are read per call, and a ref of
 * another instance answers wrong-instance, never a request against a
 * machine the user never connected.
 */

import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';
import { parseTrackerRef } from './tools.js';
import { BitbucketError, createBitbucketMutation, createBitbucketRequest } from '../bitbucket/client.js';
import { JiraError, createJiraMutation, createJiraRequest } from '../jira/client.js';
import { readPullView as readPullViewImpl } from '../bitbucket/pull-view.js';
import { readJiraIssueView as readJiraIssueViewImpl } from '../jira/issue-view.js';
import { bitbucketApiPath } from '../bitbucket/url.js';
import { jiraIssueBrowseUrl } from '../jira/url.js';

/**
 * The service's own failure: a message the agent can act on or relay, and
 * a statusCode the agent tool's result reads as `usage` for 4xx and
 * `runtime` beyond — the same contract the team service answers.
 */
class TrackerError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

const COMMENT_MAX_LENGTH = 10_000;

const commentTextSchema = z.string().trim().min(1).max(COMMENT_MAX_LENGTH);

/**
 * The comment the agent posts: one trimmed non-empty text, capped so a
 * runaway generation cannot paste a document into a PR thread.
 */
const parseCommentText = (value) => {
  const parsed = commentTextSchema.safeParse(value);
  if (!parsed.success) {
    return {
      error: new TrackerError(
        `text must be a comment of 1 to ${COMMENT_MAX_LENGTH} characters`,
        400,
      ),
    };
  }
  return { text: parsed.data };
};

/**
 * The transition list Jira answers, kept to the fields an agent needs to
 * choose: id, exact name, and the state it moves to.
 */
const transitionsBodySchema = z.object({
  transitions: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      to: z.looseObject({ name: z.string().optional() }).optional(),
    }),
  ),
});

/**
 * The instance Jira DC calls go against: the configured connection for a
 * bare key or a same-instance URL, an explicit wrong-instance answer for
 * anything else — the same line the jira routes hold.
 */
const jiraTarget = async (configStore, ref) => {
  const state = await configStore.read();
  const instance = state?.instance;
  if (!instance?.origin || !instance?.token) {
    throw new TrackerError('No Jira connection is configured. The user can add one under Settings → Integrations.', 409);
  }
  if (ref.origin !== null && (ref.origin !== instance.origin || ref.context !== '')) {
    throw new TrackerError('The issue belongs to another Jira instance: the ref names a different deployment.', 409);
  }
  return { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl };
};

/**
 * The instance Bitbucket DC calls go against. The connection is always an
 * instance root, so a ref carrying a context path is a pull of another
 * deployment behind the same host — the same line the bitbucket routes
 * hold.
 */
const bitbucketTarget = async (configStore, ref) => {
  const state = await configStore.read();
  const instance = state?.instance;
  if (!instance?.origin || !instance?.token) {
    throw new TrackerError('No Bitbucket connection is configured. The user can add one under Settings → Integrations.', 409);
  }
  if (ref.origin !== instance.origin || ref.context !== '') {
    throw new TrackerError('The pull request belongs to another Bitbucket instance: the ref names a different deployment.', 409);
  }
  return { origin: instance.origin, token: instance.token, verifySsl: instance.verifySsl };
};

/**
 * A client's own error, worded for one of the agent's readers: the 4xx
 * kinds the agent can relay as they are, the transport kinds as runtime
 * trouble. Everything else rethrows untouched.
 */
const mapClientFailure = (error, ClientError) => {
  if (!(error instanceof ClientError)) throw error;
  const byKind = {
    unconfigured: [409],
    unauthorized: [401],
    'not-found': [404],
    invalid: [400],
    conflict: [409],
    unreachable: [502],
    'server-error': [502],
  };
  const [statusCode] = byKind[error.kind] ?? [500];
  return new TrackerError(error.message, statusCode);
};

/**
 * One transition resolved against the issue's live list: by exact id, then
 * by exact name case-insensitively — a name is what the agent has, an id
 * is what Jira wants. A miss names the transitions that exist.
 */
const resolveTransition = (transitions, wanted, issueKey) => {
  const byId = transitions.find((entry) => entry.id === wanted);
  if (byId) return byId;
  const byName = transitions.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return byName;
  const listed = transitions
    .map((entry) => `${entry.name} (${entry.id})`)
    .join(', ');
  throw new TrackerError(
    `No transition '${wanted}' is available for ${issueKey}. Available: ${listed}.`,
    400,
  );
};

const readTransitions = async ({ request, config, key }) => {
  const parsed = transitionsBodySchema.safeParse(await request({
    config,
    path: `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
  }));
  if (!parsed.success) {
    throw new TrackerError('Jira answered with a transition list the service cannot read.', 502);
  }
  return parsed.data.transitions.map((entry) => ({
    id: entry.id,
    name: entry.name,
    to: entry.to?.name ?? null,
  }));
};

/**
 * The service factory. The view assemblers are the owning modules' own and
 * ride as injectable defaults so the service's tests pin dispatch, not the
 * assemblers' parsing (which their own suites hold).
 */
export const createTrackerService = ({
  bitbucketConfigStore,
  jiraConfigStore,
  createBitbucketRead = createBitbucketRequest,
  createBitbucketWrite = createBitbucketMutation,
  createJiraRead = createJiraRequest,
  createJiraWrite = createJiraMutation,
  readPullView = readPullViewImpl,
  readJiraIssueView = readJiraIssueViewImpl,
} = {}) => {
  if (!bitbucketConfigStore || !jiraConfigStore) {
    throw new Error('tracker service needs a bitbucket and a jira config store');
  }
  return {
    executeAction: async (action, input = {}) => {
      const isPullAction = action === 'pr.view' || action === 'pr.comment' || action === 'pr.approve';
      const isIssueAction = action === 'issue.view' || action === 'issue.comment'
        || action === 'issue.transitions' || action === 'issue.transition';
      if (!isPullAction && !isIssueAction) {
        throw new TrackerError(`Unsupported tracker action: ${action || 'missing'}`, 400);
      }

      const kind = isPullAction ? 'pr' : 'issue';
      const ref = parseTrackerRef(kind, input.ref);
      if (!ref) {
        throw new TrackerError(
          isPullAction
            ? 'ref must name a Bitbucket pull request: pr://<full pull-request URL> or the URL alone.'
            : 'ref must name a Jira issue: issue://<browse URL or issue key>, or the URL or key alone.',
          400,
        );
      }

      try {
        if (isPullAction) {
          const config = await bitbucketTarget(bitbucketConfigStore, ref);
          if (action === 'pr.view') {
            return readPullView({
              request: createBitbucketRead(),
              config,
              ref,
            });
          }
          const mutation = createBitbucketWrite();
          if (action === 'pr.approve') {
            await mutation({ config, path: bitbucketApiPath(ref, '/approve'), json: null });
            return { approved: true, url: ref.canonicalUrl };
          }
          const { text, error: textError } = parseCommentText(input.text);
          if (textError) throw textError;
          const comment = await mutation({
            config,
            path: bitbucketApiPath(ref, '/comments'),
            json: { text },
          });
          return { commented: true, url: ref.canonicalUrl, commentId: comment?.id ?? null };
        }

        const config = await jiraTarget(jiraConfigStore, ref);
        // Голый key не знает своего инстанса — ответ строит URL от
        // настроенного соединения, той же функцией, что и вьюер.
        const issueUrl = ref.canonicalUrl ?? jiraIssueBrowseUrl(config.origin, ref.key);
        if (action === 'issue.view') {
          return readJiraIssueView({
            request: createJiraRead(),
            config,
            ref,
          });
        }
        if (action === 'issue.transitions') {
          const transitions = await readTransitions({ request: createJiraRead(), config, key: ref.key });
          return { issue: ref.key, url: issueUrl, transitions };
        }
        if (action === 'issue.transition') {
          const wanted = asNonEmptyString(input.transition);
          if (!wanted) {
            throw new TrackerError('transition must name the transition: its id or exact name from issue.transitions.', 400);
          }
          const transitions = await readTransitions({ request: createJiraRead(), config, key: ref.key });
          const target = resolveTransition(transitions, wanted, ref.key);
          await createJiraWrite()({
            config,
            path: `/rest/api/2/issue/${encodeURIComponent(ref.key)}/transitions`,
            json: { transition: { id: target.id } },
          });
          return { transitioned: true, issue: ref.key, url: issueUrl, to: target.name };
        }
        const { text, error: textError } = parseCommentText(input.text);
        if (textError) throw textError;
        const comment = await createJiraWrite()({
          config,
          path: `/rest/api/2/issue/${encodeURIComponent(ref.key)}/comment`,
          json: { body: text },
        });
        return { commented: true, issue: ref.key, url: issueUrl, commentId: comment?.id ?? null };
      } catch (error) {
        throw mapClientFailure(error, isPullAction ? BitbucketError : JiraError);
      }
    },
  };
};
