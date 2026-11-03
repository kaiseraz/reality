/** Small inline icon set (24×24 strokes), so the UI needs no icon dependency. */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  upload: 'M12 15V4M7 9l5-5 5 5M5 15v4h14v-4',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  x: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  puzzle:
    'M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  wave: 'M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3.5-4 5-3',
  bike: 'M5.5 17.5a3.5 3.5 0 1 0 0-.01zM18.5 17.5a3.5 3.5 0 1 0 0-.01zM5.5 17.5L9 9h6l3.5 8.5M12 17.5L9 9M15 9l-1-3h-2',
  leaf: 'M5 21c0-9 6-15 15-16-1 9-7 15-15 16zM5 21l7-7',
  play: 'M7 4l13 8-13 8z',
  sparkle:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  edit: 'M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4zM14 6l4 4',
  panel: 'M3 4h18v16H3zM9 4v16',
  layout: 'M3 4h18v16H3zM3 10h18M12 10v10',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  target:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M8 7h7',
  chevron: 'M9 6l6 6-6 6',
  'folder-open': 'M4 19V6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v2M4 19l2.5-8h15L19 19z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Reality mark, drawn in the text colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="75 52.5 316 316" className={className} aria-hidden fill="currentColor">
      <rect x="132" y="99" width="254" height="62" rx="31" />
      <rect x="80" y="182.5" width="158" height="60.5" rx="30.25" />
      <path d="M159 161C165 161 168 165 168 172C168 179 164 184 158 184H209C203 184 200 179 200 172C200 165 203 161 209 161Z" />
      <circle cx="304.5" cy="207" r="33" />
      <circle cx="249" cy="288" r="33" />
      <path d="M272 215C273 240 268 250 232 259L282 288C282 268 284 258 296 249C304 243 318 238 326 231Z" />
    </svg>
  );
}
