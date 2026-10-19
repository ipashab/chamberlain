import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useKeybinds } from '@/hooks/useKeybind';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DEFAULT_WORKSPACE_MODE,
  WORKSPACE_MODES,
  type WorkspaceMode,
} from '@/lib/workspace/modePresets';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

// The workspace modes' global tabs: named in full, sitting on the header's
// baseline with an accent underline on the active one — the same tab cue the
// editor strip uses. The header row defines the height; the tabs ride it.

const MODE_ICON = {
  chat: 'chat-4',
  debug: 'bug',
  board: 'clipboard',
} as const satisfies Record<WorkspaceMode, IconName>;

export const WorkspaceModeSwitcher: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = React.useMemo(
    () => (effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : ''),
    [effectiveDirectory],
  );
  const workspaceMode = useUIStore((state) => (directoryKey
    ? state.contextPanelByDirectory[directoryKey]?.workspaceMode ?? DEFAULT_WORKSPACE_MODE
    : DEFAULT_WORKSPACE_MODE));
  const switchWorkspaceMode = useUIStore((state) => state.switchWorkspaceMode);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const switchTo = React.useCallback((mode: WorkspaceMode) => {
    if (directoryKey) switchWorkspaceMode(directoryKey, mode);
  }, [directoryKey, switchWorkspaceMode]);

  useKeybinds({
    switch_workspace_chat: () => switchTo('chat'),
    switch_workspace_debug: () => switchTo('debug'),
    switch_workspace_board: () => switchTo('board'),
  });

  if (isVSCode) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={t('workspaceMode.segmentAria')}
      className="app-region-no-drag flex items-stretch"
    >
      {WORKSPACE_MODES.map((mode) => {
        const active = workspaceMode === mode;
        return (
          <Tooltip key={mode}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-pressed={active}
                aria-label={t(`workspaceMode.segment.${mode}`)}
                onClick={() => switchTo(mode)}
                className={cn(
                  'inline-flex items-center gap-1.5 border-b-2 border-transparent px-2.5',
                  'typography-ui-label font-medium transition-colors',
                  active
                    ? 'border-primary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon name={MODE_ICON[mode]} className="h-3.5 w-3.5" />
                <span>{t(`workspaceMode.segment.${mode}`)}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="flex flex-col gap-0.5">
                <span className="typography-ui-header">{t(`workspaceMode.segment.${mode}`)}</span>
                <span className="typography-micro text-muted-foreground">{t(`workspaceMode.tooltip.${mode}`)}</span>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
};
