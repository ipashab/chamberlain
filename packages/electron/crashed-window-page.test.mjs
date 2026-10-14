import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCrashedWindowDataUrl,
  buildCrashedWindowHtml,
} from './crashed-window-page.mjs';

test('renders ru copy for a ru locale', () => {
  const html = buildCrashedWindowHtml({ locale: 'ru', retryUrl: 'openchamber-ui://app/index.html' });

  assert.ok(html.includes('Это окно перестало работать'));
  assert.ok(html.includes('Вернуться'));
  assert.ok(html.includes('Сбросить сохранённое состояние'));
});

test('falls back to English copy for locales without translations', () => {
  const html = buildCrashedWindowHtml({ locale: 'de', retryUrl: 'http://127.0.0.1:5173/' });

  assert.ok(html.includes('This window has stopped working'));
  assert.ok(html.includes('Go back'));
  assert.ok(html.includes('Reset saved state'));
});

test('says what reset does and what it leaves alone', () => {
  const html = buildCrashedWindowHtml({ locale: 'en', retryUrl: 'http://127.0.0.1:5173/' });

  assert.ok(html.includes('sessions and messages stay intact'));
});

test('embeds the retry target escaped for HTML and for script context', () => {
  const retryUrl = 'http://127.0.0.1:5173/s/?q="a&<b>';
  const html = buildCrashedWindowHtml({ locale: 'en', retryUrl });

  assert.ok(html.includes('data-retry="http://127.0.0.1:5173/s/?q=&quot;a&amp;&lt;b&gt;"'));
  assert.ok(html.includes('var target = "http://127.0.0.1:5173/s/?q=\\"a&<b>";'));
  assert.ok(!html.includes('<script>\n    (function () {\n      var target = "http://127.0.0.1:5173/s/?q="?'));
});

test('hides the recovery buttons when no retry target is known', () => {
  const html = buildCrashedWindowHtml({ locale: 'ru', retryUrl: '' });

  assert.ok(!html.includes('<button'));
});

test('builds a data URL whose decoded payload is the page', () => {
  const args = { locale: 'ru', retryUrl: 'openchamber-ui://app/index.html' };
  const dataUrl = buildCrashedWindowDataUrl(args);

  assert.ok(dataUrl.startsWith('data:text/html;charset=utf-8,'));
  const decoded = decodeURIComponent(dataUrl.slice('data:text/html;charset=utf-8,'.length));
  assert.equal(decoded, buildCrashedWindowHtml(args));
});

test('the page script only navigates when a target and the buttons exist', () => {
  const html = buildCrashedWindowHtml({ locale: 'en', retryUrl: 'openchamber-ui://app/index.html' });

  assert.ok(html.includes('if (!target || !retryButton || !resetButton) return;'));
  assert.ok(html.includes("invoke('desktop_crashed_window_retry')"));
  assert.ok(html.includes("invoke('desktop_crashed_window_reset')"));
  // Without the bridge the retry button still falls back to plain navigation.
  assert.ok(html.includes('window.location.href = target;'));
});
