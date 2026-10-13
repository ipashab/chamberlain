import { describe, expect, test } from 'bun:test';

import { pageIdOf } from './pageRef';

describe('pageIdOf', () => {
    test("reads today's URL form, the part after /pages/", () => {
        expect(pageIdOf('https://confluence.example.com/spaces/DEMO/pages/9001/Release+checklist')).toBe('9001');
    });

    test("reads the page action's query form", () => {
        expect(pageIdOf('https://confluence.example.com/pages/viewpage.action?pageId=9001')).toBe('9001');
        expect(pageIdOf('https://confluence.example.com/x?q=1&pageId=8500')).toBe('8500');
    });

    test('a bare number in the field is the page id itself', () => {
        expect(pageIdOf('9001')).toBe('9001');
        expect(pageIdOf('  9001 ')).toBe('9001');
    });

    test('words without a page id say so', () => {
        expect(pageIdOf('release checklist')).toBeNull();
        expect(pageIdOf('https://confluence.example.com/spaces/DEMO')).toBeNull();
        expect(pageIdOf('')).toBeNull();
    });
});
