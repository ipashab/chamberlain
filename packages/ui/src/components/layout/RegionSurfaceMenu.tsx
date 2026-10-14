import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { CONTEXT_SURFACES, getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@/lib/opencode/model';
import { pickRegionPickerSessionsForDirectory } from './regionPickerSessions';

type Args = { leafId: string; directoryKey: string | null };

/**
 * The picker for an empty region: the same surface list the rail composes,
 * but the choice lands in this region's leaf instead of wherever the open
 * placement rules would put it. Without it the split hint promises an open
 * the placement rules rarely grant — with a filled region elsewhere, every
 * fresh surface lands there as a tab and the empty region stays empty until
 * the user closes the other one.
 *
 * Chat is the one entry the rail gates behind an already-open chat tab,
 * because it is content-driven: picking a session IS that content, so here
 * Chat leads the list whenever the directory holds sessions to pick.
 */
export const RegionSurfaceMenu: React.FC<Args> = ({ leafId, directoryKey }) => {
  const { t } = useI18n();
  const openContextSurfaceInLeaf = useUIStore((state) => state.openContextSurfaceInLeaf);
  const openContextPanelTabToLeaf = useUIStore((state) => state.openContextPanelTabToLeaf);

  // The rail's own composition, so the menu never offers a surface the rail
  // keeps hidden (disconnected source control, VS Code, content-driven modes
  // with no content yet) — except Chat, whose picker carries its own content.
  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextRailOrder = useUIStore((state) => state.contextRailOrder);
  const contextRailHiddenSurfaces = useUIStore((state) => state.contextRailHiddenSurfaces);
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const sourceControlConnected = useSourceControlAuthStore((state) => Object.values(state.entries)
    .some((entry) => entry.status?.status === 'connected'));
  const guestSurfaces = useGuestSurfaces();
  const { screenWidth } = useDeviceInfo();

  const surfaces = React.useMemo(() => getVisibleContextRailSurfaces({
    railOrder: contextRailOrder,
    hiddenSurfaces: contextRailHiddenSurfaces,
    planModeEnabled,
    isVSCode: isVSCodeRuntime(),
    screenWidth,
    tabs: panelState?.tabs ?? [],
    sourceControlConnected,
    extras: guestSurfaces,
  }), [contextRailHiddenSurfaces, contextRailOrder, guestSurfaces, planModeEnabled, screenWidth, sourceControlConnected, panelState?.tabs]);

  const chatSurface = React.useMemo(
    () => CONTEXT_SURFACES.find((surface) => surface.mode === 'chat') ?? null,
    [],
  );

  // The sessions a Chat pick offers: the same global list the sidebar tree
  // reads, scoped to this leaf's directory subtree — the directory pick owns
  // the cut, the shallow wrapper keeps the list's identity between renders.
  const recentSessions = useGlobalSessionsStore(
    useShallow(React.useCallback((state) => (
      pickRegionPickerSessionsForDirectory(state.sessionsByDirectory, directoryKey ?? '')
    ), [directoryKey])),
  );

  const untitledLabel = t('sessions.sidebar.session.untitled');
  const openSession = React.useCallback((session: Session) => {
    if (!directoryKey) return;
    const title = session.title || untitledLabel;
    openContextPanelTabToLeaf(directoryKey, {
      mode: 'chat',
      dedupeKey: `session:${session.id}`,
      label: title,
      sessionTitleFallback: title,
      targetDirectory: session.directory,
    }, leafId);
  }, [directoryKey, leafId, openContextPanelTabToLeaf, untitledLabel]);

  const panelSurfaces = surfaces.filter((surface) => surface.mode !== 'chat');
  // The Chat pick needs the Chat surface's icon and label to render at all.
  const chatEntries = chatSurface ? recentSessions : [];
  if (panelSurfaces.length === 0 && chatEntries.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Icon name="add" className="me-2 size-4" />
          {t('contextPanel.region.openHere')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {chatEntries.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon name={chatSurface?.icon ?? 'chat-4'} className="me-2 size-4" />
              {chatSurface ? t(chatSurface.labelKey) : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {chatEntries.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onSelect={() => openSession(session)}
                >
                  <span className="max-w-56 truncate">{session.title || untitledLabel}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {panelSurfaces.map((surface) => (
          <DropdownMenuItem
            key={surface.id}
            onSelect={() => {
              if (!directoryKey) return;
              openContextSurfaceInLeaf(directoryKey, surface.mode, leafId);
            }}
          >
            <Icon name={surface.icon} className="me-2 size-4" />
            {surface.label ?? t(surface.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
