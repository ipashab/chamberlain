// The moments a folder's group preset meets an existing session: the offer a
// dropped session gets to switch onto the group's agent. One toast, one
// decision, nothing automatic afterwards — the session keeps whatever agent it
// ends up with, and the folder never re-switches it on its own.

import { toast } from '@/components/ui';
import type { I18nKey, I18nParams } from '@/lib/i18n';

import { opencodeClient } from '@/lib/opencode/client';

type Translator = (key: I18nKey, params?: I18nParams) => string;

const dismissedFolderOffers = new Set<string>();

/** A folder-session pair the user already answered; never ask twice. */
const isFolderOfferDismissed = (sessionId: string, folderId: string): boolean =>
  dismissedFolderOffers.has(`${sessionId}:${folderId}`);

const rememberFolderOfferDismissed = (sessionId: string, folderId: string): void => {
  dismissedFolderOffers.add(`${sessionId}:${folderId}`);
};

/**
 * Offer the group's agent to a session that just joined the folder. The
 * switch runs on the session's own directory so the request reaches the
 * OpenCode instance that owns it.
 */
export const offerFolderAgentToSession = (
  sessionId: string,
  folderId: string,
  agent: string,
  t: Translator,
): void => {
  if (isFolderOfferDismissed(sessionId, folderId)) return;
  toast.message(t('sessions.sidebar.groupPreset.offerSwitch', { folderId }), {
    description: t('sessions.sidebar.groupPreset.offerSwitchDescription', { agent }),
    action: {
      label: t('sessions.sidebar.groupPreset.offerSwitchAction'),
      onClick: () => {
        void opencodeClient.switchSessionAgent(sessionId, agent).catch((error) => {
          console.error('[session-group-presets] switch agent failed', error);
          toast.error(t('sessions.sidebar.groupPreset.switchFailed'));
        });
      },
    },
    onDismiss: () => rememberFolderOfferDismissed(sessionId, folderId),
    onAutoClose: () => rememberFolderOfferDismissed(sessionId, folderId),
  });
};