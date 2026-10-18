// The debugger's state projection, shared by every surface that shows it.
// The debug panel owns its own fetch for the same reason; this hook exists so
// the file editor's gutter can mark breakpoints and the stopped line without
// owning a second contract. Both ride the same `debugger-changed` broadcast.

import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { type DebuggerState, debuggerApi } from '@/lib/debugger/debugger-api';

export const useDebuggerLiveState = (): DebuggerState | null => {
  const [state, setState] = React.useState<DebuggerState | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      debuggerApi.state().then((next) => {
        if (!cancelled) setState(next);
      }).catch(() => {
        // A dead server leaves the last projection on screen; the debug panel
        // owns the visible error.
      });
    };
    refresh();
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'debugger-changed') refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
};
