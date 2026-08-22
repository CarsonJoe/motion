import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const defaults = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

// Keep interface icons on one grid and one stroke system. Individual views can
// size and color them without subtly changing their optical alignment.
export function SettingsIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M12.22 2h-.44A1.78 1.78 0 0010 3.78v.19a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.09a2 2 0 011 1.73v.5a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73v.18A1.78 1.78 0 0011.78 22h.44A1.78 1.78 0 0014 20.22v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.38a2 2 0 00-.73-2.73l-.15-.09a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0L15 5.7a2 2 0 01-1-1.73v-.19A1.78 1.78 0 0012.22 2z" /><circle cx="12" cy="12" r="3" /></svg>
}

export function SidebarIcon(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9 4v16" /></svg>
}

export function CloseIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M6.5 6.5l11 11m0-11-11 11" /></svg>
}

export function MoreHorizontalIcon(props: IconProps) {
  return <svg {...defaults} {...props} fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.45" /><circle cx="12" cy="12" r="1.45" /><circle cx="19" cy="12" r="1.45" /></svg>
}
