/**
 * The full-window recovery page shown after the renderer-recovery budget is
 * spent (renderer-recovery.mjs calls back into main.mjs, which loads this
 * page). A renderer that keeps dying takes its interface with it, so the page
 * lives in a fresh document main owns and offers two ways out:
 *
 *  - Go back: return to the document the window had before the crash.
 *  - Reset saved state: clear the localStorage of that document's origin and
 *    return to it. Persisted window state is what usually keeps a crashing
 *    renderer crashing, and wiping it gives the app a clean slate while
 *    sessions and messages stay untouched on the server.
 *
 * Loaded as a data: URL so the page works in packaged builds and dev windows
 * alike; the retry target and each button's reachability are embedded in the
 * markup. Both buttons hand their work to main over the desktop bridge, whose
 * handler answers only this page (crashed-window commands in main.mjs).
 * Electron imports stay out so node:test can build the page.
 */

import { crashPageLabel, normalizeMenuLocale } from './menu-locales.mjs';
import { SPLASH_LOGO_SVG } from './splash-logo.mjs';

const escapeHtmlText = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const escapeJsString = (value) => JSON.stringify(String(value ?? ''));

export const buildCrashedWindowHtml = ({ locale, retryUrl = '' } = {}) => {
  const normalizedLocale = normalizeMenuLocale(locale);
  const label = (key) => crashPageLabel(normalizedLocale, key);
  const canGoBack = retryUrl !== '';
  const title = escapeHtmlText(label('crashPage.title'));
  const body = escapeHtmlText(label('crashPage.body'));
  const retryText = escapeHtmlText(label('crashPage.retry'));
  const resetText = escapeHtmlText(label('crashPage.reset'));

  const actions = canGoBack
    ? `
    <div class="oc-crash-actions">
      <button type="button" class="oc-crash-retry" id="oc-crash-retry" autofocus>
        <span class="oc-crash-retry-arrow" aria-hidden="true">&larr;</span>${retryText}
      </button>
      <button type="button" class="oc-crash-reset" id="oc-crash-reset">${resetText}</button>
    </div>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenChamber</title>
  <style>
    :root { color-scheme: light dark; }
    :root {
      --splash-background: #FFFCF0;
      --splash-stroke: #100F0F;
      --splash-face-fill: rgba(0, 0, 0, 0.15);
      --splash-cell-fill: rgba(0, 0, 0, 0.35);
      --splash-logo-fill: var(--splash-stroke);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --splash-background: #151313;
        --splash-stroke: #CECDC3;
        --splash-face-fill: rgba(255, 255, 255, 0.15);
        --splash-cell-fill: rgba(255, 255, 255, 0.35);
      }
    }
    @supports (color: color-mix(in srgb, white 50%, transparent)) {
      :root {
        --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent);
        --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent);
      }
    }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      place-items: center;
      font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--splash-background);
      color: var(--splash-stroke);
    }
    .oc-crash {
      display: grid;
      justify-items: center;
      gap: 4px;
      padding: 32px;
      max-width: 520px;
      text-align: center;
      animation: oc-crash-in 0.3s ease-out both;
    }
    @keyframes oc-crash-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .oc-crash-title {
      margin: 20px 0 0;
      font-size: 17px;
      font-weight: 600;
      line-height: 1.4;
    }
    .oc-crash-body {
      margin: 10px 0 0;
      font-size: 13.5px;
      line-height: 1.55;
      opacity: 0.78;
    }
    .oc-crash-actions {
      margin-top: 28px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: center;
    }
    button {
      appearance: none;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 13.5px;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s ease-out;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.5; cursor: default; }
    .oc-crash-retry {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--splash-stroke);
      color: var(--splash-background);
      font-weight: 600;
    }
    .oc-crash-reset {
      background: transparent;
      color: var(--splash-stroke);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--splash-stroke) 40%, transparent);
    }
  </style>
</head>
<body>
  <main class="oc-crash" data-retry="${escapeHtmlText(retryUrl)}">
    ${SPLASH_LOGO_SVG(72, 72)}
    <h1 class="oc-crash-title">${title}</h1>
    <p class="oc-crash-body">${body}</p>
    ${actions}
  </main>
  <script>
    (function () {
      var target = ${escapeJsString(retryUrl)};
      var retryButton = document.getElementById('oc-crash-retry');
      var resetButton = document.getElementById('oc-crash-reset');
      if (!target || !retryButton || !resetButton) return;
      var invoke = function (command) {
        var bridge = window.__OPENCHAMBER_DESKTOP__;
        if (!bridge || typeof bridge.invoke !== 'function') return Promise.reject();
        return bridge.invoke(command);
      };
      // Main answers both commands and navigates the window itself: the
      // crash page is a data: origin, which the navigation guard would not
      // let move this window in development. Direct navigation stays as the
      // retry fallback for contexts without the bridge, so the page remains
      // inspectable outside the app.
      retryButton.addEventListener('click', function () {
        invoke('desktop_crashed_window_retry')
          .catch(function () { window.location.href = target; });
      });
      resetButton.addEventListener('click', function () {
        resetButton.disabled = true;
        invoke('desktop_crashed_window_reset')
          .catch(function () { resetButton.disabled = false; });
      });
    })();
  </script>
</body>
</html>`;
};

export const buildCrashedWindowDataUrl = ({ locale, retryUrl = '' } = {}) => (
  `data:text/html;charset=utf-8,${encodeURIComponent(buildCrashedWindowHtml({ locale, retryUrl }))}`
);
