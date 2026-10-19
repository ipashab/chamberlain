import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { WorkspaceModeOfferReason } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';

// The one mode-offer card. A debug run started from chat or a tracker item
// opened there can suggest its mode; this card is the whole suggestion, and
// only its accept click takes the screen. One visible offer at a time, each
// reason once per app run.

const OFFER_ICON = {
  'debug-run': 'bug',
  'tracker-item': 'clipboard',
} as const satisfies Record<WorkspaceModeOfferReason, IconName>;

export const WorkspaceModeOffer: React.FC = () => {
  const { t } = useI18n();
  const offer = useUIStore((state) => state.workspaceModeOffer);
  const switchWorkspaceMode = useUIStore((state) => state.switchWorkspaceMode);
  const dismissWorkspaceModeOffer = useUIStore((state) => state.dismissWorkspaceModeOffer);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  if (!offer || isVSCode) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center pt-2">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 shadow-md"
      >
        <Icon name={OFFER_ICON[offer.reason]} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col">
          <span className="typography-ui-header text-foreground">{t(`workspaceMode.offer.${offer.reason}.title`)}</span>
          <span className="typography-micro text-muted-foreground">{t(`workspaceMode.offer.${offer.reason}.text`)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => switchWorkspaceMode(offer.directory, offer.mode)}
          >
            {t(`workspaceMode.offer.${offer.reason}.accept`)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('workspaceMode.offer.decline')}
            onClick={dismissWorkspaceModeOffer}
          >
            {t('workspaceMode.offer.decline')}
          </Button>
        </div>
      </div>
    </div>
  );
};
