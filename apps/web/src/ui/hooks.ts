import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
// v2: the default became dark; the old key held an automatic 'system'.
const THEME_KEY = 'reality.theme.v2';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the choice lasts for this page only.
  }
}

function systemDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Theme preference, applied as data-theme on <html>; resolved tells components which applies. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => {
    const v = read(THEME_KEY);
    // Dark by default, like Astra; a saved choice (including system) wins.
    return v === 'light' || v === 'system' ? v : 'dark';
  });
  const [sysDark, setSysDark] = useState(systemDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSysDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    write(THEME_KEY, pref);
    window.dispatchEvent(new Event('reality-theme'));
  }, [pref]);

  const resolved: 'light' | 'dark' = pref === 'system' ? (sysDark ? 'dark' : 'light') : pref;
  return { pref, setPref, resolved };
}

/** The theme that currently applies, for components that cannot use CSS (charts, dockview). */
export function useResolvedTheme(): 'light' | 'dark' {
  const get = (): 'light' | 'dark' => {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    return systemDark() ? 'dark' : 'light';
  };
  const [theme, setTheme] = useState(get);
  useEffect(() => {
    const update = () => setTheme(get());
    window.addEventListener('reality-theme', update);
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    mq?.addEventListener('change', update);
    return () => {
      window.removeEventListener('reality-theme', update);
      mq?.removeEventListener('change', update);
    };
  }, []);
  return theme;
}

export type Route =
  | { page: 'home' }
  | { page: 'task'; id: string }
  | { page: 'project'; id: string }
  | { page: 'new-project' }
  | { page: 'inbox' }
  | { page: 'capabilities' }
  | { page: 'team' }
  | { page: 'bots' }
  | { page: 'knowledge' }
  | { page: 'pages' }
  | { page: 'doc'; id: string }
  | { page: 'routines' }
  | { page: 'chat'; id: string }
  | { page: 'missions' }
  | { page: 'bot'; id: string };

function parse(hash: string): Route {
  const m = /^#\/task\/([0-9a-f-]{36})$/i.exec(hash);
  if (m?.[1]) return { page: 'task', id: m[1] };
  const p = /^#\/project\/([0-9a-f-]{36})$/i.exec(hash);
  if (p?.[1]) return { page: 'project', id: p[1] };
  if (hash === '#/new-project') return { page: 'new-project' };
  if (hash === '#/inbox') return { page: 'inbox' };
  if (hash === '#/capabilities') return { page: 'capabilities' };
  if (hash === '#/team') return { page: 'team' };
  if (hash === '#/bots') return { page: 'bots' };
  if (hash === '#/knowledge') return { page: 'knowledge' };
  if (hash === '#/pages') return { page: 'pages' };
  if (hash === '#/routines') return { page: 'routines' };
  if (hash === '#/missions') return { page: 'missions' };
  const c = /^#\/chat\/([0-9a-f-]{36})$/i.exec(hash);
  if (c?.[1]) return { page: 'chat', id: c[1] };
  const d = /^#\/page\/([0-9a-f-]{36})$/i.exec(hash);
  if (d?.[1]) return { page: 'doc', id: d[1] };
  const b = /^#\/bot\/([0-9a-f-]{36})$/i.exec(hash);
  if (b?.[1]) return { page: 'bot', id: b[1] };
  return { page: 'home' };
}

export function routeHref(r: Route): string {
  if (r.page === 'task') return `#/task/${r.id}`;
  if (r.page === 'project') return `#/project/${r.id}`;
  if (r.page === 'new-project') return '#/new-project';
  if (r.page === 'inbox') return '#/inbox';
  if (r.page === 'capabilities') return '#/capabilities';
  if (r.page === 'team') return '#/team';
  if (r.page === 'bots') return '#/bots';
  if (r.page === 'knowledge') return '#/knowledge';
  if (r.page === 'pages') return '#/pages';
  if (r.page === 'routines') return '#/routines';
  if (r.page === 'chat') return `#/chat/${r.id}`;
  if (r.page === 'missions') return '#/missions';
  if (r.page === 'doc') return `#/page/${r.id}`;
  if (r.page === 'bot') return `#/bot/${r.id}`;
  return '#/';
}

/** Hash routing: links work, the back button works, no server routes needed. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: Route) => {
    const href = routeHref(r);
    if (window.location.hash !== href) window.location.hash = href;
    setRoute(r);
  }, []);
  return { route, go };
}
