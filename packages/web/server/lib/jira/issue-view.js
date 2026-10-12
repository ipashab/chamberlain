/**
 * The Jira issue as the issue viewer reads it: the detail fields, the
 * rendered description, the comments, the issue links, the subtasks, the
 * attachments and the watchers. Everything comes from GETs to the issue's
 * own resources; the view is assembled here, on the user's machine, and
 * nothing is ever written back to the instance — the request module this
 * reads through has GET as its only verb.
 *
 * Representation decisions, kept honest rather than guessed:
 * - The description and comment bodies arrive twice from the instance:
 *   the wiki markup in `fields` and the rendered HTML in `renderedFields`
 *   (asked for by the same GET's `expand`). The view carries both — the
 *   HTML for display, the markup for quoting — and reports the HTML null
 *   when the instance answers no render, so the UI falls back to text
 *   instead of guessing markup it cannot render.
 * - Custom fields are read through the `names` map of the same GET: the
 *   field an instance calls "Epic Link" is a key string here — Jira's own
 *   contract — and the epic's summary is one extra GET, degradation
 *   honest (a key with no name) when it fails. Fields whose value does
 *   not parse as a display shape (a user pick, a text, a number, an
 *   option, a list of those) are not guessed into prose: they answer no
 *   text and the UI skips them.
 * - The issue GET answers the comments of the issue's whole history in
 *   one array with a `total`; `truncated.comments` reports a total larger
 *   than the array rather than silently cutting.
 * - Watchers are decoration the default view must survive without: the
 *   watchers page can be permission-walled, and a viewer without it
 *   still opens — names null, the count from the issue's own field.
 */

import { z } from 'zod';

import { JiraError } from './client.js';
import { JIRA_ISSUE_KEY_PATTERN, jiraIssueBrowseUrl } from './url.js';

const userBodySchema = z.object({
  displayName: z.string().nullish(),
  key: z.string().nullish(),
  name: z.string().nullish(),
  avatarUrls: z.record(z.string(), z.string()).nullish(),
});

const iconedNameBodySchema = z.object({
  name: z.string().nullish(),
  iconUrl: z.string().nullish(),
});

const statusBodySchema = z.object({
  name: z.string().nullish(),
  statusCategory: z.object({
    key: z.string().nullish(),
    name: z.string().nullish(),
  }).nullish(),
});

const versionBodySchema = z.object({
  name: z.string().nullish(),
});

const linkIssueBodySchema = z.object({
  key: z.string().nullish(),
  fields: z.object({
    summary: z.string().nullish(),
    status: statusBodySchema.nullish(),
    issuetype: iconedNameBodySchema.nullish(),
  }).nullish(),
});

const linkBodySchema = z.object({
  type: z.object({
    name: z.string().nullish(),
    inward: z.string().nullish(),
    outward: z.string().nullish(),
  }).nullish(),
  inwardIssue: linkIssueBodySchema.nullish(),
  outwardIssue: linkIssueBodySchema.nullish(),
});

const commentBodySchema = z.object({
  id: z.string().nullish(),
  body: z.string().nullish(),
  created: z.string().nullish(),
  updated: z.string().nullish(),
  author: userBodySchema.nullish(),
  updateAuthor: userBodySchema.nullish(),
});

const attachmentBodySchema = z.object({
  id: z.string().nullish(),
  filename: z.string().nullish(),
  size: z.number().nullish(),
  created: z.string().nullish(),
  author: userBodySchema.nullish(),
});

// The fields object keeps its unknown keys: the custom fields of one
// instance are another's nothing, and the reader picks them out by the
// `names` map rather than by a schema this module cannot know.
const issueFieldsBodySchema = z.object({
  summary: z.string().nullish(),
  description: z.string().nullish(),
  created: z.string().nullish(),
  updated: z.string().nullish(),
  issuetype: iconedNameBodySchema.nullish(),
  status: statusBodySchema.nullish(),
  priority: iconedNameBodySchema.nullish(),
  resolution: z.object({ name: z.string().nullish() }).nullish(),
  assignee: userBodySchema.nullish(),
  reporter: userBodySchema.nullish(),
  creator: userBodySchema.nullish(),
  labels: z.array(z.string()).nullish(),
  components: z.array(versionBodySchema).nullish(),
  fixVersions: z.array(versionBodySchema).nullish(),
  versions: z.array(versionBodySchema).nullish(),
  comment: z.object({
    comments: z.array(commentBodySchema).nullish(),
    total: z.number().nullish(),
  }).nullish(),
  issuelinks: z.array(linkBodySchema).nullish(),
  subtasks: z.array(linkIssueBodySchema).nullish(),
  attachment: z.array(attachmentBodySchema).nullish(),
  watches: z.object({ watchCount: z.number().nullish() }).nullish(),
}).passthrough();

