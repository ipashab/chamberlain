import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

declare global {
  interface Window {
    __OPENCHAMBER_SAFE_START__?: boolean;
  }
}

export const isDesktopSafeStart = (): boolean => globalThis.window?.__OPENCHAMBER_SAFE_START__ === true;

export const forgetLayoutForSafeStart = (): void => {
  useFilesViewTabsStore.setState({ byRoot: {}, runtimeSnapshots: {} });

  const ui = useUIStore.getState();
  for (const directory of Object.keys(ui.contextPanelByDirectory)) {
    ui.closeContextPanel(directory);
  }
};
