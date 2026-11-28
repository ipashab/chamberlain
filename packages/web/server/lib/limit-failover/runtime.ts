import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  classifyFailure,
  FALLBACK_FORGET_MS,
  FALLBACK_RETURN_MS,
  isLimitErrorType,
  parseModelChain,
  reportSchema,
} from './policy.js';
import type { FailoverModel, LimitReport } from './policy.js';
import type { Application, ExpressFactory, Request } from '../shared/http-contracts.js';

export type LimitFailoverAnnouncement = {
  kind: 'account';
  sessionId: string;
  providerId: string;
  fromAccount: string | null;
  toAccount: string;
} | {
  kind: 'model';
  sessionId: string;
  providerId: string;
  modelId: string;
  toProviderId: string;
  toModelId: string;
  /** What moved the session: a usage limit, or any other failure OpenCode gave up on. */
  reason: 'limit' | 'error';
} | {
  kind: 'model-return';
  sessionId: string;
  providerId: string;
  modelId: string;
  toProviderId: string;
  toModelId: string;
};

export type LimitFailoverDecision =
  | { action: 'none' }
  | { action: 'retry' }
  | { action: 'activate-credential'; credentialID: string; ticket?: string }
  | { action: 'switch-model'; model: FailoverModel; ticket: string };

export interface LimitFailoverDependencies {
  fsPromises: typeof import('node:fs/promises');
  path: typeof import('node:path');
  instanceDir: string;
  readSettings: () => Promise<StoredFailoverSettings | null>;
  authorizeRequest: (req: Request) => boolean;
  broadcastUiEvent?: (event: { type: 'openchamber:limit-failover'; properties: LimitFailoverAnnouncement }) => void;
  now?: () => number;
}

export interface StoredFailoverSettings {
  accountSwitchProviders?: unknown;
  fallbackModels?: unknown;
  fallbackModel?: unknown;
  fallbackVariant?: unknown;
}

interface FailoverEpisode {
  at: number;
  /** The model the session came from and may return to. */
  original: FailoverModel;
  /** The model the latest switch left, for the duplicate guard. */
  left: FailoverModel;
  /** The switch decision that recorded the episode, while its outcome is unknown. */
  ticketID?: string | undefined;
}

interface SwitchTicket {
  sessionID: string;
  credentialID: string | null;
  announcement: LimitFailoverAnnouncement;
}

interface FailoverReturnProbe {
  sessionID: string;
  providerID: string;
  modelID: string;
}

const settleSchema = z.object({ ticket: z.string().min(1), applied: z.boolean() });

const PLUGIN_ID = 'openchamber-limit-failover';
const ROUTE = '/api/openchamber/limit-failover';

const SWITCH_GRACE_MS = 60_000;

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({
  name: PLUGIN_ID,
  version: '0.0.0',
  private: true,
  type: 'module',
  exports: { '.': './index.js' },
}, null, 2)}\n`;

export const LIMIT_FAILOVER_PLUGIN_HELPERS = `const LIMIT_FAILOVER_ROUTE = ${JSON.stringify(ROUTE)}

// Location-scoped reads answer { location, data }.
const failoverAccounts = async (ctx, providerID) => {
  const provider = (await ctx.provider.get({ providerID }).catch(() => undefined))?.data
  const integrationID = provider?.integrationID ?? providerID
  const integration = (await ctx.integration.get({ integrationID }).catch(() => undefined))?.data
  const active = await ctx.integration.connection.active(integrationID).catch(() => undefined)
  return {
    credentials: (integration?.connections ?? [])
      .filter((connection) => connection.type === "credential")
      .map((connection) => ({ id: connection.id, label: connection.label })),
    activeCredentialID: active?.type === "credential" ? active.id : undefined,
  }
}

