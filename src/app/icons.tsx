import type { ReactNode } from 'react';

/** Inline stroke icons; decorative, so callers label the control instead. */
function Icon({ size = 18, children, ...rest }: { size?: number; children: ReactNode; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={rest.strokeWidth ?? 2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
  );
}

export const Logo = ({ size = 28, accent = '#C2361B' }: { size?: number; accent?: string }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="14" cy="14" r="11" />
    <path d="M8 17c3-6 9-6 12 0" stroke={accent} />
    <circle cx="14" cy="10" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IUpload = (p: { size?: number }) => <Icon {...p}><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Icon>;
export const ILock = (p: { size?: number }) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>;
export const IUndo = (p: { size?: number }) => <Icon {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></Icon>;
export const IRedo = (p: { size?: number }) => <Icon {...p}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></Icon>;
export const ICompare = (p: { size?: number }) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></Icon>;
export const IDownload = (p: { size?: number }) => <Icon {...p}><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></Icon>;
export const IPlus = (p: { size?: number }) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const IEye = (p: { size?: number }) => <Icon {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>;
export const IEyeOff = (p: { size?: number }) => <Icon {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.5 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4.2-.9" /></Icon>;
export const ITrash = (p: { size?: number }) => <Icon {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Icon>;
export const IUp = (p: { size?: number }) => <Icon {...p}><path d="M6 15l6-6 6 6" /></Icon>;
export const IDown = (p: { size?: number }) => <Icon {...p}><path d="M6 9l6 6 6-6" /></Icon>;
export const IBack = (p: { size?: number }) => <Icon {...p}><path d="M15 6l-6 6 6 6" /></Icon>;
export const IMove = (p: { size?: number }) => <Icon {...p}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3" /></Icon>;
export const IInk = (p: { size?: number }) => <Icon {...p}><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /></Icon>;
export const IFit = (p: { size?: number }) => <Icon {...p}><path d="M4 8c5-4 11-4 16 0M4 16c5 4 11 4 16 0M4 8v8M20 8v8" /></Icon>;
export const ILayers = (p: { size?: number }) => <Icon {...p}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></Icon>;
export const IImage = (p: { size?: number }) => <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></Icon>;
export const ISearch = (p: { size?: number }) => <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></Icon>;
