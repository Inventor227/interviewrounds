// A large tappable card that is one link. Sized for a Quest Browser pointer and a thumb.

import type { ComponentChildren } from 'preact';

export function Tile(props: {
  href: string;
  title: string;
  /** Short fact under the title, e.g. "8 min quick". */
  meta?: ComponentChildren;
  children?: ComponentChildren;
  test: string;
  icon?: ComponentChildren;
  onClick?: (e: MouseEvent) => void;
}) {
  return (
    <a class="tile" href={props.href} data-test={props.test} onClick={props.onClick}>
      {props.icon && (
        <span class="tile-icon" aria-hidden="true">
          {props.icon}
        </span>
      )}
      <span class="tile-head">
        <strong class="tile-title">{props.title}</strong>
        {props.meta && <span class="tile-meta">{props.meta}</span>}
      </span>
      {props.children && <span class="tile-line">{props.children}</span>}
    </a>
  );
}

/** Simple line icons for the three ways in. */
export const RoleIcon = {
  sde: (
    <svg viewBox="0 0 32 32" width="32" height="32">
      <rect x="4" y="7" width="24" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 13l-3 2.5 3 2.5M20 13l3 2.5-3 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M11 27h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  ),
  pm: (
    <svg viewBox="0 0 32 32" width="32" height="32">
      <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <rect x="18" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <rect x="5" y="18" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M18.5 25l3-3.5 2.5 2 3.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  ),
  meeting: (
    <svg viewBox="0 0 32 32" width="32" height="32">
      <ellipse cx="16" cy="19" rx="11" ry="5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <circle cx="9" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8" />
      <circle cx="16" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8" />
      <circle cx="23" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8" />
    </svg>
  ),
};