const issueBodySchema = z.object({
  key: z.string().nullish(),
  names: z.record(z.string(), z.string()).nullish(),
  fields: issueFieldsBodySchema,
  renderedFields: z.object({
    description: z.string().nullish(),
    comment: z.object({
      comments: z.array(z.object({
        id: z.string().nullish(),
        body: z.string().nullish(),
      })).nullish(),
    }).nullish(),
  }).nullish(),
});

const epicSummaryBodySchema = z.object({
  fields: z.object({
    summary: z.string().nullish(),
    status: statusBodySchema.nullish(),
  }).nullish(),
});

const watchersBodySchema = z.object({
  watchCount: z.number().nullish(),
  watchers: z.array(userBodySchema).nullish(),
});

/**
 * The display shapes a custom field can carry and nothing else: text,
 * number, one option, or a list of those. Anything richer answers no
 * text — the UI skips the field instead of guessing prose. Each branch
 * of the parse answers the same list of nullable texts, so the join is
 * one transform, not a runtime type walk.
 */
const optionTextSchema = z.object({ value: z.string().nullish(), name: z.string().nullish() })
  .transform((option) => option.value ?? option.name ?? null);

const displayTextItemSchema = z.union([
  z.string().transform((text) => [text]),
  z.number().transform((value) => [String(value)]),
  optionTextSchema.transform((text) => [text]),
  z.lazy(() => z.array(displayTextItemSchema).transform((items) => items.flat())),
]);

const displayValueTextSchema = displayTextItemSchema.transform((texts) => {
  const visible = texts.filter((text) => text !== null && text !== '');
  return visible.length > 0 ? visible.join(', ') : null;
});

const displayTextOf = (rawValue) => {
  const parsed = displayValueTextSchema.safeParse(rawValue);
  return parsed.success ? parsed.data : null;
};

const epicKeySchema = z.string().trim().regex(JIRA_ISSUE_KEY_PATTERN);

const sprintBodySchema = z.array(z.object({ name: z.string().nullish() }));

// GreenHopper serializes sprints as their raw `toString()` — one long
// `com.atlassian.greenhopper.service.sprint.Sprint@hash[key=value,...]`
// line per sprint. The only value a person reads out of it is the name,
// so that is the only value the parse keeps: `name=` up to the next
// top-level `key=` boundary or the closing bracket.
const SPRINT_TO_STRING_NAME = /(?:^|,\s*)name=((?:[^,=[\]]|\[[^[\]]*\])*)/g;

const sprintNameOfToString = (raw) => {
  const names = [];
  for (const match of raw.matchAll(SPRINT_TO_STRING_NAME)) {
    const name = (match[1] ?? '').trim();
    if (name) names.push(name);
  }
  return names.length > 0 ? names : null;
};

// The sprint names a person reads, the dev counts a person reads, and a
// quarantine for everything the instance spells as its own machinery:
// a custom field exists for the panel's reader, not for Jira's internals.
const RANK_FIELD_NAME = /(^|\s)rank(\s*\(obsolete\))?$/i;

