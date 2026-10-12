import { describe, expect, test } from 'bun:test';

import { buildPullViewMaterial } from './pullViewMaterial';
import type { BitbucketPullView } from '@/lib/bitbucket/pull-view-api';
import { bitbucketPullViewSchema } from '@/lib/bitbucket/pull-view-api';

// The view arrives parsed by the boundary schema; the test builds it the
// same way, so a schema drift fails here before any dialog renders it.
const makeView = (over: {
    files?: BitbucketPullView['files'];
    comments?: BitbucketPullView['comments'];
    truncated?: BitbucketPullView['truncated'];
    description?: string;
    reviewers?: BitbucketPullView['pull']['reviewers'];
}): BitbucketPullView => bitbucketPullViewSchema.parse({
    pull: {
        number: 110,
        url: 'https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110',
        title: 'Remove the temporary exception',
        description: over.description ?? 'The flag has served its purpose.',
        state: 'merged',
        author: 'Sv Gorbunov',
        createdAt: 1789660000000,
        updatedAt: 1789669800000,
        fromBranch: 'fix',
        toBranch: 'master',
        reviewers: over.reviewers ?? [{ name: 'Pavel Ivanov', slug: 'pivanov', approved: true }],
        checks: { state: 'failure', total: 2 },
    },
    files: over.files ?? [{
        path: 'src/files.py',
        changeType: 'modify',
        truncated: false,
        diffText: 'diff --git a/src/files.py b/src/files.py\n@@ -1,1 +1,1 @@\n-old\n+new',
    }],
    comments: over.comments ?? [{
        id: 99001,
        author: 'AIR',
        text: '## Review run info',
        createdAt: 1789664696177,
        resolved: false,
        severity: null,
        replies: [{ author: 'Sv Gorbunov', text: 'Acknowledged.', createdAt: 1789664999000 }],
    }],
    commits: [],
    truncated: over.truncated ?? { diff: false, comments: false, commits: false },
});

describe('buildPullViewMaterial', () => {
    test('assembles the whole pull as markdown, meta first', () => {
        const material = buildPullViewMaterial(makeView({}));
        expect(material).toContain('Bitbucket pull request #110: Remove the temporary exception');
        expect(material).toContain('URL: https://bitbucket.example.com/projects/AUTO/repos/ai-reviewer/pull-requests/110');
        expect(material).toContain('State: merged · Author: Sv Gorbunov · fix → master · build statuses: failure (2)');
        expect(material).toContain('## Description\nThe flag has served its purpose.');
        expect(material).toContain('## Reviewers\n- Pavel Ivanov — approved');
        expect(material).toContain('## Changed files (1)\n- src/files.py — modified');
        expect(material).toContain('## Comments (1)');
        expect(material).toContain('> Sv Gorbunov');
        expect(material).toContain('## Diff\ndiff --git a/src/files.py b/src/files.py');
    });

    test('carries the instance-side truncation as an explicit note', () => {
        const material = buildPullViewMaterial(makeView({ truncated: { diff: true, comments: false, commits: false } }));
        expect(material).toContain('(Something was truncated: the diff on the Bitbucket side.)');
    });

    test('cuts oversized material with a note, never silently', () => {
        const noise = 'a'.repeat(60_000);
        const material = buildPullViewMaterial(makeView({
            files: [{
                path: 'big.txt',
                changeType: 'add',
                truncated: false,
                diffText: noise,
            }],
        }));
        expect(material.length).toBeLessThan(50_000);
        expect(material.endsWith('(The material was cut to fit the message; open the pull view again for the rest.)'))
            .toBe(true);
    });

    test('skips the sections a pull does not carry', () => {
        const material = buildPullViewMaterial(makeView({
            description: '',
            reviewers: [],
            files: [],
            comments: [],
        }));
        expect(material).not.toContain('## Description');
        expect(material).not.toContain('## Reviewers');
        expect(material).not.toContain('## Changed files');
        expect(material).not.toContain('## Comments');
        expect(material).not.toContain('## Diff');
    });
});
