import { z } from 'zod';

import { asNonEmptyString } from '../shared/guards.js';

const LONG_WAIT_MS = 60_000;

export interface LimitFailoverSettings {
  fallbackModel?: string | undefined;
  fallbackVariant?: string | undefined;
  accountSwitchProviders?: string[];
}

export interface LimitFailoverConfigurationInput {
  fallbackModels?: unknown;
  fallbackModel?: unknown;
  fallbackVariant?: unknown;
  accountSwitchProviders?: unknown;
}

export interface FailoverModel {
  providerID: string;
  id: string;
  variant?: string;
}

export interface LimitFailure {
  resetAt: number;
}

export const DEFAULT_EXHAUSTION_MS = 60 * 60_000;

/**
 * How long a model stays skipped for one session after a failure that is not a
 * usage limit and says nothing about recovery: overload answers, network
 * failures, malformed requests. Long enough to outlive a provider hiccup,
 * short enough that a disabled model comes back the same working day.
 */
export const GENERIC_EXHAUSTION_MS = 10 * 60_000;

/** How long a session stays on a fallback model before the next message tries the original again. */
export const FALLBACK_RETURN_MS = 5 * 60_000;

/** A session's failover state is forgotten after this long without a decision. */
export const FALLBACK_FORGET_MS = 24 * 60 * 60_000;

/** The chain holds at most this many models, in the order they are tried. */
export const FALLBACK_CHAIN_LIMIT = 8;

export interface FailoverChainEntry {
  providerID: string;
  modelID: string;
  variant?: string | undefined;
}

/** Whether the error type speaks of a usage limit, rather than any other failure. */
export const isLimitErrorType = (type: string) => LIMIT_ERROR_TYPES.has(type);

const LIMIT_ERROR_TYPES = new Set([
  'provider.quota',
  'provider.free-limit',
  'provider.budget-limit',
  'provider.model-budget-limit',
  'provider.rate-limit',
]);

const epochMs = (value: number) => (value < 1e10 ? value * 1000 : value);
const resetAtSchema = z.union([
  z.number().positive().transform(epochMs),
  z.string().regex(/^\d+(\.\d+)?$/).transform(Number).pipe(z.number().positive()).transform(epochMs),
  z.string().transform((text) => Date.parse(text)).pipe(z.number().finite()),
]);
const waitSecondsSchema = z.coerce.number().positive();

const hintFields = {
  resets_at: resetAtSchema.optional().catch(undefined),
  reset_at: resetAtSchema.optional().catch(undefined),
  resetsAt: resetAtSchema.optional().catch(undefined),
  resetAt: resetAtSchema.optional().catch(undefined),
  retry_after: waitSecondsSchema.optional().catch(undefined),
  retryAfter: waitSecondsSchema.optional().catch(undefined),
  resets_in_seconds: waitSecondsSchema.optional().catch(undefined),
  reset_in_seconds: waitSecondsSchema.optional().catch(undefined),
};
const hintsSchema = z.object(hintFields);
const limitBodySchema = z
  .string()
  .transform((text, context) => {
    try {
      return JSON.parse(text);
    } catch {
      context.addIssue({ code: 'custom', message: 'not JSON' });
      return z.NEVER;
    }
  })
  .pipe(hintsSchema.extend({ error: hintsSchema.optional().catch(undefined) }));

const resetFromHints = (hints: z.output<typeof hintsSchema>, now: number) => {
  const at = hints.resets_at ?? hints.reset_at ?? hints.resetsAt ?? hints.resetAt;
  if (at !== undefined && at > now) return at;
  const seconds = hints.retry_after ?? hints.retryAfter ?? hints.resets_in_seconds ?? hints.reset_in_seconds;
  return seconds === undefined ? null : now + seconds * 1000;
};

export const parseLimitResetAt = (error: LimitReport['error'] | null | undefined, now: number) => {
  if (error?.retryAfterMs !== undefined && error.retryAfterMs > 0) return now + error.retryAfterMs;
  const body = limitBodySchema.safeParse(error?.body);
  if (!body.success) return null;
  return resetFromHints(body.data, now) ?? (body.data.error ? resetFromHints(body.data.error, now) : null);
};

