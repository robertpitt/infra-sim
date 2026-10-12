import type { ReactNode } from "react"

const paths: Record<string, ReactNode> = {
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M17 14c2.5 0 4 2 4 5" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13h5l1.5 3h5L16 13h5" />
      <path d="M5 13l2-8h10l2 8v6H5z" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 11l7.6-4M8.2 13l7.6 4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>
  ),
  box: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  cdn: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="6" r="1.8" />
      <circle cx="19" cy="6" r="1.8" />
      <circle cx="5" cy="18" r="1.8" />
      <circle cx="19" cy="18" r="1.8" />
      <path d="M6.4 7.2l3.2 3M17.6 7.2l-3.2 3M6.4 16.8l3.2-3M17.6 16.8l-3.2-3" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>
  ),
  bucket: (
    <>
      <path d="M4 7c0 1.4 3.6 2.5 8 2.5S20 8.4 20 7s-3.6-2.5-8-2.5S4 5.6 4 7z" />
      <path d="M4 7l2 12c.2 1.2 2.7 2 6 2s5.8-.8 6-2l2-12" />
    </>
  ),
  gateway: (
    <>
      <path d="M3 12h5M16 12h5" />
      <rect x="8" y="7" width="8" height="10" rx="2" />
      <path d="M11 10.5l2 1.5-2 1.5" />
    </>
  ),
  lambda: <path d="M6 20l5.5-11L9 4H6M10 12l3.5 8h4" />,
  queue: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M8 7v10M13 7v10M18 7v10" />
    </>
  ),
  topic: (
    <>
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M8.2 12h7.6M8 11l8-4M8 13l8 4" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 10h17M3.5 14.5h17M9.5 5v14" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  region: (
    <>
      <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  vpc: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" strokeDasharray="3 2.5" />
      <rect x="8" y="9" width="8" height="6" rx="1.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  // Icons for the compute, data and integration services: one per service, in the same 24px stroke style.
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1.5" />
      <rect x="4" y="13" width="16" height="7" rx="1.5" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5" />
    </>
  ),
  balancer: (
    <>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="5.5" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="19" cy="18.5" r="2" />
      <path d="M7.2 12H17M7 11l10-4.8M7 13l10 4.8" />
    </>
  ),
  container: (
    <>
      <rect x="3.5" y="7" width="17" height="11" rx="1.5" />
      <path d="M7.5 7v11M12 7v11M16.5 7v11M6 4.5h12" />
    </>
  ),
  cache: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v5c0 1.5 3.1 2.8 7 2.8M19 6v4" />
      <path d="M15.5 13l-2 4h3l-2 4" />
    </>
  ),
  stream: (
    <>
      <path d="M3 7c3-2 6 2 9 0s6 2 9 0" />
      <path d="M3 12c3-2 6 2 9 0s6 2 9 0" />
      <path d="M3 17c3-2 6 2 9 0s6 2 9 0" />
    </>
  ),
  bus: (
    <>
      <path d="M3 12h18" />
      <path d="M6 12V6M12 12V6M18 12V6M9 12v6M15 12v6" />
      <circle cx="6" cy="5" r="1.4" />
      <circle cx="12" cy="5" r="1.4" />
      <circle cx="18" cy="5" r="1.4" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="15" cy="19" r="1.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  workflow: (
    <>
      <rect x="9" y="3" width="6" height="4.5" rx="1" />
      <rect x="3" y="16.5" width="6" height="4.5" rx="1" />
      <rect x="15" y="16.5" width="6" height="4.5" rx="1" />
      <path d="M12 7.5v4.5M6 16.5V12h12v4.5" />
    </>
  ),
  dns: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17" />
      <path d="M15 15.5l2.5 2.5 3.5-4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  proxy: (
    <>
      <path d="M3 8h6M3 12h6M3 16h6" />
      <rect x="9" y="6" width="6" height="12" rx="1.5" />
      <path d="M15 12h6" />
    </>
  ),
  back: <path d="M15 6l-6 6 6 6" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </>
  ),
  reset: (
    <>
      <path d="M4 12a8 8 0 1 0 2.5-5.8" />
      <path d="M4 4v4.5h4.5" />
    </>
  ),
  step: (
    <>
      <path d="M6 5v14l9-7z" fill="currentColor" />
      <path d="M18 5v14" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  warn: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="6" height="6" rx="1" />
      <rect x="15" y="4" width="6" height="6" rx="1" />
      <rect x="9" y="14" width="6" height="6" rx="1" />
      <path d="M6 10v2h12v-2M12 12v2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V5M7 9l5-5 5 5" />
      <path d="M5 20h14" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  reload: (
    <>
      <path d="M20 12a8 8 0 1 1-2.5-5.8" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  charts: (
    <>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l4-5 3 3 5-6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" />,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
      <circle cx="12" cy="12" r="6.5" />
    </>
  )
}

export const Icon = ({ name, size = 16, className }: { name: string; size?: number; className?: string }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths[name] ?? paths.box}
  </svg>
)
