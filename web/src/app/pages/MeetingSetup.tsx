// Meeting setup: pick a template (or custom), check who is in the room and what you want, then
// Prepare. Preparing fills in likely objections; keep or drop them, then Start. The investor
// pitch comes pre-filled, so it is one tap to prepare.

import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';
import { api } from '../../net/api';
import type {
  Attendee,
  Catalog,
  DecisionPower,
  Length,
  Me,
  MeetingDifficulty,
  MeetingSetup as Setup,
  MeetingTemplate,
  MeetingTemplateId,
  Personality,
  PrepareMeetingRes,
  Style,
} from '../../shared/types';
import { PERSONALITIES } from '../../shared/types';
import { CapNotice } from '../components/CapNotice';
import { capFromError, capFromMe, loadCatalog, loadMe, toApiError, useAsync } from '../components/data';
import { ReadyPanel, useHeadset, useMic, type Mic, type XrState } from '../components/Ready';
import { Disclosure, ErrorState, Loading, Monogram, Page, Segmented } from '../components/Ui';
import { voiceChoice } from '../voiceChoice';

const MAX_PEOPLE = 3;
const MAX_FACTS = 8;

interface Person {
  name: string;
  role: string;
  cares: string;
  personality: Personality;
  power: DecisionPower;
  objections: string;
  knows?: string;
  voice_base?: string;
}

interface Draft {
  template: MeetingTemplateId | 'custom';
  goal: string;
  userRole: string;
  people: Person[];
  length: Length;
  difficulty: MeetingDifficulty;
  facts: string;
  ask: string;
  walkAway: string;
  notes: string;
}

const PERSONALITY_NAMES: Record<Personality, string> = {
  supportive: 'Supportive',
  neutral: 'Neutral',
  skeptical: 'Skeptical',
  hostile: 'Hostile',
};

const POWER_NAMES: Record<DecisionPower, string> = { approver: 'Decides', influencer: 'Has a say', observer: 'Listens' };

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

const blankPerson = (): Person => ({ name: '', role: '', cares: '', personality: 'neutral', power: 'influencer', objections: '' });

export function draftFrom(t: MeetingTemplate | null): Draft {
  if (!t) {
    return {
      template: 'custom',
      goal: '',
      userRole: '',
      people: [{ ...blankPerson(), power: 'approver' }],
      length: 'short',
      difficulty: 'realistic',
      facts: '',
      ask: '',
      walkAway: '',
      notes: '',
    };
  }
  return {
    template: t.id,
    goal: t.goal,
    userRole: t.your_role,
    people: t.attendees.map((a) => ({
      name: a.name,
      role: a.role,
      cares: a.cares_about.join(', '),
      personality: a.personality,
      power: a.decision_power ?? 'influencer',
      objections: (a.likely_objections ?? []).join('\n'),
      knows: a.knows,
      voice_base: a.voice_base,
    })),
    length: t.length ?? 'short',
    difficulty: t.difficulty ?? 'realistic',
    facts: (t.key_facts ?? []).map((f) => `${f.label}: ${f.value}`).join('\n'),
    ask: t.ask ?? '',
    walkAway: t.walk_away ?? '',
    notes: '',
  };
}

export function toSetup(d: Draft): Setup {
  const attendees: Attendee[] = d.people
    .filter((p) => p.name.trim() && p.role.trim())
    .map((p) => {
      const a: Attendee = {
        name: p.name.trim(),
        role: p.role.trim(),
        cares_about: p.cares
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 5),
        personality: p.personality,
        decision_power: p.power,
      };
      const obj = lines(p.objections).slice(0, 5);
      if (obj.length) a.likely_objections = obj;
      if (p.knows) a.knows = p.knows;
      if (p.voice_base) a.voice_base = p.voice_base;
      return a;
    });
  const setup: Setup = {
    template_id: d.template === 'custom' ? null : d.template,
    goal: d.goal.trim(),
    user_role: d.userRole.trim() || 'Me',
    attendees,
    length: d.length,
    difficulty: d.difficulty,
  };
  const facts = lines(d.facts).slice(0, MAX_FACTS);
  if (facts.length) setup.key_facts = facts;
  if (d.ask.trim()) setup.ask = d.ask.trim();
  if (d.walkAway.trim()) setup.walk_away = d.walkAway.trim();
  if (d.notes.trim()) setup.notes = d.notes.trim();
  return setup;
}

export interface SetupErrors {
  goal?: string;
  people?: string;
}

export function validate(d: Draft): SetupErrors {
  const e: SetupErrors = {};
  if (!d.goal.trim()) e.goal = 'Say in one line what you want from this meeting.';
  if (!d.people.some((p) => p.name.trim() && p.role.trim())) e.people = 'Add at least one person, with a name and a role.';
  return e;
}

// ---------- Editing ----------

