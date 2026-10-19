/**
 * The `openchamber_tracker` managed tool's static surface: the action
 * grammar, the parameter schema, and the one parse that turns an agent's
 * `pr://` / `issue://` reference into the owning module's own parsed ref.
 *
 * The actions are named by entity, not by surface — `pr.comment` and
 * `issue.comment` read like the tracker operations they are, and the tool
 * dispatch (team-style, never the control allowlist) routes each to the
 * bitbucket or jira module that owns the instance.
 */

import { asNonEmptyString, isString } from '../shared/guards.js';
import { parseBitbucketPullUrl } from '../bitbucket/url.js';
import { parseJiraIssueRef } from '../jira/url.js';

const PR_SCHEME = 'pr://';
const ISSUE_SCHEME = 'issue://';

export const TRACKER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'pr.view', title: 'Read a Bitbucket pull request', description: 'The PR viewer\'s whole view: meta, reviewers, commits, files, comments. Ref: pr://<full pull URL> or the URL alone' },
  { action: 'pr.comment', title: 'Post a comment on a Bitbucket pull request', description: 'One comment under the pull, the user\'s name on it. Parameters: ref, text' },
  { action: 'pr.approve', title: 'Approve a Bitbucket pull request', description: 'One approval under the pull. Parameter: ref' },
  { action: 'issue.view', title: 'Read a Jira issue', description: 'The issue viewer\'s whole view. Ref: issue://<browse URL or bare key>-style reference, or the URL/key alone' },
  { action: 'issue.comment', title: 'Post a comment on a Jira issue', description: 'One comment on the issue, the user\'s name on it. Parameters: ref, text' },
  { action: 'issue.transitions', title: 'List the workflow transitions of a Jira issue', description: 'The transitions the issue\'s current state allows, with ids and names. Parameter: ref' },
  { action: 'issue.transition', title: `Move a Jira issue through a transition`, description: 'One transition by id or exact name from issue.transitions. Parameters: ref, transition' },
]);

export const TRACKER_ACTIONS = Object.freeze(TRACKER_ACTION_DEFINITIONS.map(({ action }) => action));

const TRACKER_ACTION_NAMES = new Set(TRACKER_ACTIONS);

const PR_REF_FORM = 'pr://<full Bitbucket pull-request URL> (or the URL alone)';
const ISSUE_REF_FORM = 'issue://<Jira browse URL or issue key> (or the URL/key alone)';

/**
 * One entity reference, total for every caller input: a missing, empty or
 * non-string value reads back null, not a throw. The schemes are the
 * agent-facing forms; a bare URL or issue key parses the same way, and the
 * owning module's parser keeps the honesty about what it accepts.
 */
export const parseTrackerRef = (kind, value) => {
  const schemes = kind === 'issue' ? ISSUE_SCHEME : PR_SCHEME;
  const rest = isString(value) && value.trim().toLowerCase().startsWith(schemes)
    ? value.trim().slice(schemes.length)
    : value;
  const trimmed = asNonEmptyString(rest);
  if (!trimmed) return null;
  return kind === 'issue' ? parseJiraIssueRef(trimmed) : parseBitbucketPullUrl(trimmed);
};

/**
 * The dispatch-side counterpart of the grammar: a bare action name (the
 * models drop the namespace the tool's own name already implies) resolves
 * inside the set, anything else answers an error naming the actions.
 */
export const resolveTrackerAction = (value) => {
  if (isString(value) && TRACKER_ACTION_NAMES.has(value)) return { action: value };
  return {
    error: isString(value) && value.trim().startsWith('pr.')
      ? `Unsupported pull request action: ${value}. Use one of: ${TRACKER_ACTIONS.filter((a) => a.startsWith('pr.')).join(', ')}. Targets read as ${PR_REF_FORM}.`
      : isString(value) && value.trim().startsWith('issue.')
        ? `Unsupported issue action: ${value}. Use one of: ${TRACKER_ACTIONS.filter((a) => a.startsWith('issue.')).join(', ')}. Targets read as ${ISSUE_REF_FORM}.`
        : `Unsupported tracker action: ${value || 'missing'}. Use one of: ${TRACKER_ACTIONS.join(', ')}. Pull requests read as ${PR_REF_FORM}; issues as ${ISSUE_REF_FORM}.`,
  };
};

export const TRACKER_PARAMETER_PROPERTIES = Object.freeze({
  ref: { type: 'string', description: `The entity to act on. Pull requests: ${PR_REF_FORM}. Issues: ${ISSUE_REF_FORM}` },
  text: { type: 'string', description: 'pr.comment and issue.comment: the comment body, plain text, 1 to 10000 characters' },
  transition: { type: 'string', description: 'issue.transition: the transition id or its exact name from issue.transitions' },
});
