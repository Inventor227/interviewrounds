// What the user sees of a voice's replies. The voice service sometimes starts a reply at a thinking pause and the
// candidate's next words stop it within a few milliseconds: nothing is heard, but the voice still reports
// "speaking" and the reply's first word. A reply is shown (its caption, and the avatar's speaking pose) only once it
// is real: its audio is audible, or it has stayed "speaking" for SPEAK_SHOW_MS. A reply that stops before that
// leaves nothing on screen. Lip sync reads the audio itself and is not gated; nor is anything sent to the server.
//
//   const gate = speakGate(transport);
//   gate.on('show', () => avatar.setMode('speaking'));
//   gate.on('text', (e) => captions.set(e.text));

import { Emitter, type AgentText, type VoiceTransport } from './transport';

/** A reply still "speaking" after this long is shown, audible or not. */
export const SPEAK_SHOW_MS = 200;
/** Output level (0..1) that counts as audible. Silence and a cut-off fragment stay under 0.005. */
export const AUDIBLE_LEVEL = 0.02;
/** How often the output level is read while a reply waits to be shown. */
export const LEVEL_POLL_MS = 25;

export interface SpeakGateEvents {
  /** The current reply is shown: the avatar may take its speaking pose. */
  show: () => void;
  /** Reply text the user may see (immediately once the reply is shown; held until then). */
  text: (e: AgentText) => void;
}

export class SpeakGate {
  private readonly events = new Emitter<SpeakGateEvents>();
  private open = false;
  private shown = false;
  private segment: string | null = null;
  private pending: AgentText | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Replies that stopped before they were shown: their late words are not shown either. */
  private readonly dropped = new Set<string>();

  constructor(private readonly t: VoiceTransport) {
    t.on('mode', (m) => (m === 'speaking' ? this.speaking() : this.quiet()));
    t.on('agentText', (e) => this.text(e));
    t.on('ended', () => this.quiet());
  }

  on<K extends keyof SpeakGateEvents>(event: K, cb: SpeakGateEvents[K]): () => void {
    return this.events.on(event, cb);
  }

  /** True while a reply is speaking and shown. */
  get isShown(): boolean {
    return this.open && this.shown;
  }

  private speaking(): void {
    if (this.open) return;
    this.open = true;
    this.shown = false;
    this.segment = null;
    this.pending = null;
    this.timer = setTimeout(() => this.reveal(), SPEAK_SHOW_MS);
    if (this.t.outputLevel) {
      this.poll = setInterval(() => {
        if ((this.t.outputLevel?.() ?? 0) >= AUDIBLE_LEVEL) this.reveal();
      }, LEVEL_POLL_MS);
    }
  }

  private reveal(): void {
    if (!this.open || this.shown) return;
    this.shown = true;
    this.stopTimers();
    this.events.emit('show');
    const p = this.pending;
    this.pending = null;
    if (p) this.events.emit('text', p);
  }

  private quiet(): void {
    if (this.open && !this.shown && this.segment) this.dropped.add(this.segment);
    this.open = false;
    this.shown = false;
    this.pending = null;
    this.stopTimers();
  }

  private text(e: AgentText): void {
    if (this.dropped.has(e.segmentId)) return;
    if (this.open && !this.shown) {
      this.segment = e.segmentId;
      this.pending = e; // the latest text of the reply is all a caption needs
      return;
    }
    this.events.emit('text', e);
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
  }
}

const gates = new WeakMap<VoiceTransport, SpeakGate>();

/** The one gate of a transport (the captions and the controller see the same replies). */
export function speakGate(t: VoiceTransport): SpeakGate {
  let g = gates.get(t);
  if (!g) {
    g = new SpeakGate(t);
    gates.set(t, g);
  }
  return g;
}
