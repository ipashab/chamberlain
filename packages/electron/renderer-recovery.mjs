const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERY_ATTEMPTS = 3;

const RECOVERABLE_REASONS = new Set([
  'abnormal-exit',
  'crashed',
  'oom',
  'memory-eviction',
]);

const RELOAD_DELAY_MS = 100;

/**
 * True for the renderer exit reasons a reload can plausibly fix. Other exits
 * (a clean quit, a kill from outside) reload nothing, crash pages included.
 */
const isRecoverableRendererExit = (reason) => RECOVERABLE_REASONS.has(reason);

export const createRendererRecoveryPolicy = (now = Date.now) => {
  let windowStartedAt = 0;
  let attempts = 0;

  return {
    shouldReload: (reason) => {
      if (!RECOVERABLE_REASONS.has(reason)) return false;

      const currentTime = now();
      if (currentTime - windowStartedAt >= RECOVERY_WINDOW_MS) {
        windowStartedAt = currentTime;
        attempts = 0;
      }
      if (attempts >= MAX_RECOVERY_ATTEMPTS) return false;

      attempts += 1;
      return true;
    },
  };
};

/**
 * Reload a window whose renderer process died, within the recovery budget.
 * Shared by every BrowserWindow so the desktop shell has one recovery policy.
 * Once the budget is spent, `onGaveUp(details)` hands the window over: main
 * answers with the crashed-window recovery page, which carries ways out a
 * reload cannot offer.
 */
export const attachRendererRecovery = (browserWindow, { log, label, onGaveUp }) => {
  const policy = createRendererRecoveryPolicy();
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!isRecoverableRendererExit(details.reason)) return;
    if (!policy.shouldReload(details.reason)) {
      log.warn('[electron] renderer recovery budget exhausted; window needs user action', {
        label: browserWindow.__ocLabel,
        surface: label,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      onGaveUp?.(details);
      return;
    }
    log.warn('[electron] renderer exited unexpectedly; reloading window', {
      label: browserWindow.__ocLabel,
      surface: label,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    setTimeout(() => {
      if (!browserWindow.isDestroyed()) {
        browserWindow.webContents.reload();
      }
    }, RELOAD_DELAY_MS);
  });
};
