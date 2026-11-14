// The panel: one voice transport per AI person, and the floor (who may hear the user).
//
// - swap (default): only the floor panelist is connected. A hand-over joins the new panelist's
//   voice at once, while the outgoing one still says its hand-off sentence: the server mints it
//   silent (no first message, nothing recorded) and it connects muted. From that moment nobody
//   hears the user. Once the outgoing voice is quiet (and the round is not paused), the new one
//   gets `[event: handover]` (the server answers with the prepared line, no model call), its mic
//   opens and the old one stops. So the gap between the two is only the new voice's own speech
//   start, and there is never a moment with two voices or with nobody in the room.
// - joined: everyone is connected from the start; only the floor has the mic. A hand-over moves
//   the mic and sends the new floor `[event: handover]` so it speaks its prepared line.

import { api as defaultApi, type Api } from '../net/api';
import { VOICE_MARKERS, type CreateSessionRes, type Panelist } from '../shared/types';
import { VoiceError, type TransportOptions, type VoiceTransport } from './transport';

export type MakeTransport = (p: Panelist, opts?: TransportOptions) => VoiceTransport;

export interface PanelOptions {
  api?: Pick<Api, 'joinPanelist'>;
  /**
   * Resolves once this transport's agent is not speaking (or after a short cap), so a hand-over
   * never cuts the outgoing panelist mid-sentence or overlaps two voices.
   */
  waitQuiet?: (t: VoiceTransport) => Promise<void>;
  /** Resolves when a hand-over may take the floor now: at once while the round runs, on Resume while it is paused. */
  ready?: () => Promise<void>;
}

export class PanelController {
  private readonly transports = new Map<string, VoiceTransport>();
  private readonly panel: Map<string, Panelist>;
  private readonly api: Pick<Api, 'joinPanelist'>;
  private readonly waitQuiet: (t: VoiceTransport) => Promise<void>;
  private readonly ready: () => Promise<void>;
  private floorId: string;
  private muted = false;
  /** A swap is under way: the outgoing floor no longer hears the user. */
  private swapping = false;
  /** The voice joining in a swap, connected and muted, before it takes the floor. */
  private incoming: VoiceTransport | null = null;
  /** Bumped when hand-overs are called off: the one under way drops its new voice, queued ones never run. */
  private epoch = 0;
  /** Set by stopAll(): anything still connecting is stopped as soon as it is up. */
  private stopped = false;
  /** Hand-overs run one at a time, in arrival order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly res: CreateSessionRes,
    private readonly make: MakeTransport,
    opts: PanelOptions = {},
  ) {
    this.panel = new Map(res.panel.map((p) => [p.panelist_id, p]));
    this.floorId = res.floor;
    this.api = opts.api ?? defaultApi;
    this.waitQuiet = opts.waitQuiet ?? (async () => undefined);
    this.ready = opts.ready ?? (async () => undefined);
  }

  get floor(): string {
    return this.floorId;
  }

  get mode(): CreateSessionRes['panel_mode'] {
    return this.res.panel_mode;
  }

  /** True while a swap is under way (the new voice joins; nobody hears the user). */
  get isSwapping(): boolean {
    return this.swapping;
  }

  /** The floor panelist's transport. */
  current(): VoiceTransport | undefined {
    return this.transports.get(this.floorId);
  }

  get(panelistId: string): VoiceTransport | undefined {
    return this.transports.get(panelistId);
  }

  all(): VoiceTransport[] {
    return [...this.transports.values()];
  }

  async start(): Promise<void> {
    const ids = this.res.panel_mode === 'joined' ? [...this.panel.keys()] : [this.floorId];
    await Promise.all(
      ids.map(async (id) => {
        const p = await this.withVoice(id);
        if (this.stopped) return;
        const t = this.make(p);
        // Only the floor may hear the user, from the first moment on.
        if (this.muted || id !== this.floorId) t.setMicMuted(true);
        this.transports.set(id, t);
        await t.start();
        if (this.stopped) await t.stop();
      }),
    );
    if (!this.stopped) void this.applyGating();
  }

