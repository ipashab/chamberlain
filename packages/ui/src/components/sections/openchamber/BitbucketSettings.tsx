import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';

/**
 * The Bitbucket Data Center connection card: one instance, one personal
 * access token, one TLS policy. The card is the connection's only writer —
 * the board's PR chips read the same server state this card edits. A save
 * that saves a full connection is followed by a server-side check, so a
 * rejected token or an unreachable instance says so here, at the moment
 * it is pasted, not later as unknown chips on a board.
 */

const bitbucketConnectionSchema = z.object({
  configured: z.boolean(),
  origin: z.string().nullish(),
  hasToken: z.boolean().nullish(),
  verifySsl: z.boolean().nullish(),
  // 'ok' after a passing check; the failure kinds the server's client
  // classifies ('unauthorized', 'unreachable', …), or null when the last
  // save carried no full connection to check.
  connectionCheck: z.string().nullish(),
});

type BitbucketConnection = z.infer<typeof bitbucketConnectionSchema>;

const readConnection = async (): Promise<BitbucketConnection | null> => {
  try {
    const response = await runtimeFetch('/api/openchamber/bitbucket');
    if (!response.ok) return null;
    const parsed = bitbucketConnectionSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** One save's own shape: the fields the card itself chooses to send. */
type SaveBody = {
  origin?: string;
  token?: string;
  verifySsl: boolean;
};

const saveConnection = async (body: SaveBody): Promise<BitbucketConnection | 'failed'> => {
  try {
    const response = await runtimeFetch('/api/openchamber/bitbucket', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) return 'failed';
    const parsed = bitbucketConnectionSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : 'failed';
  } catch {
    return 'failed';
  }
};

/**
 * The check kinds the card can word. A passing check says nothing; an
 * answer the words do not know stays quiet too rather than guessing a
 * cause the server did not report.
 */
const checkMessageKeyOf = (check: string | null | undefined): string | null => {
  if (check === 'unauthorized') return 'tokenRejected';
  if (check === 'unreachable') return 'unreachable';
  return null;
};

export const BitbucketSettings: React.FC = () => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [connection, setConnection] = React.useState<BitbucketConnection | null>(null);
  const [originDraft, setOriginDraft] = React.useState('');
  const [tokenDraft, setTokenDraft] = React.useState('');
  // The TLS policy rides on every save; standalone while the form is open,
  // persisted with the connection the moment one exists.
  const [verifySsl, setVerifySsl] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [checkMessageKey, setCheckMessageKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void readConnection().then((state) => {
      if (cancelled || !state) return;
      setConnection(state);
      setVerifySsl(state.verifySsl !== false);
    });
    return () => { cancelled = true; };
  }, []);

  const connect = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    setFormError(null);
    setCheckMessageKey(null);
    const body: SaveBody = { verifySsl };
    const origin = originDraft.trim();
    if (origin) body.origin = origin;
    const token = tokenDraft.trim();
    if (token) body.token = token;
    const outcome = await saveConnection(body);
    if (outcome === 'failed') {
      reportSettingsSaveState('error');
      setFormError(t('settings.bitbucket.status.saveFailed'));
    } else {
      reportSettingsSaveState('saved');
      setConnection(outcome);
      setCheckMessageKey(checkMessageKeyOf(outcome.connectionCheck));
      if (outcome.configured) {
        setOriginDraft('');
        setTokenDraft('');
      }
    }
    setBusy(false);
  }, [busy, originDraft, tokenDraft, verifySsl, t]);

  const toggleVerifySsl = React.useCallback(async (checked: boolean) => {
    if (busy) return;
    setVerifySsl(checked);
    if (!connection?.configured) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    const outcome = await saveConnection({ verifySsl: checked });
    if (outcome === 'failed') {
      reportSettingsSaveState('error');
      setVerifySsl(!checked);
    } else {
      reportSettingsSaveState('saved');
      setConnection(outcome);
    }
    setBusy(false);
  }, [busy, connection]);

  const disconnect = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    reportSettingsSaveState('saving');
    try {
      const response = await runtimeFetch('/api/openchamber/bitbucket', { method: 'DELETE' });
      if (!response.ok) {
        reportSettingsSaveState('error');
      } else {
        reportSettingsSaveState('saved');
        setConnection({ configured: false, origin: null, hasToken: false, verifySsl: true, connectionCheck: null });
        setVerifySsl(true);
        setFormError(null);
        setCheckMessageKey(null);
      }
    } catch {
      reportSettingsSaveState('error');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const configured = connection?.configured === true;
  const statusLabel = connection === null
    ? t('common.loading')
    : configured
      ? t('settings.bitbucket.status.connected')
      : t('settings.bitbucket.status.notConnected');
  const statusClassName = configured
    ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
    : 'bg-[var(--surface-muted)] text-muted-foreground';
  const checkMessage = checkMessageKey
    ? checkMessageKey === 'tokenRejected'
      ? t('settings.bitbucket.status.tokenRejected')
      : t('settings.bitbucket.status.unreachable')
    : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-settings-item="integrations.bitbucket-account"
        className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]"
      >
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name="git-pull-request" className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {t('settings.bitbucket.title')}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t('settings.bitbucket.info')}
            </p>
          </div>
          <span
            aria-live="polite"
            className={cn('max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', statusClassName)}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
          <SettingsControlGroup
            title={t('settings.bitbucket.connection.title')}
            contentClassName="space-y-3"
            settingsItem="integrations.bitbucket-connect"
          >
            {configured ? (
              <SettingsFieldRow
                label={t('settings.bitbucket.instance.label')}
                info={t('settings.bitbucket.instance.info')}
              >
                <span className="truncate text-[13px] text-muted-foreground" title={connection?.origin ?? undefined}>
                  {connection?.origin}
                </span>
              </SettingsFieldRow>
            ) : (
              <SettingsFieldRow
                label={t('settings.bitbucket.instance.label')}
                info={t('settings.bitbucket.instance.info')}
                description={formError ?? undefined}
              >
                <Input
                  className="h-8 w-full min-w-0 rounded-md"
                  value={originDraft}
                  onChange={(event) => setOriginDraft(event.target.value)}
                  placeholder="https://bitbucket.example.com"
                  aria-label={t('settings.bitbucket.instance.label')}
                />
              </SettingsFieldRow>
            )}
            <SettingsCheckboxRow
              checked={verifySsl}
              onChange={(checked) => void toggleVerifySsl(checked)}
              disabled={busy}
              label={t('settings.bitbucket.tls.label')}
              info={t('settings.bitbucket.tls.info')}
            />
            <SettingsFieldRow
              label={configured
                ? t('settings.bitbucket.token.replaceLabel')
                : t('settings.bitbucket.token.label')}
              info={t('settings.bitbucket.token.info')}
              description={formError ?? checkMessage ?? undefined}
            >
              {configured ? (
                <div className={cn(SETTINGS_CONTROL_CLUSTER_CLASS, 'flex flex-col gap-2 @xl:flex-row @xl:items-center')}>
                  <Input
                    className="h-8 w-full min-w-0 rounded-md"
                    type="password"
                    value={tokenDraft}
                    onChange={(event) => setTokenDraft(event.target.value)}
                    placeholder={t('settings.bitbucket.token.replacePlaceholder')}
                    aria-label={t('settings.bitbucket.token.replaceLabel')}
                  />
                  <Button
                    className="w-full @xl:w-auto"
                    size="sm"
                    disabled={busy || !tokenDraft.trim()}
                    onClick={() => void connect()}
                  >
                    {t('settings.bitbucket.token.replace')}
                  </Button>
                </div>
              ) : (
                <Input
                  className="h-8 w-full min-w-0 rounded-md"
                  type="password"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder="BBDC-…"
                  aria-label={t('settings.bitbucket.token.label')}
                />
              )}
            </SettingsFieldRow>
            {configured ? (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  {t('settings.bitbucket.actions.disconnect')}
                </Button>
              </div>
            ) : (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={busy || !originDraft.trim() || !tokenDraft.trim()}
                  onClick={() => void connect()}
                >
                  {t('settings.bitbucket.actions.connect')}
                </Button>
              </div>
            )}
          </SettingsControlGroup>
          {formError && !configured ? (
            <p role="alert" className="mt-3 text-[13px]" style={{ color: 'var(--status-error)' }}>
              {formError}
            </p>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
