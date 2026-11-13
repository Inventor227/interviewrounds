// "How it works": three short cards behind a small link on Home. Nothing shows on its own on a
// first visit; the real teaching happens in the headset, by doing.

import { useState } from 'preact/hooks';

const CARDS = [
  {
    title: 'Practice out loud',
    body: 'Interview rounds and real meetings, with people who sit across your own desk in passthrough. They listen, follow up and push back.',
  },
  {
    title: 'A round takes 8 minutes',
    body: 'You talk, and in design rounds you build on a sheet on your desk with your hands. Then a scorecard quotes you and gives you one answer to retry.',
  },
  {
    title: 'Mic and headset',
    body: 'Allow the microphone once. On a Quest the room opens at your desk. On a laptop or phone you get a preview on the screen.',
  },
];

export function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <div class="how" data-test="how-it-works">
      <button type="button" class="linklike" aria-expanded={open} aria-controls="how-cards" onClick={() => setOpen(!open)} data-test="how-toggle">
        {open ? 'Hide how it works' : 'How it works'}
      </button>
      {open && (
        <ol class="onboard-cards" id="how-cards" data-test="how-cards">
          {CARDS.map((c, i) => (
            <li key={c.title} class="onboard-card">
              <span class="onboard-n" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