function PersonCard(props: { p: Person; i: number; onChange: (p: Person) => void; onRemove?: () => void; invalid?: boolean }) {
  const { p, i } = props;
  const set = <K extends keyof Person>(k: K, v: Person[K]) => props.onChange({ ...p, [k]: v });
  const id = (f: string) => `p${i}-${f}`;
  return (
    <li class="person" data-test="attendee">
      <div class="person-top">
        <Monogram name={p.name || '?'} />
        <div class="person-names">
          <label class="mini">
            <span>Name</span>
            <input
              id={id('name')}
              value={p.name}
              maxLength={24}
              onInput={(e) => set('name', e.currentTarget.value)}
              aria-invalid={props.invalid ? 'true' : undefined}
              aria-describedby={props.invalid ? 'people-err' : undefined}
              data-test="attendee-name"
            />
          </label>
          <label class="mini">
            <span>Role</span>
            <input id={id('role')} value={p.role} maxLength={48} onInput={(e) => set('role', e.currentTarget.value)} data-test="attendee-role" />
          </label>
        </div>
        {props.onRemove && (
          <button type="button" class="btn btn-quiet btn-small" onClick={props.onRemove} data-test="attendee-remove" aria-label={`Remove ${p.name || 'this person'}`}>
            Remove
          </button>
        )}
      </div>
      <label class="mini">
        <span>Cares about</span>
        <input value={p.cares} placeholder="Budget, timeline, risk" onInput={(e) => set('cares', e.currentTarget.value)} />
      </label>
      <Segmented<Personality>
        name={id('personality')}
        legend="Personality"
        value={p.personality}
        onChange={(v) => set('personality', v)}
        choices={PERSONALITIES.map((x) => ({ value: x, label: PERSONALITY_NAMES[x] }))}
        test="attendee-personality"
      />
      <Segmented<DecisionPower>
        name={id('power')}
        legend="In the decision"
        value={p.power}
        onChange={(v) => set('power', v)}
        choices={(['approver', 'influencer', 'observer'] as const).map((x) => ({ value: x, label: POWER_NAMES[x] }))}
      />
      <label class="mini">
        <span>Likely objections, one per line</span>
        <textarea rows={2} value={p.objections} placeholder="Leave empty and we will suggest some" onInput={(e) => set('objections', e.currentTarget.value)} />
      </label>
    </li>
  );
}

