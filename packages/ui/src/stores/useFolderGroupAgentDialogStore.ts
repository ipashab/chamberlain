// Folder "group agent" dialog target. The sidebar virtualizes and re-mounts
// folder rows, so the open dialog cannot live in a row's own state: the
// row survives, the dialog state rides in this store until it closes.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface FolderGroupAgentDialogTarget {
  folderId: string;
  folderName: string;
}

interface FolderGroupAgentDialogState {
  target: FolderGroupAgentDialogTarget | null;
  openFolderGroupAgentDialog: (target: FolderGroupAgentDialogTarget) => void;
  closeFolderGroupAgentDialog: () => void;
}

export const useFolderGroupAgentDialogStore = create<FolderGroupAgentDialogState>()(
  devtools((set) => ({
    target: null,
    openFolderGroupAgentDialog: (target) => set({ target }),
    closeFolderGroupAgentDialog: () => set({ target: null }),
  })),
);
