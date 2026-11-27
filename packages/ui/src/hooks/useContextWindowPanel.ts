import React from 'react';
import { startContextWindowPanel } from '@/lib/contextWindow/panel';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';

export const useContextWindowPanel = (): void => {
  React.useLayoutEffect(() => startContextWindowPanel(), []);
  useGuestSurfaces();
};
