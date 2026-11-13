// The report's verdict: a chip, the six step hire scale with a marker, confidence, and a one tap
// explainer. Meetings show their outcome instead (no hire verdict).

import { useState } from 'preact/hooks';
import type { MeetingDetails, Verdict as VerdictData } from '../../shared/types';
import { VERDICT_LABELS } from '../../shared/types';
import { VERDICT_NAMES } from './format';

const CONFIDENCE: Record<VerdictData['confidence'], string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export function Verdict(props: { verdict: VerdictData; summary: string }) {
  const v = props.verdict;
  const [open, setOpen] = useState(false);
  const name = VERDICT_NAMES[v.label];
  const lean = v.index >= 4 ? 'up' : 'down';
  return (
    <div class="verdict" data-test="verdict" data-label={v.label}>
      <div class="verdict-top">
        <span class={`chip chip-${lean}`} data-test="verdict-chip">
          {v.is_provisional && <span class="chip-pre">Signal so far</span>}
          <span class="chip-name">{name}</span>
        </span>
        <span class="verdict-conf" data-test="verdict-confidence">
          {CONFIDENCE[v.confidence]}
        </span>
      </div>
      <p class="verdict-summary">{props.summary}</p>

      <div class="scale" aria-hidden="true">
        {VERDICT_LABELS.map((l, i) => (
          <span key={l} class={`scale-step s${i + 1}${i + 1 === v.index ? ' at' : ''}`}>
            <span class="scale-bar" />
            <span class="scale-name">{VERDICT_NAMES[l]}</span>
          </span>
        ))}
      </div>

      <p class="scale-caption">
        On the hire / no-hire scale used at top tech companies.{' '}
        <button
          type="button"
          class="linklike"
          aria-expanded={open}
          aria-controls="verdict-explain"
          onClick={() => setOpen(!open)}
          data-test="verdict-explain-toggle"
        >
          {open ? 'Hide' : 'What does this mean?'}
        </button>
      </p>
      {open && (
        <div class="explain" id="verdict-explain" data-test="verdict-explain">
          <p>
            After a real round, each interviewer picks one of six steps, from strong no hire to strong hire. We pick yours with a
            fixed rule over your competency scores, so the same answers always get the same result.
          </p>
          <p>
            {v.is_provisional
              ? 'A quick round only covers part of a full round, so this is the signal so far, not a final call.'
              : 'A full round covers every part of the interview.'}{' '}
            Confidence goes up with how much of the round you covered and how much evidence there is for each score.
          </p>
          {v.rationale && <p class="explain-why">{v.rationale}</p>}
        </div>
      )}
    </div>
  );
}

const OUTCOME: Record<NonNullable<MeetingDetails['outcome']>, { name: string; tone: 'up' | 'mid' | 'down'; step: number }> = {
  approved: { name: 'Approved', tone: 'up', step: 4 },
  approved_with_conditions: { name: 'Approved with conditions', tone: 'up', step: 3 },
  need_more_info: { name: 'Need more information', tone: 'mid', step: 2 },
  not_now: { name: 'Not now', tone: 'down', step: 1 },
};

const GOAL: Record<NonNullable<MeetingDetails['goal_reached']>, string> = {
  yes: 'Goal reached',
  partly: 'Goal partly reached',
  no: 'Goal not reached',
};

export function MeetingOutcome(props: { details: MeetingDetails; summary: string; overall: number | null | undefined }) {
  const d = props.details;
  const o = d.outcome ? OUTCOME[d.outcome] : null;
  return (
    <div class="verdict" data-test="meeting-outcome" data-outcome={d.outcome ?? 'none'}>
      <div class="verdict-top">
        <span class={`chip chip-${o?.tone ?? 'mid'}`} data-test="outcome-chip">
          <span class="chip-pre">Decision</span>
          <span class="chip-name">{o?.name ?? 'No decision'}</span>
        </span>
        {d.goal_reached && <span class="verdict-conf">{GOAL[d.goal_reached]}</span>}
        {props.overall != null && (
          <span class="verdict-conf">
            Overall <strong class="num">{props.overall.toFixed(1)}</strong> of 4
          </span>
        )}
      </div>
      <p class="verdict-summary">{props.summary}</p>
      {d.goal && (
        <p class="meeting-goal">
          <span class="muted">Your goal: </span>
          {d.goal}
        </p>
      )}
      {d.ask_made === false && (
        <p class="note-warn" data-test="no-ask">
          You never made a clear ask, so the room could not decide.
        </p>
      )}
      {d.stayed_above_walkaway === false && (
        <p class="note-warn" data-test="below-walkaway">
          You agreed to less than your walk away point.
        </p>
      )}
    </div>
  );
}
