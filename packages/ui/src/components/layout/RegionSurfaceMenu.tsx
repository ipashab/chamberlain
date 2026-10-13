import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { useUIStore } from '@/stores/useUIStore';
import { getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { useI18n } from '@/lib/i18n';

type Args = { leafId: string; directoryKey: string | null };

/**
 * The picker for an empty region: the same surface list the rail composes,
 * but the choice lands in this region's leaf instead of wherever the open
 * placement rules would put it. Without it the split hint promises an open
 * the placement rules rarely grant — with a filled region elsewhere, every
 * fresh surface lands there as a tab and the empty region stays empty until
 * the user closes the other one.
 */
export const RegionSurfaceMenu: React.FC<Args> = ({ leafId, directoryKey }) => {
  const { t } = useI18n();
  const openContextSurfaceInLeaf = useUIStore((state) => state.openContextSurfaceInLeaf);

  // The rail's own composition, so the menu never offers a surface the rail
  // keeps hidden (disconnected source control, VS Code, content-driven modes
  // with no content yet).
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

  if (surfaces.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Icon name="add" className="me-2 size-4" />
          {t('contextPanel.region.openHere')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {surfaces.map((surface) => (
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
