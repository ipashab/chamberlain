import React from 'react';
import { toast } from 'sonner';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { fetchJiraIssueView } from '@/lib/jira/issue-view-api';
import { findJiraIssueMentions } from '@/lib/jira/issueRef';
import { attachIssueAsk } from './issueAsk';

/**
 * The composer's own eye for Jira keys: when the words a message carries
 * name a standalone issue key, one chip offers to carry the issue itself —
 * pinned to the next message through the same door every ask uses. The
 * offer never attaches by itself: a click is explicit user intent, and a
 * spelling a person can read as a model name is a person's call, not a
 * fetch's. The words stay words in the draft either way; attach adds
 * context, it does not rewrite the message.
 *
 * Not on VS Code, whose sessions live on their own OpenCode; everywhere
 * else the chip rides the composer's attachment row, mobile pill
 * included.
 */
export const JiraIssueMentionHint: React.FC<{ message: string }> = ({ message }) => {
    const { t } = useI18n();
    // The offer is for the first key the text names. Once a key is
    // attached there is nothing left to offer for it, however long its
    // words stay in the draft.
    const keys = React.useMemo(() => findJiraIssueMentions(message), [message]);
    const [attached, setAttached] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    // A reader can wave one offer away; the next key the text names, or
    // the same one after the words changed to name it again, is a fresh
    // offer — dismissal answers what was seen, not the key forever.
    const [dismissed, setDismissed] = React.useState<string[]>([]);

    const key = keys.find((candidate) => candidate !== attached && !dismissed.includes(candidate)) ?? null;

    const attach = React.useCallback((issueKey: string) => {
        if (busy) return;
        setBusy(true);
        void fetchJiraIssueView(issueKey).then((result) => {
            setBusy(false);
            if (!result.ok) {
                toast.error(t(`jiraView.error.${result.kind}`));
                return;
            }
            const ask = attachIssueAsk(result.view);
            if (ask.ok) {
                setAttached(issueKey);
                toast.message(t('jiraView.askAttached'));
            } else {
                toast.error(ask.reason === 'no-session' ? t('jiraView.askNoSession') : t('jiraView.askFailed'));
            }
        });
    }, [busy, t]);

    if (isVSCodeRuntime()) return null;
    if (key === null) return null;

    return (
        <span className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2 text-xs transition-opacity hover:opacity-80">
            <Icon name="task" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <button
                type="button"
                disabled={busy}
                className="min-w-0 truncate text-foreground disabled:opacity-50"
                onClick={() => attach(key)}
            >
                {t('jiraMention.attach', { key })}
            </button>
            <button
                type="button"
                aria-label={t('jiraMention.dismiss')}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:opacity-80"
                onClick={() => setDismissed((current) => [...current, key])}
            >
                <Icon name="close" className="h-3 w-3" />
            </button>
        </span>
    );
};
