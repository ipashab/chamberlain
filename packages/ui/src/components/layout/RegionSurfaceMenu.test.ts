import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { pickRegionPickerSessions, pickRegionPickerSessionsForDirectory } from './regionPickerSessions';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
    id,
    projectID: 'p',
    directory: '/repo',
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    ...overrides,
});

describe('pickRegionPickerSessions', () => {
    test('keeps the newest conversations first, subtasks and archived rows out', () => {
        const sessions = [
            session('old', { time: { created: 0, updated: 1 } }),
            session('subtask', { parentID: 'old', time: { created: 0, updated: 99 } }),
            session('archived', { time: { created: 0, updated: 98, archived: 5 } }),
            session('new', { time: { created: 0, updated: 100 } }),
        ];

        expect(pickRegionPickerSessions(sessions).map((entry) => entry.id)).toEqual(['new', 'old']);
    });

    test('caps the list at the picker limit', () => {
        const sessions = Array.from({ length: 12 }, (_, index) => (
            session(`s${index}`, { time: { created: 0, updated: index } })
        ));

        expect(pickRegionPickerSessions(sessions).map((entry) => entry.id))
            .toEqual(['s11', 's10', 's9', 's8', 's7', 's6', 's5', 's4']);
    });

    test('a subtask never orphans its parent from the list', () => {
        // A newest-answer reading may belong to a subtask; the conversation
        // the user recognizes is the parent run, so only parents are offered.
        const sessions = [
            session('parent', { time: { created: 0, updated: 10 } }),
            session('child', { parentID: 'parent', time: { created: 0, updated: 20 } }),
        ];

        expect(pickRegionPickerSessions(sessions).map((entry) => entry.id)).toEqual(['parent']);
    });
});

describe('pickRegionPickerSessionsForDirectory', () => {
    const byDirectory = new Map<string, Session[]>([
        ['/repo', [session('root', { time: { created: 0, updated: 10 } })]],
        ['/repo/sub', [session('sub', { time: { created: 0, updated: 20 } })]],
        // A managed chat lives in its own folder under the Chats root.
        ['/chats/2026-10-13/session-a', [session('chat-a', { time: { created: 0, updated: 30 } })]],
        ['/elsewhere', [session('other', { time: { created: 0, updated: 40 } })]],
    ]);

    test('keeps the directory itself and everything under it', () => {
        expect(pickRegionPickerSessionsForDirectory(byDirectory, '/repo').map((entry) => entry.id))
            .toEqual(['sub', 'root']);
    });

    test('a Chats root keeps the managed chats stored one level down', () => {
        expect(pickRegionPickerSessionsForDirectory(byDirectory, '/chats').map((entry) => entry.id))
            .toEqual(['chat-a']);
    });

    test('an unrelated directory and an empty key offer nothing', () => {
        expect(pickRegionPickerSessionsForDirectory(byDirectory, '/elsewhere').map((entry) => entry.id))
            .toEqual(['other']);
        expect(pickRegionPickerSessionsForDirectory(byDirectory, '')).toEqual([]);
    });
});
