// "How it works": three icon steps on Home, a few words each. The real teaching happens in the
// headset, by doing.

import type { JSX } from 'preact';

const ICON: Record<string, JSX.Element> = {
  talk: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  ),
  sketch: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <rect x="3" y="4" width="7" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <rect x="14" y="14" width="7" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M10 7h4a3 3 0 0 1 3 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  ),
  score: (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d="M4 20V13M10 20V8M16 20V11M22 20H2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="19" cy="5" r="2.2" fill="currentColor" />
    </svg>
  ),
};

const STEPS = [
  { icon: 'talk', title: 'Talk out loud', body: 'Interviewers sit across your real desk.' },
  { icon: 'sketch', title: 'Sketch on your desk', body: 'Design rounds give you a sheet to draw on.' },
  { icon: 'score', title: 'Get a scorecard', body: 'Quotes your words. Retry your weakest answer.' },
];

export function HowItWorks() {
  return (
    <ol class="how" data-test="how-it-works" aria-label="How it works">
      {STEPS.map((s) => (
        <li key={s.title} class="how-step">
          <span class="how-icon">{ICON[s.icon]}</span>
          <span>
            <strong class="how-title">{s.title}</strong>
            <span class="how-body">{s.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