const failoverSettle = (target, ticket, applied) => ticket
  ? fetch(target.url + "/settle", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
      body: JSON.stringify({ ticket, applied }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
  : undefined
`;

export const createLimitFailoverSetupCode = ({ callbackExpr }: { callbackExpr: string }) => `    // Every failed request is reported; the server decides which ones act on.
    await ctx.session.hook("retry", async (event) => {
      const target = (${callbackExpr})
      if (!target) return
      try {
        const response = await fetch(target.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({
            sessionID: event.sessionID,
            providerID: event.model.providerID,
            modelID: event.model.id,
            error: {
              type: event.error.type,
              message: event.error.message,
              body: event.error.response?.body,
              retryAfterMs: event.error.retryAfterMs,
            },
            proposed: event.decision,
            ...(await failoverAccounts(ctx, event.model.providerID)),
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (answer.action === "retry") {
          event.decision = { retry: true, delay: 0 }
          return
        }
        if (answer.action !== "activate-credential" && answer.action !== "switch-model") return
        // The server announces a switch only once it happened, so it hears the outcome either way.
        try {
          if (answer.action === "activate-credential") {
            await ctx.credential.activate({ credentialID: answer.credentialID })
          } else {
            await ctx.session.switchModel({ sessionID: event.sessionID, model: answer.model })
          }
        } catch {
          await failoverSettle(target, answer.ticket, false)
          return
        }
        event.decision = { retry: true, delay: 0 }
        await failoverSettle(target, answer.ticket, true)
      } catch {
        // OpenCode's own decision stands when the server cannot be reached.
      }
    })
    // A session running on a fallback model asks, with every new message,
    // whether the model it came from may take the session back. The probe is
    // advisory and must not hold the message hostage when the server is slow.
    await ctx.session.hook("chat.message", async (event) => {
      if (!event.model) return
      const target = (${callbackExpr})
      if (!target) return
      try {
        const response = await fetch(target.url + "/return", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + target.token },
          body: JSON.stringify({
            sessionID: event.sessionID,
            providerID: event.model.providerID,
            modelID: event.model.id,
          }),
          signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) return
        const answer = await response.json()
        if (answer.action !== "switch-model" || !answer.model) return
        await ctx.session.switchModel({ sessionID: event.sessionID, model: answer.model })
        await failoverSettle(target, answer.ticket, true)
      } catch {
        // The session stays on its current model when the server cannot be reached.
      }
    })`;

const PLUGIN_SOURCE = `${LIMIT_FAILOVER_PLUGIN_HELPERS}
const callback = () => {
  const base = process.env.OPENCHAMBER_AGENT_TOOL_URL
  const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
  if (!base || !token || !URL.canParse(base)) return null
  return { url: new URL(LIMIT_FAILOVER_ROUTE, base).href, token }
}

export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  setup: async (ctx) => {
${createLimitFailoverSetupCode({ callbackExpr: 'callback()' })}
  },
}
`;

export const createLimitFailoverRuntime = ({
  fsPromises,
  path,
  instanceDir,
  readSettings,
  authorizeRequest,
  broadcastUiEvent = () => {},
  now = Date.now,
}: LimitFailoverDependencies) => {
  const pluginDirectory = path.join(instanceDir, 'limit-failover', PLUGIN_ID);

  const exhaustedUntil = new Map<string, number>();
  const switchedAt = new Map<string, number>();
  const settledAt = new Map<string, number>();
  const tickets = new Map<string, SwitchTicket & { openedAt: number }>();
  /** `session:provider/model` -> when that model may serve that session again. */
  const exhaustedModels = new Map<string, number>();
  /** Session id -> the failover episode: when the session fell forward, and the model it came from. */
  const fallbackSince = new Map<string, FailoverEpisode>();

  const openTicket = (at: number, ticket: SwitchTicket) => {
    const id = randomUUID();
    tickets.set(id, { ...ticket, openedAt: at });
    return id;
  };

  const forgetOldSettlements = (at: number) => {
    for (const [credentialID, when] of switchedAt) {
      if (when <= at - SWITCH_GRACE_MS) switchedAt.delete(credentialID);
    }
    for (const [key, when] of settledAt) {
      if (when <= at - SWITCH_GRACE_MS) settledAt.delete(key);
    }
    for (const [id, ticket] of tickets) {
      if (ticket.openedAt <= at - SWITCH_GRACE_MS) tickets.delete(id);
    }
    for (const [key, until] of exhaustedModels) {
      if (until <= at) exhaustedModels.delete(key);
    }
    for (const [sessionID, entry] of fallbackSince) {
      if (entry.at <= at - FALLBACK_FORGET_MS) fallbackSince.delete(sessionID);
    }
  };

  const isModelExhausted = (sessionID: string, model: FailoverModel, at: number) => {
    const key = `${sessionID}:${model.providerID}/${model.id}`;
    const until = exhaustedModels.get(key);
    if (until === undefined) return false;
    if (until > at) return true;
    exhaustedModels.delete(key);
    return false;
  };

  const materializePlugin = async () => {
    await fsPromises.mkdir(pluginDirectory, { recursive: true });
    await fsPromises.writeFile(path.join(pluginDirectory, 'package.json'), PLUGIN_PACKAGE_JSON, { mode: 0o600 });
    await fsPromises.writeFile(path.join(pluginDirectory, 'index.js'), PLUGIN_SOURCE, { mode: 0o600 });
    return pluginDirectory;
  };

  const isExhausted = (credentialID: string, at: number) => {
    const until = exhaustedUntil.get(credentialID);
    if (until === undefined) return false;
    if (until > at) return true;
    exhaustedUntil.delete(credentialID);
    return false;
  };

  const nextCredential = (report: LimitReport, at: number) => {
    const { credentials, activeCredentialID } = report;
    const start = credentials.findIndex((credential) => credential.id === activeCredentialID);
    const order = start === -1
      ? credentials
      : [...credentials.slice(start + 1), ...credentials.slice(0, start)];
    return order.find((candidate) => !isExhausted(candidate.id, at)) ?? null;
  };

  const decideNow = async (report: LimitReport): Promise<LimitFailoverDecision> => {
    const at = now();
    const failure = classifyFailure(report, at);
    if (!failure) return { action: 'none' };

    forgetOldSettlements(at);
    const active = report.activeCredentialID;
    if (active) {
      const key = `${report.sessionID}:${active}`;
      const switched = switchedAt.get(active);
      if (switched !== undefined && !((settledAt.get(key) ?? -Infinity) >= switched)) {
        settledAt.set(key, at);
        return { action: 'retry' };
      }
      exhaustedUntil.set(active, failure.resetAt);
    }

    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const switchProviders = Array.isArray(settings?.accountSwitchProviders) ? settings.accountSwitchProviders : [];
    if (switchProviders.includes(report.providerID)) {
      const next = nextCredential(report, at);
      if (next) {
        settledAt.set(`${report.sessionID}:${next.id}`, at);
        if (switchedAt.has(next.id)) return { action: 'activate-credential', credentialID: next.id };
        switchedAt.set(next.id, at);
        const ticket = openTicket(at, {
          sessionID: report.sessionID,
          credentialID: next.id,
          announcement: {
            kind: 'account',
            sessionId: report.sessionID,
            providerId: report.providerID,
            fromAccount: report.credentials.find((credential) => credential.id === active)?.label ?? null,
            toAccount: next.label,
          },
        });
        return { action: 'activate-credential', credentialID: next.id, ticket };
      }
    }

    // The fallback chain, in order. A session on a chain model moves to the
    // next entry; a session on a model outside the chain starts at the top.
    const chain = parseModelChain(settings);
    const currentIndex = chain.findIndex((model) => model.providerID === report.providerID && model.id === report.modelID);
    const ordered = currentIndex === -1 ? chain : chain.slice(currentIndex + 1);
    const next = ordered.find((model) => !isModelExhausted(report.sessionID, model, at)) ?? null;
    if (next) {
      const episode = fallbackSince.get(report.sessionID);
      // A retry burst on the model this session just left arrives while the
      // switch for that move is already decided or done; a plain retry keeps
      // it from announcing the same move twice.
      if (
        episode
        && episode.left.providerID === report.providerID
        && episode.left.id === report.modelID
        && at - episode.at < SWITCH_GRACE_MS
      ) return { action: 'retry' };
      exhaustedModels.set(`${report.sessionID}:${report.providerID}/${report.modelID}`, failure.resetAt);
      const ticket = openTicket(at, {
        sessionID: report.sessionID,
        credentialID: null,
        announcement: {
          kind: 'model',
          sessionId: report.sessionID,
          providerId: report.providerID,
          modelId: report.modelID,
          toProviderId: next.providerID,
          toModelId: next.id,
          reason: isLimitErrorType(report.error.type) ? 'limit' : 'error',
        },
      });
      // The episode starts when the decision is made, not when the plugin
      // settles it: a lost settle report would otherwise leave the session on
      // the fallback model with nothing to return from. A decision whose
      // switch never happened is retracted by `settle` or by the next return
      // probe, whichever sees the session first.
      fallbackSince.set(report.sessionID, {
        at,
        original: episode?.original ?? { providerID: report.providerID, id: report.modelID },
        left: { providerID: report.providerID, id: report.modelID },
        ticketID: ticket,
      });
      return { action: 'switch-model', model: next, ticket };
    }
    return { action: 'none' };
  };

  /**
   * What the plugin should do about a new message on a session that fell back:
   * return it to the model it came from once the cooldown has passed and that
   * model may serve the session again, or keep it where it is. A session the
   * user moved to a model outside the chain ends its episode.
   */
  const decideReturnNow = async (probe: FailoverReturnProbe): Promise<LimitFailoverDecision> => {
    const at = now();
    forgetOldSettlements(at);
    const entry = fallbackSince.get(probe.sessionID);
    if (!entry) return { action: 'none' };
    // A switch decision whose outcome is still unknown may be about to move
    // the session; leave the record alone until its settle report speaks.
    if (entry.ticketID && tickets.has(entry.ticketID)) return { action: 'none' };
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const chain = parseModelChain(settings);
    const onChain = chain.some((model) => model.providerID === probe.providerID && model.id === probe.modelID);
    if (!onChain) {
      fallbackSince.delete(probe.sessionID);
      return { action: 'none' };
    }
    const { original } = entry;
    if (original.providerID === probe.providerID && original.id === probe.modelID) {
      fallbackSince.delete(probe.sessionID);
      return { action: 'none' };
    }
    if (at - entry.at < FALLBACK_RETURN_MS) return { action: 'none' };
    if (isModelExhausted(probe.sessionID, original, at)) return { action: 'none' };
    const ticket = openTicket(at, {
      sessionID: probe.sessionID,
      credentialID: null,
      announcement: {
        kind: 'model-return',
        sessionId: probe.sessionID,
        providerId: probe.providerID,
        modelId: probe.modelID,
        toProviderId: original.providerID,
        toModelId: original.id,
      },
    });
    return { action: 'switch-model', model: original, ticket };
  };

  const settle = (ticketID: string, applied: boolean) => {
    const ticket = tickets.get(ticketID);
    if (!ticket) return false;
    tickets.delete(ticketID);
    if (applied) {
      broadcastUiEvent({ type: 'openchamber:limit-failover', properties: ticket.announcement });
      if (ticket.announcement.kind === 'model') {
        const existing = fallbackSince.get(ticket.sessionID);
        const from = { providerID: ticket.announcement.providerId, id: ticket.announcement.modelId };
        // The decision already recorded the episode; the applied report pins
        // its cooldown to the switch that actually happened, and names the
        // model the session just left for the duplicate guard. The
        // announcement's from-model stands in for the original when the
        // decision's record was already cleaned up in between.
        fallbackSince.set(ticket.sessionID, {
          at: ticket.openedAt,
          original: existing?.original ?? from,
          left: from,
        });
      } else if (ticket.announcement.kind === 'model-return') {
        fallbackSince.delete(ticket.sessionID);
      }
    } else if (ticket.credentialID) {
      switchedAt.delete(ticket.credentialID);
      settledAt.delete(`${ticket.sessionID}:${ticket.credentialID}`);
    } else if (ticket.announcement.kind === 'model') {
      const entry = fallbackSince.get(ticket.sessionID);
      if (entry?.ticketID === ticketID) {
        // The switch never happened, so the session still stands where the
        // report found it. From the model the episode came from that ends the
        // episode; from a later chain position the episode continues there, and
        // a later decision replaces the record before its own outcome speaks.
        const from = { providerID: ticket.announcement.providerId, id: ticket.announcement.modelId };
        if (entry.original.providerID === from.providerID && entry.original.id === from.id) {
          fallbackSince.delete(ticket.sessionID);
        } else {
          fallbackSince.set(ticket.sessionID, { ...entry, at: ticket.openedAt, left: from, ticketID: undefined });
        }
      }
    }
    return true;
  };

  // One decision at a time: sessions on the same account fail together, and
  // the second report must see the switch the first one made (it then gets a
  // grace retry) instead of switching again. SAFETY: every queued runner
  // resolves to a LimitFailoverDecision; the catch branch pads the chain with
  // `undefined` only so a rejected decision cannot poison the next one.
  let queue: Promise<LimitFailoverDecision | undefined> = Promise.resolve<LimitFailoverDecision | undefined>(undefined);
  const queueDecision = (run: () => Promise<LimitFailoverDecision>): Promise<LimitFailoverDecision> => {
    const result = queue.then(run);
    queue = result.catch((): LimitFailoverDecision | undefined => undefined);
    return result;
  };
  const decide = (report: LimitReport) => queueDecision(() => decideNow(report));
  const decideReturn = (probe: FailoverReturnProbe) => queueDecision(() => decideReturnNow(probe));

  const returnSchema = z.object({
    sessionID: z.string().min(1),
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  });

  const registerRoutes = (app: Application, express: Pick<ExpressFactory, 'json'>) => {
    app.post(ROUTE, express.json({ limit: '256kb' }), async (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const report = reportSchema.safeParse(req.body);
      if (!report.success) return res.status(400).json({ error: 'Invalid limit report' });
      return res.json(await decide(report.data));
    });
    app.post(`${ROUTE}/return`, express.json({ limit: '16kb' }), async (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const probe = returnSchema.safeParse(req.body);
      if (!probe.success) return res.status(400).json({ error: 'Invalid return probe' });
      return res.json(await decideReturn(probe.data));
    });
    app.post(`${ROUTE}/settle`, express.json({ limit: '16kb' }), (req, res) => {
      if (!authorizeRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
      const outcome = settleSchema.safeParse(req.body);
      if (!outcome.success) return res.status(400).json({ error: 'Invalid outcome' });
      return res.json({ settled: settle(outcome.data.ticket, outcome.data.applied) });
    });
  };

  return { pluginDirectory, materializePlugin, decide, decideReturn, settle, registerRoutes };
};
