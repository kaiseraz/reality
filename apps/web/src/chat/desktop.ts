/**
 * Reality in the desktop app: the window exposes exactly one thing the browser may
 * not do — the system's own file explorer, which returns a real path. In the plain
 * web app this is undefined, and the page shows its own folder tree instead.
 */
interface DesktopApi {
  /** Opens the folder explorer; resolves with the chosen path, or null on cancel. */
  chooseFolder: () => Promise<string | null>;
  /** Shows a folder in the system's file manager. */
  openPath: (target: string) => Promise<string | null>;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export const desktopApi: DesktopApi | undefined = window.desktop;