  /** The prepared line is the server's: the browser only says who takes the floor. */
  handOver(to: string): Promise<void> {
    const epoch = this.epoch;
    const run = this.queue.then(() => (epoch === this.epoch ? this.doHandOver(to, epoch) : undefined));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Calls off the hand-overs under way and queued (the round is ending): the outgoing panelist
   * keeps the floor and hears the user again, a joining voice is stopped before it ever speaks.
   */
  cancelHandOvers(): void {
    this.epoch++;
    if (!this.swapping) return;
    this.swapping = false;
    const t = this.incoming;
    this.incoming = null;
    if (t) void t.stop().catch(() => undefined);
    if (!this.stopped) void this.applyGating();
  }

  /** true: nobody hears the user (pause, mute). false: the floor hears again, unless a swap is under way. */
  muteAll(muted: boolean): Promise<void> {
    this.muted = muted;
    return this.applyGating();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const ts = this.all();
    if (this.incoming) ts.push(this.incoming);
    this.incoming = null;
    this.transports.clear();
    await Promise.allSettled(ts.map((t) => t.stop()));
  }

  // ---------- internals ----------

  private async doHandOver(to: string, epoch: number): Promise<void> {
    if (this.stopped || to === this.floorId || !this.panel.has(to)) return;
    const oldId = this.floorId;
    const old = this.transports.get(oldId);
    const off = () => this.stopped || epoch !== this.epoch;

    if (this.res.panel_mode === 'joined') {
      // Let the outgoing panelist finish its hand-off sentence first.
      if (old) await this.waitQuiet(old);
      await this.ready();
      if (off()) return;
      const next = this.transports.get(to);
      if (!next) throw new Error(`panelist ${to} is not connected`);
      this.floorId = to;
      void this.applyGating();
      next.sendEvent(VOICE_MARKERS.handover);
      return;
    }

    // Swap. From here on the outgoing panelist only finishes its sentence: it never hears the user again.
    this.swapping = true;
    void this.applyGating();
    const slot: { t: VoiceTransport | null; ended: boolean } = { t: null, ended: false };
    const joining = async () => {
      const { voice } = await this.api.joinPanelist(this.res.session_id, to, { deferred: true, from: oldId });
      if (off()) return;
      const p = { ...this.panel.get(to)!, voice };
      this.panel.set(to, p);
      const t = this.make(p);
      slot.t = t;
      this.incoming = t;
      t.setMicMuted(true);
      t.on('ended', () => void (slot.ended = true));
      await t.start();
    };
    // Whether the outgoing voice was quiet before the new one was up: it may have begun its sentence since.
    let joined = false;
    let quietFirst = false;
    try {
      // The new voice joins and connects while the outgoing one says its last sentence.
      await Promise.all([
        joining().then(() => void (joined = true)),
        old ? this.waitQuiet(old).then(() => void (quietFirst = !joined)) : undefined,
      ]);
      // A sentence the outgoing voice only started after its first wait is let to finish too (once, bounded).
      if (!off() && old && quietFirst) await this.waitQuiet(old);
      // A pause holds the swap until Resume; the new voice waits there, muted and silent. Nothing is awaited
      // between this and the switch, so a pause can never land in between.
      if (!off()) await this.ready();
    } catch (err) {
      this.dropIncoming(epoch, slot.t);
      if (off()) return;
      throw err;
    }
    const next = slot.t;
    if (off() || !next || slot.ended) {
      this.dropIncoming(epoch, next);
      if (off() || !next) return;
      throw new VoiceError('handover_failed', `the voice of ${to} ended before it took the floor`);
    }
    // The outgoing voice is quiet: the new one opens with its prepared line, then hears the user.
    this.incoming = null;
    this.transports.delete(oldId);
    this.transports.set(to, next);
    this.floorId = to;
    this.swapping = false;
    next.sendEvent(VOICE_MARKERS.handover);
    void this.applyGating();
    if (old) await old.stop();
  }

  /** A swap that did not happen: its new voice stops, and the floor it left hears the user again. */
  private dropIncoming(epoch: number, t: VoiceTransport | null): void {
    if (t) void t.stop().catch(() => undefined);
    if (this.incoming === t) this.incoming = null;
    if (epoch !== this.epoch) return; // called off: cancelHandOvers() already put the floor back
    this.swapping = false;
    if (!this.stopped) void this.applyGating();
  }

  /** Joined mode connects everyone, so a panelist whose voice is still pending joins now. */
  private async withVoice(id: string): Promise<Panelist> {
    const p = this.panel.get(id);
    if (!p) throw new Error(`unknown panelist ${id}`);
    if (p.voice.transport !== 'fish_pending') return p;
    const { voice } = await this.api.joinPanelist(this.res.session_id, id, {});
    const ready = { ...p, voice };
    this.panel.set(id, ready);
    return ready;
  }

  /** Resolves once every transport has applied its gate. */
  private applyGating(): Promise<void> {
    const done: (void | Promise<void>)[] = [];
    for (const [id, t] of this.transports) done.push(t.setMicMuted(this.muted || this.swapping || id !== this.floorId));
    return Promise.all(done).then(() => undefined);
  }
}
