/**
 * The composer's stage-to-backlog action, next to send.
 *
 * Pressing it parks the draft as one staged prompt of the session's backlog —
 * the queue the strip above the composer shows, run only when the user says
 * so. The text leaves verbatim: what the strip lists is exactly what the
 * drain will one day send, so the button is disabled while the draft is
 * empty.
 *
 * The pointer guards keep a tap from dismissing the mobile keyboard (same
 * guard as PermissionAutoAcceptButton).
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type BacklogStageButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    disabled: boolean;
    onStage: () => void;
};

export const BacklogStageButton = React.memo(function BacklogStageButton({ footerIconButtonClass, iconSizeClass, disabled, onStage }: BacklogStageButtonProps) {
    const { t } = useI18n();

    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onStage}
            className={cn(footerIconButtonClass, 'rounded-md hover:bg-transparent', disabled && 'opacity-30')}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-label={t('chat.backlog.actions.stage')}
            title={t('chat.backlog.actions.stage')}
        >
            <Icon name="list-check-2" className={cn(iconSizeClass)} />
        </button>
    );
});
