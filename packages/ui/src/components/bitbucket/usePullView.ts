import React from 'react';

import { fetchBitbucketPullView, type BitbucketPullView, type ViewErrorKind } from '@/lib/bitbucket/pull-view-api';

export type PullViewState =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'error'; kind: ViewErrorKind }
    | { state: 'ready'; view: BitbucketPullView };

/**
 * One pull request, read on demand. `url` is the pull's address — any shape
 * the board's chip could carry — or null while nothing is selected. `nonce`
 * is the caller's "read again" pulse: the read restarts when either changes,
 * and a superseded answer is dropped, so rapid selections and retries never
 * render one pull under another's header.
 */
export const usePullView = (url: string | null, nonce = 0): PullViewState => {
    const [state, setState] = React.useState<PullViewState>({ state: 'idle' });

    React.useEffect(() => {
        if (!url) {
            setState({ state: 'idle' });
            return;
        }
        let cancelled = false;
        setState({ state: 'loading' });
        void fetchBitbucketPullView(url).then((result) => {
            if (cancelled) return;
            setState(result.ok ? { state: 'ready', view: result.view } : { state: 'error', kind: result.kind });
        });
        return () => {
            cancelled = true;
        };
    }, [url, nonce]);

    return state;
};
