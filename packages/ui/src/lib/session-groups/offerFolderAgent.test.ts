import { beforeEach, describe, expect, mock, test } from 'bun:test';

// What the captured toast offers, exactly as offerFolderAgent builds it.
interface RecordedOffer {
  message: string;
  description: string;
  action: { label: string; onClick: () => void };
  onDismiss: () => void;
  onAutoClose: () => void;
}

const offers: Array<RecordedOffer> = [];
const errorMessages: Array<string> = [];
const switchCalls: Array<{ sessionId: string; agent: string }> = [];
let switchFails = false;

mock.module('@/components/ui', () => ({
  toast: {
    message: (message: string, data: Omit<RecordedOffer, 'message'>) => {
      offers.push({ message, ...data });
      return 'toast-offer';
    },
    error: (message: string) => {
      errorMessages.push(message);
      return 'toast-error';
    },
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    switchSessionAgent: async (sessionId: string, agent: string) => {
      switchCalls.push({ sessionId, agent });
      if (switchFails) throw new Error('agent switch rejected');
    },
  },
}));

const { offerFolderAgentToSession } = await import('./offerFolderAgent');

const translate = (key: string) => key;

describe('offerFolderAgent', () => {
  beforeEach(() => {
    offers.length = 0;
    errorMessages.length = 0;
    switchCalls.length = 0;
    switchFails = false;
  });

  test('a dismissed offer never asks the same folder-session pair again', () => {
    offerFolderAgentToSession('ses-a', 'folder-a', 'writer', translate);
    expect(offers.length).toBe(1);

    // Answering by closing the toast dismisses the pair.
    offers[0]?.onDismiss();
    offerFolderAgentToSession('ses-a', 'folder-a', 'writer', translate);
    expect(offers.length).toBe(1);

    // Another session in the same folder still gets its own offer.
    offerFolderAgentToSession('ses-b', 'folder-a', 'writer', translate);
    expect(offers.length).toBe(2);
  });

  test('the toast action switches the session onto the group agent', async () => {
    offerFolderAgentToSession('ses-2', 'folder-2', 'writer', translate);
    const offer = offers[0];
    expect(offer).toBeDefined();
    expect(offer?.action.label).toBeTruthy();
    offer?.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchCalls).toEqual([{ sessionId: 'ses-2', agent: 'writer' }]);
    // The switch succeeded: no error toast.
    expect(errorMessages.length).toBe(0);
  });

  test('a failed switch reports an error and does not throw', async () => {
    switchFails = true;
    offerFolderAgentToSession('ses-3', 'folder-3', 'writer', translate);
    offers[0]?.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(switchCalls.length).toBe(1);
    expect(errorMessages.length).toBe(1);
  });
});
