import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import type { TeamTask } from '@/lib/team/team-board-api';
import type { ViewErrorKind } from '@/lib/bitbucket/pull-view-api';
import { usePullView } from '@/components/bitbucket/usePullView';
import { BitbucketPullBody } from '@/components/bitbucket/BitbucketPullBody';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A Bitbucket pull of a board task: the URL names the pull to read. */
  pull: Extract<NonNullable<TeamTask['pull']>, { provider: 'bitbucket' }>;
};

/**
 * One Bitbucket pull request, read whole and shown whole — the read-only
 * viewer behind "View" on the task details dialog. The reading and the
 * rendering are shared with the context panel's dedicated surface
 * (`components/bitbucket`); this shell only puts them in a dialog: one read
 * per open, the dialog's own error and loading words, and the same body.
 */
export const BitbucketPullDialog: React.FC<Props> = ({ open, onOpenChange, pull }) => {
  const { t } = useI18n();
  const [readToken, setReadToken] = React.useState(0);

  // One read per open: the view is a snapshot of the read, not a live
  // document — the instance's own page is the source of record, and the
  // retry button is the explicit refresh.
  React.useEffect(() => {
    if (open) setReadToken((token) => token + 1);
  }, [open]);

  const view = usePullView(open ? pull.url : null, readToken);
  const viewKey = `${pull.url}#${readToken}`;
  const fresh = open && view.state === 'ready' ? view.view : null;

  const errorWords = (kind: ViewErrorKind): string => t(`chat.workStatus.teamBoard.pullView.error.${kind}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="git-pull-request" className="size-4 shrink-0" />
            PR #{pull.number}
          </DialogTitle>
          <DialogDescription>{t('chat.workStatus.teamBoard.pullView.title')}</DialogDescription>
        </DialogHeader>

        {view.state === 'loading' || view.state === 'idle' ? (
          <p className="text-[13px] text-muted-foreground">{t('chat.workStatus.teamBoard.pullView.loading')}</p>
        ) : null}

        {view.state === 'error' ? (
          <>
            <p role="alert" className="text-[13px]" style={{ color: 'var(--status-error)' }}>
              {errorWords(view.kind)}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => setReadToken((token) => token + 1)}>
                {t('chat.workStatus.teamBoard.pullView.retry')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void openExternalUrl(pull.url)}
              >
                {t('chat.workStatus.teamBoard.taskDetails.openPull')}
              </Button>
            </div>
          </>
        ) : null}

        {fresh ? <BitbucketPullBody key={viewKey} view={fresh} /> : null}
      </DialogContent>
    </Dialog>
  );
};
