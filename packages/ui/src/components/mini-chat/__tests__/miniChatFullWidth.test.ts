/**
 * Regression guard for the mini-chat window's column widths.
 *
 * The mini chat is a window the user sizes: unlike the main workspace, it has
 * no room budget for a centered readable column, so the transcript and the
 * composer must fill the window's width. The shared `.chat-column` rules in
 * typography.css cap the columns at 48rem; the `.mini-chat-layout` root class
 * overrides them back to 100%.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const layoutSource = readFileSync(join(__dirname, '..', 'MiniChatLayout.tsx'), 'utf-8');
const typographySource = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'typography.css'), 'utf-8');

describe('mini-chat column widths', () => {
  test('marks the mini-chat root with its layout class', () => {
    expect(layoutSource).toContain('"mini-chat-layout flex h-full');
  });

  test('fills the window width for every chat column', () => {
    expect(typographySource).toContain('.mini-chat-layout .chat-column');
    expect(typographySource).toContain('.mini-chat-layout .chat-input-column');
    expect(typographySource).toContain('.mini-chat-layout .chat-message-column');
  });

  test('keeps the unlayered width duplicate for the message column', () => {
    // The base `.chat-message-column` width survives a style recalc only
    // through its unlayered duplicate; the mini-chat override needs the same
    // protection or a heavy relayout can flash the column back to 48rem.
    const unlayered =
      /\.mini-chat-layout \.chat-message-column \{\s*width: 100%;\s*\}(?![\s\S]*@layer)/;
    expect(unlayered.test(typographySource)).toBe(true);
  });
});
