import { describe, expect, test } from 'bun:test';

import { jiraWikiToMarkdown } from './wikiMarkdown';

describe('jiraWikiToMarkdown', () => {
    test('leaves plain prose and paragraphs alone', () => {
        expect(jiraWikiToMarkdown('Just words.\n\nSecond paragraph.')).toBe('Just words.\n\nSecond paragraph.');
    });

    test('speaks the inline emphases and monospace in Markdown', () => {
        expect(jiraWikiToMarkdown('*bold* and _italic_ and {{mono}} and -gone-'))
            .toBe('**bold** and *italic* and `mono` and ~~gone~~');
    });

    test('keeps citation italics and strips the color macros', () => {
        expect(jiraWikiToMarkdown('What ??he said?? {color:red}in red{color}'))
            .toBe('What *he said* in red');
    });

    test('converts the wiki links both ways', () => {
        expect(jiraWikiToMarkdown('See [the docs|https://example.com/docs] and [https://example.com].'))
            .toBe('See [the docs](https://example.com/docs) and [https://example.com](https://example.com).');
    });

    test('does not mistake an ordinary bracket for a link', () => {
        expect(jiraWikiToMarkdown('Fix [the bug] first.')).toBe('Fix [the bug] first.');
    });

    test('does not strike through hyphenated words', () => {
        expect(jiraWikiToMarkdown('A well-known no-go for the read-only side.'))
            .toBe('A well-known no-go for the read-only side.');
    });

    test('speaks headings and the one-line quote', () => {
        expect(jiraWikiToMarkdown('h2. The plan\nh5. Detail\nbq. Someone said this.'))
            .toBe('## The plan\n##### Detail\n> Someone said this.');
    });

    test('carries lists over with their nesting', () => {
        expect(jiraWikiToMarkdown('* one\n** nested\n# first'))
            .toBe('- one\n  - nested\n1. first');
    });

    test('fences code with its language and never touches the inside', () => {
        expect(jiraWikiToMarkdown('{code:java}\nint *p = null; // {{not this}}\n{code}'))
            .toBe('```java\nint *p = null; // {{not this}}\n```');
    });

    test('keeps noformat fenced and quotes as prefix lines', () => {
        expect(jiraWikiToMarkdown('{noformat}\nraw *text*\n{noformat}\n{quote}a cited line\n{quote}'))
            .toBe('```\nraw *text*\n```\n> a cited line');
    });

    test('closes an unterminated fence rather than swallowing the rest', () => {
        expect(jiraWikiToMarkdown('{code}\nconst value = 1;')).toBe('```\nconst value = 1;\n```');
    });

    test('converts a table with its header and alignment', () => {
        expect(jiraWikiToMarkdown('||Field||Value||\n|Name|demo|\n|State|open|'))
            .toBe('| Field | Value |\n| --- | --- |\n| Name | demo |\n| State | open |');
    });

    test('answers an empty text with nothing', () => {
        expect(jiraWikiToMarkdown('')).toBe('');
    });
});
