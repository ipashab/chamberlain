import { describe, expect, test } from 'bun:test';

import type { ConfluencePageView } from '@/lib/confluence/page-api';
import { buildPageViewMaterial } from './pageAsk';

const view = (overrides: Partial<ConfluencePageView> = {}): ConfluencePageView => ({
    id: '9001',
    title: 'Release checklist',
    space: { key: 'DEMO', name: 'Demo space' },
    version: 7,
    updatedAt: '2026-10-10T10:00:00.000+0300',
    updatedBy: 'Robin Stone',
    url: 'https://confluence.example.com/spaces/DEMO/pages/9001',
    html: '<h1>Ready to ship</h1><p>Check the <b>artifacts</b> before release.</p>',
    truncated: false,
    ...overrides,
});

describe('buildPageViewMaterial', () => {
    test('carries the header facts a person would paste', () => {
        const material = buildPageViewMaterial(view());
        expect(material).toContain('Confluence page: Release checklist');
        expect(material).toContain('Space: Demo space');
        expect(material).toContain('Version: 7');
        expect(material).toContain('Updated by: Robin Stone');
        expect(material).toContain('Address: https://confluence.example.com/spaces/DEMO/pages/9001');
    });

    test('carries the words of the body, not its tags', () => {
        const material = buildPageViewMaterial(view());
        expect(material).toContain('Ready to ship');
        expect(material).toContain('artifacts');
        expect(material).not.toContain('<h1>');
        expect(material).not.toContain('<b>');
    });

    test('a cut page names the cut in the material itself', () => {
        expect(buildPageViewMaterial(view({ truncated: true })))
            .toContain('The page body was cut at what the reader could hold.');
        expect(buildPageViewMaterial(view({ truncated: false })))
            .not.toContain('was cut');
    });
});
