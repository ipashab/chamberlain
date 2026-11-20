import React from 'react';

import type { ContextPanelMode } from '@/stores/useUIStore';

// The fork renders the workspace from the layout tree, not zones: no region
// frame ever goes inert, so the value stays true and nothing toggles it.
// The exports upstream added in v2.7.3 stay: the file editor renders
// DetachableEditorMarker beside its editor, and callers can still ask
// whether a frame is exposed.
export const ZoneInteractiveContext = React.createContext(true);

export const useZoneInteractive = (): boolean => React.useContext(ZoneInteractiveContext);

let detachableEditors = 0;

export const DetachableEditorMarker: React.FC = () => {
  React.useLayoutEffect(() => {
    detachableEditors += 1;
    return () => {
      detachableEditors -= 1;
    };
  }, []);
  return null;
};

const leavesInertOnOpen = (mode: ContextPanelMode | undefined): boolean => mode === 'file' && detachableEditors > 0;

export const isZoneExposed = (isOpen: boolean, settledOpen: boolean, mode: ContextPanelMode | undefined): boolean => (
  settledOpen || (isOpen && leavesInertOnOpen(mode))
);
