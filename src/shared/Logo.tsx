/**
 * Kursor brand mark as inline SVG React components (shared by the chat and settings webviews).
 * Source of truth: brand/kursor-mark.svg and brand/kursor-glyph.svg — keep the geometry in sync.
 *
 * - `KursorMark`:  the full mark on its dark rounded tile (gradients kept, ids made unique per
 *                  instance so two marks on one page do not collide).
 * - `KursorGlyph`: the mark without the tile; the bracket is `currentColor`, so it adapts to light
 *                  and dark themes. The bar keeps the violet → orchid gradient.
 */
import { useId, type SVGProps } from 'react';

type LogoProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'> & { size?: number | string; title?: string };

const BAR = { x: 78, y: 62, width: 24, height: 132, rx: 10 };
const BRACKET = '176,70 110,128 176,186';

function safeId(id: string): string {
  // useId yields ":r0:" — colons are legal in ids but awkward inside url(#…) in some engines.
  return id.replace(/[^a-zA-Z0-9_-]/g, '');
}

export function KursorMark({ size = 56, title, ...rest }: LogoProps) {
  const p = `k${safeId(useId())}`;
  const tile = `${p}-tile`;
  const glow = `${p}-glow`;
  const bar = `${p}-bar`;
  const soft = `${p}-soft`;
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} {...rest}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b1e2a" />
          <stop offset="1" stopColor="#0b0c10" />
        </linearGradient>
        <radialGradient id={glow} cx="0.3" cy="0.25" r="0.75">
          <stop offset="0" stopColor="#7c8cff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#7c8cff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={bar} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8f9bff" />
          <stop offset="1" stopColor="#b57cff" />
        </linearGradient>
        <filter id={soft} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>
      <rect width="256" height="256" rx="58" fill={`url(#${tile})`} />
      <rect width="256" height="256" rx="58" fill={`url(#${glow})`} />
      <rect {...BAR} fill="#9b8cff" opacity="0.55" filter={`url(#${soft})`} />
      <rect {...BAR} fill={`url(#${bar})`} />
      <polyline points={BRACKET} fill="none" stroke="#eef0f6" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function KursorGlyph({ size = 16, title, ...rest }: LogoProps) {
  const bar = `k${safeId(useId())}-bar`;
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} {...rest}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={bar} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8f9bff" />
          <stop offset="1" stopColor="#b57cff" />
        </linearGradient>
      </defs>
      <rect {...BAR} fill={`url(#${bar})`} />
      <polyline points={BRACKET} fill="none" stroke="currentColor" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
