/**
 * The team's board: the pull requests this fork reviews in Bitbucket Data
 * Center and the issues it tracks in Jira — one board, two tabs, each a
 * whole surface in place. The board hosts the same panels the context
 * rail shows, so both entrances draw one source of truth, and a row opens
 * its own read where it is listed. Unconfigured connections word
 * themselves in place through the panels' own failure kinds.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { BitbucketPullsPanel } from '@/components/bitbucket/BitbucketPullsPanel';
import { JiraIssuesPanel } from '@/components/jira/JiraIssuesPanel';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSourceBoardChoice, useSourceBoardStore, type SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';

type SourceBoardLayout = 'desktop' | 'mobile';

const SourceBoard: React.FC<{ layout: SourceBoardLayout; revalidate?: boolean; onClose?: () => void }> = ({ layout, revalidate, onClose }) => {
    const { t } = useI18n();
    const choice = useSourceBoardChoice();
    const update = useSourceBoardStore((state) => state.update);
    const tab: SourceBoardTab = choice.tab;
    const desktopBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
    const onScreen = layout === 'mobile' || (revalidate ?? desktopBoardOpen);

    // The lists are reads, not caches: a newer read when the board comes
    // back on screen — the pane page and the workspace region pass their
    // own live signal, the fullscreen page rides the store's open state.
    const [reloadKey, setReloadKey] = React.useState(0);
    const wasOnScreenRef = React.useRef(true);
    React.useEffect(() => {
        if (onScreen && !wasOnScreenRef.current) setReloadKey((key) => key + 1);
        wasOnScreenRef.current = onScreen;
    }, [onScreen]);

    const tabs = (
        <SortableTabsStrip
            items={[
                { id: 'pulls', label: t('sourceBoard.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
                { id: 'issues', label: t('sourceBoard.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
            ]}
            activeId={tab}
            onSelect={(id) => {
                if (id === 'pulls' || id === 'issues') update({ tab: id });
            }}
            variant="active-pill"
            layoutMode={layout === 'mobile' ? 'fit' : 'scrollable'}
            intrinsicWidth={layout !== 'mobile'}
        />
    );

    // Keyed by the reload ask: each host reads through its own panel, and
    // an appearing board remounts nothing — the panel keeps what it read.
    const content = tab === 'pulls'
        ? <BitbucketPullsPanel reloadKey={reloadKey} />
        : <JiraIssuesPanel showMine reloadKey={reloadKey} />;

    if (layout === 'mobile') {
        return (
            <>
                <MobileBoardHeader onClose={onClose}>{tabs}</MobileBoardHeader>
                {/* A crash below keeps the header, the only way to close the page on iOS. */}
                <ErrorBoundary>
                    <div className="min-h-0 flex-1 px-4 py-3">{content}</div>
                </ErrorBoundary>
            </>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-2.5">
                {tabs}
            </div>
            <ErrorBoundary>
                <div className="min-h-0 flex-1 px-4 py-3">{content}</div>
            </ErrorBoundary>
        </div>
    );
};

/**
 * Once opened, the board stays mounted and is only hidden while closed, so it
 * reopens exactly where it was left: the tab, the read, the search where it
 * was, a row half scrolled to.
 */
export const SourceBoardView: React.FC = () => {
    const open = useUIStore((state) => state.isSourceBoardOpen);
    const [opened, setOpened] = React.useState(open);
    if (open && !opened) setOpened(true);
    if (!opened) return null;
    return (
        <div
            className={cn('absolute inset-0 z-10 flex flex-col bg-background', !open && 'invisible')}
            inert={!open || undefined}
        >
            {/* Inside the overlay, so a crash shows its fallback in the board's
                place, with its own way to try again. */}
            <ErrorBoundary><SourceBoard layout="desktop" /></ErrorBoundary>
        </div>
    );
};

/**
 * The board as a context-surface pane: the same board the page shows, mounted
 * by ContextSurfacePanes into the leaf that holds its tab. There is no page
 * gate of its own — the region shows the tab or the pane stays hidden — and
 * its data refreshes only while the region shows it.
 */
export const SourceBoardPane: React.FC<{ visible: boolean }> = ({ visible }) => (
    <div className="flex h-full min-h-0 flex-col bg-background">
        <ErrorBoundary><SourceBoard layout="desktop" revalidate={visible} /></ErrorBoundary>
    </div>
);

/**
 * The board as the phone shell's page: one column, the tabs and the close
 * button sharing the header's row.
 */
export const MobileSourceBoard: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <div className="flex h-full min-h-0 flex-col">
        <SourceBoard layout="mobile" onClose={onClose} />
    </div>
);

/** The phone page's header: close, then what the page is on. */
const MobileBoardHeader: React.FC<{ onClose?: () => void; children?: React.ReactNode }> = ({ onClose, children }) => {
    const { t } = useI18n();
    return (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/70 px-3">
            {onClose ? (
                <button
                    type="button"
                    className="-ms-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('mobile.surface.closeAria')}
                    onClick={onClose}
                    style={{ touchAction: 'manipulation' }}
                >
                    <Icon name="close" className="size-5" />
                </button>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center">{children}</div>
        </header>
    );
};
