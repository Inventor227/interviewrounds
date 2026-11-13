// Formatting for times, dates and labels on the 2D pages. Everything is in the viewer's locale
// and time zone.

import type { Level, Style, VerdictLabel } from '../../shared/types';

/** 372.4 → "6:12" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function timeOfDay(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** When a cap resets, in local time: "at 5:00 PM", "tomorrow at 12:00 AM", "on Fri, Nov 14 at 9:00 AM". */
export function resetPhrase(isoAt: string, now: Date = new Date()): string {
  const at = new Date(isoAt);
  if (Number.isNaN(at.getTime())) return 'soon';
  const t = timeOfDay(at);
  if (sameDay(at, now)) return `at ${t} today`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(at, tomorrow)) return `tomorrow at ${t}`;
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(at);
  return `on ${day} at ${t}`;
}

/** "Today", "Yesterday", or a short date. */
export function dayLabel(isoAt: string, now: Date = new Date()): string {
  const at = new Date(isoAt);
  if (sameDay(at, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(at, y)) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(at);
}

export function longDate(isoAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(isoAt));
}

export const VERDICT_NAMES: Record<VerdictLabel, string> = {
  strong_no_hire: 'Strong no hire',
  no_hire: 'No hire',
  leaning_no_hire: 'Leaning no hire',
  leaning_hire: 'Leaning hire',
  hire: 'Hire',
  strong_hire: 'Strong hire',
};

export const LEVEL_NAMES: Record<Level, string> = { junior: 'Junior', mid: 'Mid', senior: 'Senior', staff: 'Staff' };
export const STYLE_NAMES: Record<Style, string> = { warm: 'Warm', neutral: 'Neutral', tough: 'Tough' };

export const ROLE_NAMES: Record<string, string> = { sde: 'Software Engineer', pm: 'Product Manager' };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function pct(v: number | null | undefined): string | null {
  return v == null ? null : `${Math.round(v * 100)}%`;
}