export const classifyFailure = (report: LimitReport, now: number): LimitFailure | null => {
  const error = report.error;
  // A report without a usable proposed decision counts as "still retrying":
  // guessing "given up" would fail the session over on every transient error
  // a future OpenCode stops attaching the decision to.
  const proposed = report.proposed ?? { retry: true, delay: 0 };
  if (!LIMIT_ERROR_TYPES.has(error.type)) {
    if (proposed.retry) return null;
    return { resetAt: now + GENERIC_EXHAUSTION_MS };
  }
  const resetAt = parseLimitResetAt(error, now);
  const proposedDelay = proposed.retry ? proposed.delay : 0;
  if (error.type === 'provider.rate-limit') {
    const wait = Math.max(proposedDelay, resetAt === null ? 0 : resetAt - now);
    if (wait < LONG_WAIT_MS) return null;
  }
  if (resetAt !== null) return { resetAt };
  return { resetAt: now + (proposedDelay >= LONG_WAIT_MS ? proposedDelay : DEFAULT_EXHAUSTION_MS) };
};

const chainEntrySchema = z
  .object({
    providerID: z.string().trim().min(1),
    modelID: z.string().trim().min(1),
    variant: z.string().trim().min(1).optional().catch(undefined),
  })
  .transform((entry) => entry.variant ? { providerID: entry.providerID, id: entry.modelID, variant: entry.variant } : { providerID: entry.providerID, id: entry.modelID });

/**
 * The fallback models in the order they are tried, each
 * `{ providerID, id, variant? }`. `fallbackModels` is the setting; when it is
 * absent (an install that has not saved the list yet) the single
 * `fallbackModel`/`fallbackVariant` pair stands in as a one-model chain. An
 * empty `fallbackModels` array means the user cleared the list, so the legacy
 * pair is not resurrected.
 */
export const parseModelChain = (settings: LimitFailoverConfigurationInput | null | undefined): FailoverModel[] => {
  const stored = settings?.fallbackModels;
  if (Array.isArray(stored)) {
    const chain: FailoverModel[] = [];
    const seen = new Set<string>();
    for (const entry of stored) {
      if (chain.length >= FALLBACK_CHAIN_LIMIT) break;
      const parsed = chainEntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const key = `${parsed.data.providerID}/${parsed.data.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(parsed.data);
    }
    return chain;
  }
  const legacy = parseModelSetting(
    typeof settings?.fallbackModel === 'string' ? settings.fallbackModel : undefined,
    typeof settings?.fallbackVariant === 'string' ? settings.fallbackVariant : undefined,
  );
  return legacy ? [legacy] : [];
};

/** Whether either option is on, so the managed OpenCode needs the plugin at all. */
export const isLimitFailoverConfigured = (settings: LimitFailoverConfigurationInput | null | undefined) => (
  parseModelChain(settings).length > 0
  || (Array.isArray(settings?.accountSwitchProviders) && settings.accountSwitchProviders.length > 0)
);

export const parseModelSetting = (value: LimitFailoverConfigurationInput['fallbackModel'], variantValue?: string | null): FailoverModel | null => {
  const text = asNonEmptyString(value);
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  const model = { providerID: text.slice(0, slash), id: text.slice(slash + 1) };
  const variant = asNonEmptyString(variantValue);
  return variant ? { ...model, variant } : model;
};

const credentialSchema = z
  .object({ id: z.string().min(1), label: z.string().optional().catch(undefined) })
  .transform((credential) => ({ id: credential.id, label: credential.label || credential.id }));

export const reportSchema = z.object({
  sessionID: z.string().min(1),
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  error: z.object({
    type: z.string().min(1),
    message: z.string().catch(''),
    body: z.string().nullable().catch(null).default(null),
    retryAfterMs: z.number().finite().nonnegative().optional().catch(undefined),
  }),
  proposed: z
    .union([
      z.object({ retry: z.literal(true), delay: z.number().finite().nonnegative() }),
      z.object({ retry: z.literal(false) }),
    ])
    // An unreadable proposed decision means "OpenCode still wants to retry":
    // guessing "given up" would fail the session over on every transient
    // error a future OpenCode stops attaching the decision to.
    .catch({ retry: true, delay: 0 }),
  credentials: z
    .array(z.unknown())
    .catch([])
    .transform((items) => items.flatMap((item) => {
      const credential = credentialSchema.safeParse(item);
      return credential.success ? [credential.data] : [];
    })),
  activeCredentialID: z.string().min(1).optional().catch(undefined),
});

export type LimitReport = z.output<typeof reportSchema>;
export type LimitReportInput = z.input<typeof reportSchema>;