// Java's default `toString()` — `com.example.Bean@1a2b3c[key=value,...]` —
// anywhere in a row's text means the rest is machinery too.
const MACHINE_SERIALIZED = /@[0-9a-f]{6,}\[/;

/**
 * The Development field a Data Center instance carries is the dev-status
 * plugin's whole summary bean, spelled twice — once as Java `toString()`,
 * once as real JSON after `devSummaryJson=`. The JSON half is the one
 * worth reading: a small per-category count line. Anything that does not
 * yield that line answers null, and the row drops.
 */
const devSummaryLineOf = (rawValue) => {
  const rawString = z.string().safeParse(rawValue);
  if (!rawString.success) return null;
  const marker = 'devSummaryJson=';
  const markerAt = rawString.data.indexOf(marker);
  if (markerAt < 0) return null;
  let candidate = rawString.data.slice(markerAt + marker.length);
  // The bean's own closing braces trail the JSON; trim until it parses.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const devSummarySchema = z.object({
        cachedValue: z.object({
          summary: z
            .object({
              pullrequest: z.object({ overall: z.object({ details: z.object({ openCount: z.number().nullish() }).nullish(), state: z.string().nullish(), count: z.number().nullish() }).nullish() }).nullish(),
              branch: z.object({ overall: z.object({ count: z.number().nullish() }).nullish() }).nullish(),
              build: z.object({ overall: z.object({ count: z.number().nullish() }).nullish() }).nullish(),
              repository: z.object({ overall: z.object({ count: z.number().nullish() }).nullish() }).nullish(),
            })
            .nullish(),
        }),
      });
      const parsedDev = devSummarySchema.parse(JSON.parse(candidate));
      const summary = parsedDev.cachedValue.summary ?? {};
      const parts = [];
      const pull = summary.pullrequest?.overall;
      if (pull && (pull.count ?? 0) > 0) {
        const open = pull.details?.openCount ?? pull.count ?? 0;
        parts.push(`pull requests: ${pull.count}${open > 0 ? ` (${open} open)` : ''}`);
      }
      const branches = summary.branch?.overall?.count ?? 0;
      if (branches > 0) parts.push(`branches: ${branches}`);
      const builds = summary.build?.overall?.count ?? 0;
      if (builds > 0) parts.push(`builds: ${builds}`);
      const commits = summary.repository?.overall?.count ?? 0;
      if (commits > 0) parts.push(`commits: ${commits}`);
      return parts.length > 0 ? parts.join(' · ') : null;
    } catch {
      candidate = candidate.replace(/\}\s*$/, '');
    }
  }
  return null;
};

// GreenHopper's `toString()` may arrive bare or as a list of lines; both
// spell every sprint the same serialized way.
const sprintStringsSchema = z.union([z.string(), z.array(z.string())]);

const sprintNamesOf = (rawValue) => {
  const parsedSprints = sprintBodySchema.safeParse(rawValue);
  if (parsedSprints.success) {
    const sprintNames = parsedSprints.data
      .map((sprint) => sprint.name)
      .filter((sprintName) => sprintName !== null && sprintName !== '');
    if (sprintNames.length > 0) return sprintNames;
  }
  const parsedStrings = sprintStringsSchema.safeParse(rawValue);
  if (!parsedStrings.success) return null;
  const raws = Array.isArray(parsedStrings.data) ? parsedStrings.data : [parsedStrings.data];
  const names = raws.flatMap((raw) => sprintNameOfToString(raw) ?? []);
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : null;
};

const CUSTOM_FIELD_PATTERN = /^customfield_\d+$/;

const parseBody = (schema, body, what) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new JiraError('server-error', `${what} did not answer the shape the view reads`);
  }
  return parsed.data;
};

const personNameOf = (person) => person?.displayName || person?.name || person?.key || null;

/**
 * An instance-absolute avatar or icon URL answers the path the app's own
 * proxy serves it under — the browser never holds the token that the
 * bytes need. A relative URL passes through with its path and query; a
 * URL of another origin answers null rather than travelling to a host
 * the user never connected.
 */