function TemplatePicker(props: { catalog: Catalog; value: Draft['template']; onPick: (t: MeetingTemplate | null) => void }) {
  const opts = [...props.catalog.meeting_templates.map((t) => ({ id: t.id as Draft['template'], title: t.title, line: t.summary, t })), { id: 'custom' as const, title: 'Your own meeting', line: 'Describe the people and the goal yourself.', t: null }];
  return (
    <fieldset class="templates" data-test="templates">
      <legend class="sr-only">Meeting type</legend>
      {opts.map((o) => (
        <label class={`tpl${props.value === o.id ? ' tpl-on' : ''}`} key={o.id}>
          <input type="radio" name="template" value={o.id} checked={props.value === o.id} onChange={() => props.onPick(o.t)} data-test={`template-${o.id}`} />
          <span class="tpl-title">{o.title}</span>
          <span class="tpl-line">{o.line}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---------- Prepared ----------

function Prepared(props: {
  res: PrepareMeetingRes;
  draft: Draft;
  me?: Me;
  onEdit: () => void;
  onReprepare: (kept: string[][]) => void;
  busy: boolean;
  error: ComponentChildren;
  mic: Mic;
  xr: XrState;
}) {
  const { plan } = props.res;
  const [kept, setKept] = useState<boolean[][]>(() => plan.attendees.map((a) => (a.likely_objections ?? []).map(() => true)));
  const changed = kept.some((row) => row.some((k) => !k));
  const { mic, xr } = props;
  const cap = capFromMe(props.me, props.draft.length);
  const style: Style = props.draft.difficulty === 'friendly' ? 'warm' : props.draft.difficulty === 'tough' ? 'tough' : 'neutral';

  return (
    <div class="prepared" data-test="prepared">
      <div class="prepared-head">
        <p class="note">
          {plan.user_chairs ? 'You run this meeting.' : `${plan.chair_attendee ?? 'The chair'} opens: “${plan.opening_line}”`}
        </p>
        <button type="button" class="btn btn-quiet btn-small" onClick={props.onEdit} data-test="edit-setup">
          Edit the setup
        </button>
      </div>

      <h2 class="section-title">They will likely push on</h2>
      <p class="rsec-lede">Untick what would not come up.</p>
      <ul class="people-plan">
        {plan.attendees.map((a, i) => (
          <li key={a.name} class="person-plan" data-test="plan-attendee">
            <p class="person-head">
              <Monogram name={a.name} size="sm" />
              <span>
                <strong>{a.name}</strong>
                <span class="muted">, {a.role}</span>
              </span>
            </p>
            <ul class="objs">
              {(a.likely_objections ?? []).map((o, j) => (
                <li key={j}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={kept[i]?.[j] ?? true}
                      onChange={(e) => {
                        const v = e.currentTarget.checked;
                        setKept((k) => k.map((row, x) => (x === i ? row.map((c, y) => (y === j ? v : c)) : row)));
                      }}
                      data-test="objection-keep"
                    />
                    <span>{o}</span>
                  </label>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {changed && (
        <div class="row">
          <button
            type="button"
            class="btn"
            disabled={props.busy}
            onClick={() => props.onReprepare(plan.attendees.map((a, i) => (a.likely_objections ?? []).filter((_, j) => kept[i]?.[j] ?? true)))}
            data-test="apply-objections"
          >
            {props.busy ? 'Updating the room' : 'Update the room'}
          </button>
          <span class="fine">Start uses the room once it is updated.</span>
        </div>
      )}

      {plan.tips.length > 0 && (
        <div class="tips">
          <h2 class="section-title">How to win this meeting</h2>
          <ul class="checks">
            {plan.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      <ReadyPanel
        mic={mic}
        xr={xr}
        questUrl={`${location.origin}/meeting/new${props.draft.template === 'custom' ? '' : `?template=${props.draft.template}`}`}
        questNote={props.draft.template === 'custom' ? 'It opens a new setup: your people and goal stay on this device.' : 'It opens the same template. Your edits stay on this device.'}
        busy={props.busy || changed}
        error={props.error}
        me={props.me}
        title="Meeting rehearsal"
        enterLabel={xr === 'none' ? 'Preview on this screen' : 'Enter the meeting room'}
        blocked={cap ? <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} /> : undefined}
        input={{
          kind: 'new',
          req: {
            mode: 'meeting',
            meeting_plan_id: props.res.meeting_plan_id,
            length: props.draft.length,
            level: props.me?.settings.default_level ?? 'mid',
            style,
            voice: voiceChoice(),
          },
        }}
      />
    </div>
  );
}

// ---------- Page ----------

function SetupForm(props: { catalog: Catalog; me?: Me }) {
  const { query } = useLocation();
  const wanted = query.template ?? 'investor_pitch';
  const first =
    props.catalog.meeting_templates.find((t) => t.id === wanted) ??
    props.catalog.meeting_templates.find((t) => t.id === 'investor_pitch') ??
    props.catalog.meeting_templates[0] ??
    null;
  const [d, setD] = useState<Draft>(() => draftFrom(first));
  const [errors, setErrors] = useState<SetupErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [res, setRes] = useState<PrepareMeetingRes | null>(null);
  const [version, setVersion] = useState(0);
  // Kept here so the mic stays on when the room is updated and the plan view remounts.
  const mic = useMic();
  const xr = useHeadset(new URLSearchParams(location.search).get('preview') === '1');
  const [editing, setEditing] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const tpl = props.catalog.meeting_templates.find((t) => t.id === d.template);

  const prepare = async (setup: Setup) => {
    setBusy(true);
    setFailure(null);
    try {
      setRes(await api.prepareMeeting(setup));
      setVersion((v) => v + 1);
      setEditing(false);
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  };

  const onPrepare = (e: Event) => {
    e.preventDefault();
    const errs = validate(d);
    setErrors(errs);
    if (errs.goal || errs.people) {
      setEditing(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    void prepare(toSetup(d));
  };

  const cap = failure ? capFromError(failure) : null;
  const failureView = failure ? (
    cap ? (
      <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} />
    ) : (
      <ErrorState error={toApiError(failure)} onRetry={() => setFailure(null)} />
    )
  ) : null;

  if (res && !editing) {
    return (
      <Prepared
        key={version}
        mic={mic}
        xr={xr}
        res={res}
        draft={d}
        me={props.me}
        busy={busy}
        error={failureView}
        onEdit={() => setEditing(true)}
        onReprepare={(kept) => {
          const setup = toSetup(d);
          setup.attendees = setup.attendees.map((a, i) => ({ ...a, likely_objections: kept[i] ?? a.likely_objections }));
          void prepare(setup);
        }}
      />
    );
  }

  const isCustom = d.template === 'custom';
  return (
    <form class="setup" onSubmit={onPrepare} noValidate data-test="setup-form">
      <TemplatePicker
        catalog={props.catalog}
        value={d.template}
        onPick={(t) => {
          setD(draftFrom(t));
          setErrors({});
          if (!t) setEditing(true);
        }}
      />

      {tpl && (
        <p class="scenario" data-test="scenario">
          {tpl.scenario}
        </p>
      )}

      <div class={`field${errors.goal ? ' field-bad' : ''}`}>
        <label for="goal">What do you want from this meeting?</label>
        <input
          id="goal"
          value={d.goal}
          maxLength={200}
          placeholder="Approval for a six week pilot"
          aria-invalid={errors.goal ? 'true' : undefined}
          aria-describedby={errors.goal ? 'goal-err' : undefined}
          onInput={(e) => set('goal', e.currentTarget.value)}
          data-test="goal"
        />
        {errors.goal && (
          <p class="field-err" id="goal-err" data-test="goal-error">
            {errors.goal}
          </p>
        )}
      </div>

      <div class="room-line" data-test="room-line">
        {d.people
          .filter((p) => p.name)
          .map((p) => (
            <span class="room-person" key={p.name}>
              <Monogram name={p.name} size="sm" />
              <span>
                <strong>{p.name}</strong> <span class="muted">{p.role}</span>
              </span>
            </span>
          ))}
      </div>

      <Disclosure test="edit-people" open={isCustom || editing || !!errors.people} summary="Edit the people in the room">
        <div class={`field${errors.people ? ' field-bad' : ''}`}>
          <label for="user-role">Your role</label>
          <input id="user-role" value={d.userRole} maxLength={80} placeholder="Founder" onInput={(e) => set('userRole', e.currentTarget.value)} />
        </div>
        {errors.people && (
          <p class="field-err" id="people-err" data-test="people-error" role="alert">
            {errors.people}
          </p>
        )}
        <ul class="people-edit">
          {d.people.map((p, i) => (
            <PersonCard
              key={i}
              p={p}
              i={i}
              invalid={i === 0 && !!errors.people}
              onChange={(np) => set('people', d.people.map((x, j) => (j === i ? np : x)))}
              onRemove={d.people.length > 1 ? () => set('people', d.people.filter((_, j) => j !== i)) : undefined}
            />
          ))}
        </ul>
        {d.people.length < MAX_PEOPLE && (
          <button type="button" class="btn btn-small" onClick={() => set('people', [...d.people, blankPerson()])} data-test="attendee-add">
            Add a person
          </button>
        )}
      </Disclosure>

      <Disclosure test="add-detail" summary="Add detail">
        <Segmented<Length>
          name="m-length"
          legend="Length"
          value={d.length}
          onChange={(v) => set('length', v)}
          choices={[
            { value: 'short', label: 'Short, 8 min' },
            { value: 'full', label: 'Full, 20 min' },
          ]}
        />
        <Segmented<MeetingDifficulty>
          name="m-difficulty"
          legend="How hard"
          value={d.difficulty}
          onChange={(v) => set('difficulty', v)}
          choices={[
            { value: 'friendly', label: 'Friendly' },
            { value: 'realistic', label: 'Realistic' },
            { value: 'tough', label: 'Tough' },
          ]}
        />
        <div class="field">
          <label for="facts">Key numbers and facts, one per line</label>
          <textarea id="facts" rows={4} value={d.facts} onInput={(e) => set('facts', e.currentTarget.value)} placeholder="Budget: 40,000 dollars" />
          <p class="field-hint">They will question these and hold you to them. Up to {MAX_FACTS}.</p>
        </div>
        <div class="field">
          <label for="ask">What you will ask for</label>
          <input id="ask" value={d.ask} onInput={(e) => set('ask', e.currentTarget.value)} />
        </div>
        <div class="field">
          <label for="walk">Your walk away point</label>
          <input id="walk" value={d.walkAway} onInput={(e) => set('walkAway', e.currentTarget.value)} placeholder="Optional, for negotiations" />
        </div>
        <div class="field">
          <label for="notes">Notes, agenda or slide text</label>
          <textarea id="notes" rows={4} maxLength={8000} value={d.notes} onInput={(e) => set('notes', e.currentTarget.value)} />
        </div>
      </Disclosure>

      {failureView}

      <div class="start-row">
        <button type="submit" class="btn btn-primary btn-big" disabled={busy} data-test="prepare">
          {busy ? 'Preparing the room' : 'Prepare the room'}
        </button>
        <p class="fine">{busy ? 'A few seconds.' : 'Next: what they will push on.'}</p>
      </div>
    </form>
  );
}

export function MeetingSetup() {
  const catalog = useAsync(() => loadCatalog(), []);
  const me = useAsync(() => loadMe(), []);
  return (
    <Page test="meeting" title="Rehearse a real meeting" lede="Who is there, and what you want from them." back={{ href: '/start', label: 'All rounds' }}>
      {catalog.status === 'loading' && <Loading rows={5} />}
      {catalog.status === 'error' && <ErrorState error={catalog.error} onRetry={catalog.reload} />}
      {catalog.status === 'ready' && <SetupForm catalog={catalog.data} me={me.data} />}
    </Page>
  );
}
