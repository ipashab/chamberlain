import React from 'react';

// The fork renders the workspace from the layout tree, not zones: no region
// frame ever goes inert, so the value stays true and nothing toggles it. The
// file editor still renders DetachableEditorMarker beside its editor — the
// seam upstream's inert-frame logic reads stays in place.
const ZoneInteractiveContext = React.createContext(true);

export const useZoneInteractive = (): boolean => React.useContext(ZoneInteractiveContext);

export const DetachableEditorMarker: React.FC = () => null;
