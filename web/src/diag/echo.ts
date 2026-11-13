// The echo test run: a real Fish voice session (FishTransport) whose agent reads a passage aloud while the tester
// stays silent, then gets talked over. Levels come from the session's own mic track (no second capture, so the
// test hears exactly what Fish hears) and from the agent's audio. Scoring is in echoCounter.ts.

import type { Panelist, FishSession } from '../shared/types';
import { getAudioContext } from '../voice/audio';
import { FishTransport, type FishSessionLike, type FishStartOptions } from '../voice/fish';
import { EchoCounter, type EchoPhase, type EchoResults } from './echoCounter';
import { LevelMeter } from './probe';

export interface EchoVoice {
  transport: 'fish';
  fish: Record<string, unknown>;
}

export interface EchoRun {
  results: EchoResults | null;
  /** The settings of the mic track Fish captured with (echo cancellation and the rest). */
  fish_mic: Record<string, unknown> | null;
  /** How her voice reached the speakers: the SDK's audio element (the app's path), or WebAudio with a panner. */
  path: 'element' | 'positional';
  error: string | null;
  stopped_by: 'finished' | 'user' | 'no_speech' | 'ended' | 'error' | null;
}

export interface EchoUpdate {
  phase: EchoPhase | 'connecting';
  remaining_s: number;
  mic_db: number | null;
  heard: number;
}

type LocalRoom = {
  localParticipant?: { audioTrackPublications?: Map<string, { track?: { mediaStreamTrack?: MediaStreamTrack } }> };
};

function localMicTrack(session: FishSessionLike | null): MediaStreamTrack | null {
  const room = session?.getRoom() as LocalRoom | undefined;
  for (const pub of room?.localParticipant?.audioTrackPublications?.values() ?? []) {
    const t = pub.track?.mediaStreamTrack;
    if (t) return t;
  }
  return null;
}

/** The voice from POST /api/diag/echo as the panelist FishTransport expects (Fish's whole session response). */
export function echoPanelist(voice: EchoVoice): Panelist {
  const fish = voice.fish;
  return {
    panelist_id: 'diag',
    persona_id: 'persona.diag',
    display_name: 'Sound check',
    title: '',
    avatar_id: '',
    seat: 0,
    voice: { transport: 'fish', fish: fish as unknown as FishSession },
  };
}

/** Stops the run when the agent never starts speaking. */
const NO_SPEECH_MS = 20000;

export class EchoTest {
  readonly run: EchoRun = { results: null, fish_mic: null, path: 'element', error: null, stopped_by: null };
  private panner: { src: MediaStreamAudioSourceNode; node: PannerNode } | null = null;
  private transport: FishTransport | null = null;
  private session: FishSessionLike | null = null;
  private meters: LevelMeter[] = [];
  private agentMetered = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private counter: EchoCounter | null = null;
  private finished: Promise<EchoRun> | null = null;
  private finish: ((r: EchoRun) => void) | null = null;
  private micDb: number | null = null;

  constructor(private readonly onUpdate: (u: EchoUpdate) => void) {}

  /** Runs the whole test; resolves when it ends (finished, stopped or failed). */
  start(voice: EchoVoice, opts: { positional?: boolean } = {}): Promise<EchoRun> {
    if (this.finished) return this.finished;
    this.run.path = opts.positional ? 'positional' : 'element';
    this.finished = new Promise((res) => (this.finish = res));
    void this.go(voice);
    return this.finished;
  }

  stop(): void {
    void this.end('user');
  }

  private async go(voice: EchoVoice): Promise<void> {
    const t0 = performance.now();
    const c = new EchoCounter(t0);
    this.counter = c;
    this.onUpdate({ phase: 'connecting', remaining_s: 0, mic_db: null, heard: 0 });
    const start = async (opts: FishStartOptions): Promise<FishSessionLike> => {
      const { AgentSession } = await import('@fishaudio/agent-client');
      const s: FishSessionLike = await AgentSession.start(opts);
      this.session = s;
      return s;
    };
    const tr = new FishTransport(echoPanelist(voice), { start });
    this.transport = tr;
    tr.on('mode', (m) => c.mode(m, performance.now()));
    tr.on('agentText', (e) => c.agentText(performance.now(), e.text));
    tr.on('userTranscript', (e) => c.user(e.segmentId, e.text, e.final, performance.now()));
    tr.on('ended', () => void this.end('ended'));
    tr.on('error', (e) => {
      this.run.error = `${e.code}: ${e.message}`.slice(0, 200);
      if (e.code !== 'audio_blocked') void this.end('error');
    });
    try {
      await getAudioContext()?.resume();
      await tr.start();
      await tr.startAudio().catch(() => undefined);
    } catch (e) {
      this.run.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      await this.end('error');
      return;
    }
    c.connected(performance.now());
    const mic = localMicTrack(this.session);
    if (mic) this.run.fish_mic = { ...(mic.getSettings() as Record<string, unknown>), deviceId: undefined, groupId: undefined };
    const ctx = getAudioContext();
    if (ctx && mic) {
      this.meters.push(
        new LevelMeter(ctx, new MediaStream([mic]), (db, t) => {
          this.micDb = db;
          c.micLevel(db, t);
        }),
      );
    }
    this.timer = setInterval(() => {
      const now = performance.now();
      // The agent's track appears once it publishes; meter it from then on.
      if (this.run.path === 'positional' && ctx) this.positional(ctx, tr);
      const out = ctx && !this.agentMetered ? tr.outputStream() : null;
      if (ctx && out) {
        this.agentMetered = true;
        this.meters.push(new LevelMeter(ctx, out, (db, t) => c.agentLevel(db, t)));
      }
      c.tick(now);
      const r = c.results(now);
      this.onUpdate({ phase: c.phase, remaining_s: Math.ceil(c.remainingMs(now) / 1000), mic_db: this.micDb, heard: r.silent.user_segments });
      if (c.phase === 'done') void this.end('finished');
      else if (c.phase === 'waiting' && now - t0 > NO_SPEECH_MS) void this.end('no_speech');
    }, 250);
  }

  /**
   * The positional path: her track through a panner (1 m ahead, a little to the right, as a seat) to the speakers,
   * with the SDK's own audio elements muted. Chromium's echo canceller does not see WebAudio output, which is what
   * this run measures.
   */
  private positional(ctx: AudioContext, tr: FishTransport): void {
    const room = this.session?.getRoom() as
      | { remoteParticipants?: Map<string, { trackPublications: Map<string, { track?: { attachedElements?: HTMLMediaElement[] } }> }> }
      | undefined;
    for (const p of room?.remoteParticipants?.values() ?? []) for (const pub of p.trackPublications.values()) for (const el of pub.track?.attachedElements ?? []) el.muted = true;
    if (this.panner) return;
    const out = tr.outputStream();
    if (!out) return;
    const src = ctx.createMediaStreamSource(out);
    const node = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, positionX: 0.4, positionY: 0, positionZ: -1 });
    src.connect(node).connect(ctx.destination);
    this.panner = { src, node };
  }

  private async end(why: NonNullable<EchoRun['stopped_by']>): Promise<void> {
    if (this.run.stopped_by) return;
    this.run.stopped_by = why;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const m of this.meters) m.stop();
    this.panner?.src.disconnect();
    this.panner?.node.disconnect();
    this.panner = null;
    this.meters = [];
    if (this.counter) this.run.results = this.counter.results(performance.now());
    const tr = this.transport;
    this.transport = null;
    await tr?.stop().catch(() => undefined);
    this.finish?.(this.run);
  }
}
