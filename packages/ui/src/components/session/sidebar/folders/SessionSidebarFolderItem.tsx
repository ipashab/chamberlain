import React from 'react';
import { SessionFolderItem } from '../../SessionFolderItem';
import { FolderGroupAgentDialog } from '../../folders/FolderGroupAgentDialog';
import { useSessionGroupPresetsStore } from '@/stores/useSessionGroupPresetsStore';
import { useFolderGroupAgentDialogStore } from '@/stores/useFolderGroupAgentDialogStore';
import type { SessionNode } from '../types';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';

type Props = React.ComponentProps<typeof SessionFolderItem<SessionNode>> & {
  activityNodes: readonly SessionNode[];
};

/** Keep activity subscriptions on the mounted folder row, not the entire list. */
export function SessionSidebarFolderItem({ activityNodes, folder, displayName, ...props }: Props): React.ReactNode {
  const collapsedActivityState = useCollapsedSessionActivityState({
    nodes: activityNodes,
    enabled: props.isCollapsed && !props.archivedBucket,
  });
  // A preset with no agent does not mark the row: `getFolderPreset` hides it,
  // so the button marker checks the agent directly.
  const hasGroupAgent = useSessionGroupPresetsStore(
    (state) => Boolean(state.presets[folder.id]?.defaultAgent),
  );
  const dialogTarget = useFolderGroupAgentDialogStore((state) => state.target);
  const isDialogOpen = dialogTarget?.folderId === folder.id;
  // The row model names a folder with `displayName` when it differs from the
  // folder's own name (a branch label); otherwise it is simply the name.
  const folderDialogName = displayName ?? folder.name;

  return <>
    <SessionFolderItem
      {...props}
      folder={folder}
      displayName={displayName}
      collapsedActivityState={collapsedActivityState}
      onGroupAgent={() => {
        useFolderGroupAgentDialogStore.getState()
          .openFolderGroupAgentDialog({ folderId: folder.id, folderName: folderDialogName });
      }}
      hasGroupAgent={hasGroupAgent}
    />
    <FolderGroupAgentDialog
      open={isDialogOpen}
      onOpenChange={(open) => { if (!open) useFolderGroupAgentDialogStore.getState().closeFolderGroupAgentDialog(); }}
      folderId={isDialogOpen ? dialogTarget.folderId : folder.id}
      folderName={isDialogOpen ? dialogTarget.folderName : folderDialogName}
    />
  </>;
}