const instanceImagePathOf = (imageUrl, origin) => {
  if (!imageUrl) return null;
  try {
    const parsed = new URL(imageUrl, origin);
    if (parsed.origin !== origin) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
};

const personOf = (person, origin) =>
  person
    ? {
      name: personNameOf(person),
      key: person.key ?? person.name ?? null,
      avatarPath: instanceImagePathOf(person.avatarUrls?.['48x48'] ?? null, origin),
    }
    : null;

/**
 * One issue's custom fields, read through the `names` map: only a field
 * the instance names, whose value parses as a display shape, answers a
 * row. The Epic Link and Sprint fields also land in their dedicated
 * places — the epic summary is one extra GET, the sprint names are the
 * value's own — but they stay in this list too, the way Jira's own
 * detail column shows them.
 */
const customFieldsOf = (fields, names) => {
  const rows = [];
  let epicKey = null;
  let sprints = null;
  for (const [fieldId, rawValue] of Object.entries(fields)) {
    if (!CUSTOM_FIELD_PATTERN.test(fieldId)) continue;
    const name = names?.[fieldId] ?? null;
    if (!name) continue;
    // Rank and its relatives are board ordering keys — a person reads
    // nothing out of `1|hzzn87:`, so the row never exists.
    if (RANK_FIELD_NAME.test(name)) continue;
    // The Sprint row shows the parsed names, never GreenHopper's raw
    // `toString()` serialization — the same cleanup the dedicated sprint
    // reader applies.
    if (name === 'Sprint') {
      const sprintNames = sprintNamesOf(rawValue);
      if (sprintNames !== null) {
        rows.push({ id: fieldId, name, text: sprintNames.join(', ') });
        sprints = sprintNames;
      }
      continue;
    }
    if (name.toLowerCase() === 'development') {
      const devLine = devSummaryLineOf(rawValue);
      if (devLine !== null) rows.push({ id: fieldId, name, text: devLine });
      continue;
    }
    const text = displayTextOf(rawValue);
    if (text === null) continue;
    // Whatever else the instance spells as Java serialization is
    // machinery, not a value — the row drops instead of showing it raw.
    if (MACHINE_SERIALIZED.test(text)) continue;
    rows.push({ id: fieldId, name, text });
    if (name === 'Epic Link') {
      const parsedEpicKey = epicKeySchema.safeParse(rawValue);
      if (parsedEpicKey.success) epicKey = parsedEpicKey.data;
    }
  }
  return { rows, epicKey, sprints };
};

/**
 * One link, read by its direction: the link type spells the relation
 * differently on each side, and only one of `inwardIssue` and
 * `outwardIssue` is set per link. A link without both a type and a
 * target issue stretches nothing and is dropped.
 */
const issueLinkOf = (linkBody) => {
  const type = linkBody.type;
  const inward = Boolean(linkBody.inwardIssue);
  const target = inward ? linkBody.inwardIssue : linkBody.outwardIssue;
  if (!type || !target?.key) return null;
  return {
    typeName: type.name ?? null,
    relation: inward ? (type.inward ?? type.name ?? null) : (type.outward ?? type.name ?? null),
    issue: {
      key: target.key,
      summary: target.fields?.summary ?? null,
      statusName: target.fields?.status?.name ?? null,
      typeName: target.fields?.issuetype?.name ?? null,
    },
  };
};

/**
 * The epic of an Epic Link, one extra GET on top of the issue's own:
 * the summary and status the epic chip shows. A failure degrades to the
 * key alone — the link is the field's own truth, the name is decoration.
 */
const readEpic = async ({ request, config, epicKey }) => {
  try {
    const body = parseBody(
      epicSummaryBodySchema,
      await request({
        config,
        path: `/rest/api/2/issue/${encodeURIComponent(epicKey)}`,
        search: '?fields=summary,status',
      }),
      'the epic',
    );
    return {
      key: epicKey,
      name: body.fields?.summary ?? null,
      statusName: body.fields?.status?.name ?? null,
    };
  } catch (error) {
    if (!(error instanceof JiraError)) throw error;
    return { key: epicKey, name: null, statusName: null };
  }
};

/**
 * One issue's watchers, one GET beside the issue's own: the names Jira's
 * own sidebar lists. A permission-walled watchers page answers an error,
 * and the view degrades — the count from the issue body stays, the names
 * read null. No viewer fails because it cannot name the crowd.
 */
const readWatchers = async ({ request, config, key }) => {
  try {
    const body = parseBody(
      watchersBodySchema,
      await request({
        config,
        path: `/rest/api/2/issue/${encodeURIComponent(key)}/watchers`,
      }),
      'the watchers',
    );
    return {
      count: body.watchCount ?? body.watchers?.length ?? 0,
      watcherNames: (body.watchers ?? []).map((watcher) => personNameOf(watcher)).filter(Boolean),
    };
  } catch (error) {
    if (!(error instanceof JiraError)) throw error;
    return null;
  }
};

/**
 * The full view of one issue. The issue GET walks first — it carries the
 * names map and the fields everything else hangs off — then the watchers
 * page, then the epic's own GET when an Epic Link names one. The reader
 * returns the assembled view or throws the client's own error kinds.
 */
export const readJiraIssueView = async ({ request, config, ref }) => {
  const origin = config.origin;
  const issue = parseBody(
    issueBodySchema,
    await request({
      config,
      path: `/rest/api/2/issue/${encodeURIComponent(ref.key)}`,
      search: '?expand=renderedFields,names',
    }),
    'the issue',
  );
  const fields = issue.fields;
  const names = issue.names ?? null;

  const watchers = await readWatchers({ request, config, key: ref.key });
  const custom = customFieldsOf(fields, names);
  const epic = custom.epicKey ? await readEpic({ request, config, epicKey: custom.epicKey }) : null;

  // The rendered comment bodies match their raw twins by id; a missing
  // render answers null and the UI falls back to the raw body as text.
  const renderedCommentBodies = new Map();
  for (const rendered of issue.renderedFields?.comment?.comments ?? []) {
    if (rendered?.id) renderedCommentBodies.set(rendered.id, rendered.body ?? null);
  }

  const comments = (fields.comment?.comments ?? []).map((comment) => ({
    id: comment.id ?? null,
    author: personOf(comment.author, origin),
    created: comment.created ?? null,
    updated: comment.updated ?? null,
    edited: Boolean(comment.updated && comment.updated !== comment.created),
    html: (comment.id ? renderedCommentBodies.get(comment.id) : undefined) ?? null,
    text: comment.body ?? '',
  }));

  const issueLinks = (fields.issuelinks ?? [])
    .map((linkBody) => issueLinkOf(linkBody))
    .filter((link) => link !== null);

  const subtasks = (fields.subtasks ?? [])
    .filter((subtask) => subtask.key)
    .map((subtask) => ({
      key: subtask.key,
      summary: subtask.fields?.summary ?? null,
      statusName: subtask.fields?.status?.name ?? null,
      typeName: subtask.fields?.issuetype?.name ?? null,
    }));

  const attachments = (fields.attachment ?? []).map((attachment) => ({
    id: attachment.id ?? null,
    filename: attachment.filename ?? null,
    size: attachment.size ?? null,
    created: attachment.created ?? null,
    author: personNameOf(attachment.author),
  }));

  const commentTotal = fields.comment?.total ?? comments.length;

  return {
    issue: {
      key: issue.key ?? ref.key,
      url: ref.canonicalUrl ?? jiraIssueBrowseUrl(origin, issue.key ?? ref.key),
      summary: fields.summary ?? issue.key ?? ref.key,
      type: {
        name: fields.issuetype?.name ?? null,
        iconPath: instanceImagePathOf(fields.issuetype?.iconUrl ?? null, origin),
      },
      status: {
        name: fields.status?.name ?? null,
        category: fields.status?.statusCategory?.key ?? null,
      },
      resolution: fields.resolution?.name ?? null,
      priority: {
        name: fields.priority?.name ?? null,
        iconPath: instanceImagePathOf(fields.priority?.iconUrl ?? null, origin),
      },
      assignee: personOf(fields.assignee, origin),
      reporter: personOf(fields.reporter, origin),
      creator: personOf(fields.creator, origin),
      created: fields.created ?? null,
      updated: fields.updated ?? null,
      labels: fields.labels ?? [],
      components: (fields.components ?? []).map((component) => component.name ?? null).filter(Boolean),
      fixVersions: (fields.fixVersions ?? []).map((version) => version.name ?? null).filter(Boolean),
      affectsVersions: (fields.versions ?? []).map((version) => version.name ?? null).filter(Boolean),
      watchCount: fields.watches?.watchCount ?? watchers?.count ?? null,
      watcherNames: watchers?.watcherNames ?? null,
      customFields: custom.rows,
      epic,
      sprints: custom.sprints,
    },
    description: {
      wiki: fields.description ?? '',
      html: issue.renderedFields?.description ?? null,
    },
    comments,
    issueLinks,
    subtasks,
    attachments,
    truncated: {
      comments: commentTotal > comments.length,
    },
  };
};
