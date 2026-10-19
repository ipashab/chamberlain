import React from 'react';
import { useSession, useSessionStatus } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';
import { getCurrentSessionAdvisor, type AdvisorFinding } from '@/lib/advisorMetadata';
import { useUIStore } from '@/stores/useUIStore';

const VISIBLE_FINDINGS = 3;

const severityClass = (severity: AdvisorFinding['severity']) => (
  severity === 'P0' || severity === 'P1'
    ? 'text-status-error/80'
    : severity === 'P2'
      ? 'text-status-warning/80'
      : 'text-muted-foreground/60'
);

interface AdvisorNoteProps {
  sessionId: string;
  directory?: string;
  isMobile: boolean;
}

/**
 * The findings the server's post-turn advisor stored for the newest turn,
 * under the answer like the recap. Deterministic findings (rules, anchors)
 * and Small Model findings land in the same quiet list; a new turn makes the
 * payload stale and the row goes away with it.
 */
export const AdvisorNote: React.FC<AdvisorNoteProps> = React.memo(({ sessionId, directory, isMobile }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? '', directory);
  const status = useSessionStatus(sessionId ?? '', directory);
  const advisorEnabled = useUIStore((state) => state.sessionAdvisorEnabled);

  const isIdle = !status || status.type === 'idle';
  const advisor = advisorEnabled && isIdle ? getCurrentSessionAdvisor(session) : null;
  if (!advisor) return null;

  const visible = advisor.findings.slice(0, VISIBLE_FINDINGS);
  const rest = advisor.findings.length - visible.length;

  return (
    <div aria-label={t('chat.advisor.aria')} className="px-1">
      <div className={`typography-meta text-muted-foreground/70 ${isMobile ? 'line-clamp-4' : 'line-clamp-3'}`}>
        {visible.map((finding, index) => (
          <React.Fragment key={`${finding.source}-${index}`}>
            {index > 0 ? <br /> : null}
            <span className={`font-mono ${severityClass(finding.severity)}`}>{finding.severity}</span>
            {' '}
            <span className="italic text-muted-foreground/50">{finding.file ? `${finding.file} — ` : ''}</span>
            {finding.note}
          </React.Fragment>
        ))}
        {rest > 0
          ? (
            <>
              <br />
              <span className="italic text-muted-foreground/50">{t('chat.advisor.more', { count: rest })}</span>
            </>
          )
          : null}
      </div>
    </div>
  );
});

AdvisorNote.displayName = 'AdvisorNote';
