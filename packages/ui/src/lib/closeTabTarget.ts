import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

/**
 * What Cmd/Ctrl+W closes in the desktop app.
 *
 * The window menu owns the shortcut, so the page cannot catch the key itself.
 * A surface with a tab of its own (a file open in Files) registers here; the
 * desktop shell is told whether one is registered, and while one is, the
 * shortcut arrives as an `openchamber:close-tab` event instead of closing the
 * window. The surface with keyboard focus wins; without one, the last
 * registered surface wins. Several file panes can be registered at once —
 * two layout regions, each showing its own file — and focus is what tells
 * them apart.
 */
type CloseTabTarget = {
  close: () => void;
  /** Whether the registered node holds keyboard focus right now. */
  ownsFocus?: () => boolean;
};

const handlers: Array<CloseTabTarget> = [];
let listening = false;

const report = (): void => {
  if (!hasDesktopInvoke()) return;
  void invokeDesktop('desktop_set_close_tab_target', { active: handlers.length > 0 });
};

const handleCloseTab = (): void => {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    const target = handlers[index];
    if (target.ownsFocus?.()) {
      target.close();
      return;
    }
  }
  handlers[handlers.length - 1]?.close();
};

export const registerCloseTabTarget = (close: () => void, ownsFocus?: () => boolean): (() => void) => {
  if (!listening) {
    window.addEventListener('openchamber:close-tab', handleCloseTab);
    listening = true;
  }
  const target: CloseTabTarget = { close, ownsFocus };
  handlers.push(target);
  report();
  return () => {
    const index = handlers.lastIndexOf(target);
    if (index >= 0) handlers.splice(index, 1);
    report();
  };
};
