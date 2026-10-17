import React from 'react';

// The fork renders the workspace from the layout tree, not zones: no zone
// frame ever goes inert, so the value stays true and nothing toggles it.
// The hook stays because the terminal still reads it.
const ZoneInteractiveContext = React.createContext(true);

export const useZoneInteractive = (): boolean => React.useContext(ZoneInteractiveContext);
