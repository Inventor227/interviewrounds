// Small shared pieces: page frame, loading and error states, segmented choice, monogram.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ApiError } from '../../net/api';

let pagesShown = 0;

export function Page(props: {
  test: string;
  title: ComponentChildren;
  lede?: ComponentChildren;
  back?: { href: string; label: string };
  wide?: boolean;
  children?: ComponentChildren;
  attrs?: Record<string, string>;
}) {
  const h = useRef<HTMLHeadingElement>(null);
  // Move focus to the new page's heading on client side navigation, so screen readers and
  // keyboard users start at the top of the new page.
  useEffect(() => {
    if (pagesShown++ > 0) h.current?.focus({ preventScroll: true });
  }, [props.test]);
  return (
    <section class={`pg${props.wide ? ' pg-wide' : ''}`} data-test={`page-${props.test}`} aria-labelledby={`h-${props.test}`} {...props.attrs}>
      {props.back && (
        <a class="back" href={props.back.href} data-test="back">
          {props.back.label}
        </a>
      )}
      <h1 id={`h-${props.test}`} ref={h} tabIndex={-1}>
        {props.title}
      </h1>
      {props.lede && <p class="lede">{props.lede}</p>}
      {props.children}
    </section>
  );
}

export function Loading(props: { label?: string; rows?: number }) {
  return (
    <div class="loading" role="status" aria-live="polite" data-test="loading">
      <span class="sr-only">{props.label ?? 'Loading'}</span>
      {Array.from({ length: props.rows ?? 3 }, (_, i) => (
        <div class="skeleton" key={i} style={{ width: `${92 - i * 14}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

export function errorText(err: ApiError): { title: string; body: string } {
  if (err.status === 0 || err.code === 'network') {
    return { title: 'No connection', body: 'We could not reach the server. Check your connection, then try again.' };
  }
  if (err.status === 404) return { title: 'Not found', body: 'That page or round does not exist anymore.' };
  if (err.status >= 500) return { title: 'Something broke on our side', body: 'The server had a problem. Try again in a moment.' };
  return { title: 'That did not work', body: err.message };
}

export function ErrorState(props: { error: ApiError; onRetry?: () => void; children?: ComponentChildren }) {
  const t = errorText(props.error);
  return (
    <div class="state state-error" role="alert" data-test="error" data-code={props.error.code}>
      <h2>{t.title}</h2>
      <p>{t.body}</p>
      <div class="row">
        {props.onRetry && (
          <button type="button" class="btn" onClick={props.onRetry} data-test="retry-load">
            Try again
          </button>
        )}
        {props.children}
      </div>
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A radio group drawn as a segmented control. Arrow keys move between options (native radios). */
export function Segmented<T extends string>(props: {
  name: string;
  legend: string;
  value: T;
  choices: Choice<T>[];
  onChange: (v: T) => void;
  test?: string;
  hideLegend?: boolean;
}) {
  return (
    <fieldset class="seg" data-test={props.test ?? `seg-${props.name}`}>
      <legend class={props.hideLegend ? 'sr-only' : undefined}>{props.legend}</legend>
      <div class="seg-row">
        {props.choices.map((c) => (
          <label class="seg-opt" key={c.value}>
            <input
              type="radio"
              name={props.name}
              value={c.value}
              checked={props.value === c.value}
              onChange={() => props.onChange(c.value)}
              data-test={`${props.name}-${c.value}`}
            />
            <span>
              {c.label}
              {c.hint && <small>{c.hint}</small>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Initials in a soft disc, standing in for a portrait. */
export function Monogram(props: { name: string; size?: 'sm' | 'md' | 'lg'; tone?: number }) {
  const initials = props.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span class={`mono mono-${props.size ?? 'md'} tone-${(props.tone ?? hash(props.name)) % 4}`} aria-hidden="true">
      {initials}
    </span>
  );
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function Disclosure(props: {
  summary: ComponentChildren;
  test: string;
  open?: boolean;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <details class={`disc ${props.class ?? ''}`} data-test={props.test} open={props.open}>
      <summary>{props.summary}</summary>
      <div class="disc-body">{props.children}</div>
    </details>
  );
}
