/**
 * The Bitbucket Data Center connection: one instance, one access token.
 *
 * The state lives in `bitbucket.json` beside teams.json and missions.json,
 * the same self-contained persistence the fork's other services use. The
 * token is a secret — `readPublic` answers whether one exists, never the
 * token itself, so the settings card can show "connected" without handing
 * the secret to every open tab that asks.
 *
 * Writes go through one serialized path: the state moves first (the next
 * read sees what was just saved, not an older file), the file write
 * follows, and a failed write rolls the state back and throws, so the
 * route answers the failure instead of a success the disk never got.
 *
 * The token contract mirrors prUrl's: a form that carries the token writes
 * it, a form that leaves the field out keeps the stored one (the user
 * toggles TLS settings without retyping a secret), and an explicit empty
 * string clears the connection.
 */

import { z } from 'zod';

const STATE_FILE_NAME = 'bitbucket.json';
const STATE_VERSION = 1;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const instanceOriginSchema = z.string().trim().transform((value, ctx) => {
  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the instance must be a valid address, like https://bitbucket.example.com' });
    return z.NEVER;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the instance must be an origin, without a path, query, user or password' });
    return z.NEVER;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the instance must use HTTPS (HTTP is allowed only for loopback addresses)' });
    return z.NEVER;
  }
  return url.origin;
});

const tokenSchema = z.string().trim().min(1).max(400);

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  instance: z.object({
    origin: z.string().min(1),
    token: z.string().min(1),
    verifySsl: z.boolean(),
  }).nullable(),
});

/**
 * A save's shape, parsed at this boundary: the route passes `req.body`
 * straight in. `token` follows the saved-secret contract — absent keeps
 * the stored one, an empty string clears it. `disconnect: true` drops
 * the connection and ignores the rest.
 */
const saveInputSchema = z.strictObject({
  origin: z.string().optional(),
  token: z.string().optional(),
  verifySsl: z.boolean().optional(),
  disconnect: z.boolean().optional(),
});

const emptyState = () => stateSchema.parse({ version: STATE_VERSION, instance: null });

export const createBitbucketConfigStore = ({ fsPromises, path, dataDir }) => {
  if (!fsPromises || !path || !dataDir) throw new Error('bitbucket config store needs fsPromises, path and dataDir');

  const statePath = path.join(dataDir, STATE_FILE_NAME);

  /** The last known state: the file on first read, then what was saved. */
  let latest = null;
  // Writes serialize behind each other, so a rapid Origin edit cannot
  // interleave with a disconnect and land a cleared file after a save.
  let writeChain = Promise.resolve();

  const readFileState = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch {
      // A corrupt file is a missing file: the card asks for the instance
      // again rather than booting half a connection.
      return emptyState();
    }
  };

  const getState = async () => {
    if (latest === null) latest = await readFileState();
    return latest;
  };

  /**
   * Move the state, then persist it in write order. A failed write rolls
   * the state back — unless a newer save has already replaced it — so the
   * route answers the failure instead of a success the disk never got.
   */
  const write = (next) => {
    const previous = latest;
    latest = next;
    // The `.catch` keeps one failed write from poisoning the chain: the
    // next save must still reach the disk, not inherit the old rejection.
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        try {
          await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
          await fsPromises.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        } catch {
          if (latest === next) latest = previous;
          const failure = new Error('could not persist the Bitbucket connection');
          failure.statusCode = 500;
          throw failure;
        }
      });
    return writeChain;
  };

  return {
    /** The full private config, for the server's own API calls. */
    read: async () => getState(),

    /** The settings card's view: never the token, only the fact of it. */
    readPublic: async () => {
      const { instance } = await getState();
      if (!instance) return { configured: false };
      return {
        configured: true,
        origin: instance.origin,
        hasToken: Boolean(instance.token),
        verifySsl: instance.verifySsl,
      };
    },

    /**
     * Write the connection. Fields are independent: `origin` and
     * `verifySsl` follow the plain present-means-write rule, `token` the
     * saved-secret rule (absent keeps, '' clears). `disconnect: true`
     * drops the connection and ignores the rest.
     */
    save: async (rawInput) => {
      const parsedInput = saveInputSchema.safeParse(rawInput ?? {});
      if (!parsedInput.success) {
        const error = new Error(parsedInput.error.issues[0]?.message ?? 'the connection body must carry origin, token, verifySsl or disconnect');
        error.statusCode = 400;
        throw error;
      }
      const input = parsedInput.data;
      const existing = await getState();
      const existingInstance = existing.instance ?? {};

      if (input.disconnect === true) {
        await write(emptyState());
        return { configured: false };
      }

      const errors = [];
      // Each field settles on its own: a value that came in, or the stored
      // one, or the field's default. Nothing invents a fourth source.
      let origin = existingInstance.origin;
      let token = existingInstance.token;
      const verifySsl = existingInstance.verifySsl ?? true;

      if (input.origin !== undefined) {
        const parsedOrigin = instanceOriginSchema.safeParse(input.origin);
        if (!parsedOrigin.success) errors.push(parsedOrigin.error.issues[0]?.message ?? 'invalid instance');
        else origin = parsedOrigin.data;
      }
      // A token before any instance exists has nowhere to live.
      if (input.token !== undefined && input.origin === undefined && !existingInstance.origin) {
        errors.push('set the instance address before saving a token');
      }
      // The token: absent keeps the stored one, '' clears the connection,
      // anything else must parse as the credential it claims to be.
      if (errors.length === 0 && input.token !== undefined) {
        if (input.token === '') {
          token = undefined;
        } else {
          const parsedToken = tokenSchema.safeParse(input.token);
          if (!parsedToken.success) errors.push('the access token is required — at most 400 characters');
          else token = parsedToken.data;
        }
      }

      if (errors.length > 0) {
        const error = new Error(errors.join('; '));
        error.statusCode = 400;
        throw error;
      }

      const instance = (origin !== undefined && token !== undefined)
        ? { origin, token, verifySsl: input.verifySsl ?? verifySsl }
        : null;
      await write(stateSchema.parse({ version: STATE_VERSION, instance }));
      return instance
        ? { configured: true, origin: instance.origin, hasToken: true, verifySsl: instance.verifySsl }
        : { configured: false };
    },

    /** Drop the connection outright — the disconnect path. */
    clear: async () => {
      await write(emptyState());
      return { configured: false };
    },
  };
};
