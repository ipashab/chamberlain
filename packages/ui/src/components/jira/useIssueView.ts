import React from 'react';

import { fetchJiraIssueView, type JiraIssueView, type ViewErrorKind } from '@/lib/jira/issue-view-api';

type IssueViewState =
    | { state: 'idle' }
    | { state: 'loading' }
    | { state: 'error'; kind: ViewErrorKind }
    | { state: 'ready'; view: JiraIssueView };

/**
 * One issue, read on demand. `ref` is the issue's address — a browse URL
 * or a bare key — or null while nothing is selected. `nonce` is the
 * caller's "read again" pulse: the read restarts when either changes, and
 * a superseded answer is dropped, so rapid selections and retries never
 * render one issue under another's header.
 */
export const useIssueView = (ref: string | null, nonce = 0): IssueViewState => {
    const [state, setState] = React.useState<IssueViewState>({ state: 'idle' });

    React.useEffect(() => {
        if (!ref) {
            setState({ state: 'idle' });
            return;
        }
        let cancelled = false;
        setState({ state: 'loading' });
        void fetchJiraIssueView(ref).then((result) => {
            if (cancelled) return;
            setState(result.ok ? { state: 'ready', view: result.view } : { state: 'error', kind: result.kind });
        });
        return () => {
            cancelled = true;
        };
    }, [ref, nonce]);

    return state;
};
