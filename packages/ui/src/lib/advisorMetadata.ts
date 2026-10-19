import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';

// The post-turn advisor's findings, stored under session metadata
// `openchamber.advisor` by the server's turn reviewer. `forMessageID` names
// the answer the findings were written for. Freshness follows the recap
// payload's one rule (`sessionAssistMetadata.ts`): the advisor runs after
// the turn ends, so a stored payload older than the session's latest turn
// end describes an older turn and is not shown.
//
// The shape is parsed at the boundary: a findings list that fails its
// contract drops only the failing entries through the array filter below,
// and a payload without usable findings is null, the same answer as no
// payload at all.

const findingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  source: z.enum(['rules', 'anchor', 'model']),
  note: z.string().trim().min(1),
  file: z.string().trim().min(1).optional(),
});

const advisorSchema = z.object({
  at: z.number(),
  forMessageID: z.string().min(1),
  findings: z.array(findingSchema).min(1),
}).loose();

const envelopeSchema = z.object({
  openchamber: z.object({ advisor: advisorSchema }).loose(),
}).loose();

export type AdvisorFinding = z.infer<typeof findingSchema>;
export type SessionAdvisorPayload = z.infer<typeof advisorSchema>;

/** The one freshness rule for stored findings; callers still hide them while a turn runs. */
export function getCurrentSessionAdvisor(session: Session | null | undefined): SessionAdvisorPayload | null {
  const parsed = envelopeSchema.safeParse(session?.metadata);
  if (!parsed.success) return null;
  if (session?.revert?.messageID) return null;
  const advisor = parsed.data.openchamber.advisor;
  const idleAt = session?.time?.idle ?? 0;
  return advisor.at >= idleAt ? advisor : null;
}
