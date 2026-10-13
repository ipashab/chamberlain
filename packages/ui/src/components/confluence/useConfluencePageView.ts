import React from 'react';

import { fetchConfluencePageView, type ConfluencePageView, type PageErrorKind } from '@/lib/confluence/page-api';

export type PageViewState =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'error'; kind: PageErrorKind }
    | { state: 'ready'; view: ConfluencePageView };

/**
 * One page, read on demand. `id` is the page's own numeric id, or null
 * while nothing is selected. `nonce` is the caller's "read again" pulse:
 * the read restarts when either changes, and a superseded answer is
 * dropped, so rapid selections and retries never render one page under
 * another's header.
 */
export const useConfluencePageView = (id: string | null, nonce = 0): PageViewState => {
    const [state, setState] = React.useState<PageViewState>({ state: 'idle' });

    React.useEffect(() => {
        if (!id) {
            setState({ state: 'idle' });
            return;
        }
        let cancelled = false;
        setState({ state: 'loading' });
        void fetchConfluencePageView(id).then((result) => {
            if (cancelled) return;
            setState(result.ok ? { state: 'ready', view: result.view } : { state: 'error', kind: result.kind });
        });
        return () => {
            cancelled = true;
        };
    }, [id, nonce]);

    return state;
};
