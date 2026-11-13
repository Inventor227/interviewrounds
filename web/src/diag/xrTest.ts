// The XR part of the device check, in the real room: passthrough, desk placement, three seated avatars and the
// desk sheet. Measures time to the first XR frame, the session's features and frame rates, 20 s of frame times at
// 72 Hz and 10 s at 90 Hz (when offered), then runs the hand tests (handFlow.ts) on the sheet and exits on Done.

import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, SRGBColorSpace, type Object3D } from 'three';
import { HandAdapter } from '../board/hand';
import { SHEET } from '../board/model';
import { boardToLocal, SurfaceProjector, sheetToWorld } from '../board/sheetMath';
import type { XRApp } from '../xr/world';
import { DONE_BOX, HandFlow, HOLD_AT, LINE_FROM, LINE_TO, SKIP_BOX, TARGET_R, TARGETS, type HandResults } from './handFlow';
import { frameStats, PinchCounter, selectRatio, type FrameStats, type P2 } from './stats';

export const FRAMES_72_MS = 20000;
export const FRAMES_90_MS = 10000;
/** Frames right after a rate change or placement are left out. */
const SETTLE_MS = 1500;

export type XrStage = 'idle' | 'entering' | 'placing' | 'frames72' | 'frames90' | 'hands' | 'done' | 'ended' | 'failed';

export interface XrResults {
  error: string | null;
  tap_to_first_frame_ms: number | null;
  enabled_features: string[] | null;
  supported_frame_rates: number[] | null;
  start_frame_rate: number | null;
  placement: { source: string; ms: number } | null;
  frames_72: FrameStats | null;
  frames_90: FrameStats | null;
  rate_90: { tried: boolean; ok: boolean | null; frame_rate_after: number | null; error: string | null };
  render: { calls: number; triangles: number; textures: number; programs: number; multiview: boolean; views: number } | null;
  hands: HandResults | null;
  selects: { starts: number; ends: number; cancels: number };
  finger_pinches: number;
  select_per_pinch: number | null;
  /** Share of frames in the hand tests with each hand tracked (percent). */
  tracked_pct: { left: number; right: number } | null;
  controllers_seen: boolean;
  /** What the user was using at the end of the run, and how often they changed between hands and controllers. */
  input: { active: 'hands' | 'controllers'; changes: number };
  visibility: string[];
  ended_by: 'done' | 'system' | null;
}

type RateSession = XRSession & { supportedFrameRates?: Float32Array; frameRate?: number; updateTargetFrameRate?(r: number): Promise<void>; enabledFeatures?: readonly string[] };

const PX = 16; // canvas pixels per cm

export class XrTest {
  stage: XrStage = 'idle';
  readonly results: XrResults = {
    error: null,
    tap_to_first_frame_ms: null,
    enabled_features: null,
    supported_frame_rates: null,
    start_frame_rate: null,
    placement: null,
    frames_72: null,
    frames_90: null,
    rate_90: { tried: false, ok: null, frame_rate_after: null, error: null },
    render: null,
    hands: null,
    selects: { starts: 0, ends: 0, cancels: 0 },
    finger_pinches: 0,
    select_per_pinch: null,
    tracked_pct: null,
    controllers_seen: false,
    input: { active: 'hands', changes: 0 },
    visibility: [],
    ended_by: null,
  };
  private tapAt: number | null = null;
  private begun = false;
  private lastNow: number | null = null;
  private intervals: number[] = [];
  private measureFrom = 0;
  private stageEnds = 0;
  private flow: HandFlow | null = null;
  private adapter: HandAdapter | null = null;
  private activeHand: 'left' | 'right' | null = null;
  private readonly pinches = [new PinchCounter(), new PinchCounter()];
  private handFrames = 0;
  private tracked = { left: 0, right: 0 };
  private readonly offs: (() => void)[] = [];
  private overlay: { canvas: HTMLCanvasElement; tex: CanvasTexture; mesh: Mesh; drawnKey: string; drawnAt: number } | null = null;
  private rings: Mesh[] = [];
  private projector: SurfaceProjector;

  constructor(
    readonly app: XRApp,
    private readonly onUpdate: (stage: XrStage, line: string) => void,
    private readonly windows = { frames72Ms: FRAMES_72_MS, frames90Ms: FRAMES_90_MS },
  ) {
    this.projector = new SurfaceProjector(app.sheetAnchor);
    this.results.input.active = app.activeInput();
    this.offs.push(
      app.onInputChange((input) => {
        this.results.input = { active: input, changes: this.results.input.changes + 1 };
        this.flow?.setInput(input);
      }),
      app.onFrame((_dt, now) => this.frame(now)),
      app.onVisibility((v) => this.results.visibility.push(v)),
      app.onSessionEnd(() => this.sessionEnded()),
      app.onSelect((_hand, phase) => {
        if (this.stage !== 'hands') return;
        if (phase === 'start') this.results.selects.starts++;
        else if (phase === 'end') this.results.selects.ends++;
        else this.results.selects.cancels++;
      }),
    );
  }

  private get session(): RateSession | null {
    return (this.app.world.session as RateSession | undefined) ?? null;
  }

  private set(stage: XrStage, line: string): void {
    this.stage = stage;
    this.onUpdate(stage, line);
  }

  /** From the Start tap: enters immersive-ar. Tooling may also enter the session; the run starts on its first frame. */
  enter(tapAt: number): void {
    this.tapAt = tapAt;
    this.set('entering', 'Starting the headset view.');
    this.app.enter().catch((e: Error) => {
      if (this.begun) return;
      this.results.error = `enter: ${e.message}`.slice(0, 200);
      this.set('failed', 'The headset did not start the room.');
    });
  }

  destroy(): void {
    this.offs.forEach((o) => o());
    this.adapter?.destroy();
    this.overlay?.tex.dispose();
    this.overlay?.mesh.geometry.dispose();
    (this.overlay?.mesh.material as MeshBasicMaterial | undefined)?.dispose();
    for (const r of this.rings) {
      r.geometry.dispose();
      (r.material as MeshBasicMaterial).dispose();
    }
    this.app.destroy();
  }

  private frame(now: number): void {
    const s = this.session;
    if (!s) {
      this.lastNow = null;
      return;
    }
    if (!this.begun) {
      this.begun = true;
      void this.begin(s, now);
    }
    const interval = this.lastNow === null ? 0 : now - this.lastNow;
    this.lastNow = now;
    for (const src of s.inputSources) if (!src.hand && src.gamepad) this.results.controllers_seen = true;
    const measuring = this.stage === 'frames72' || this.stage === 'frames90';
    if (measuring && s.visibilityState === 'visible' && now >= this.measureFrom && interval > 0) this.intervals.push(interval);
    if (measuring && now >= this.stageEnds) void this.nextRate(now);
    if (this.stage === 'hands') this.handsFrame(now);
    this.drawOverlay(now);
  }

  private async begin(s: RateSession, now: number): Promise<void> {
    if (this.tapAt !== null) this.results.tap_to_first_frame_ms = Math.round(now - this.tapAt);
    this.results.enabled_features = s.enabledFeatures ? [...s.enabledFeatures] : null;
    this.results.supported_frame_rates = s.supportedFrameRates ? Array.from(s.supportedFrameRates, (r) => Math.round(r)) : null;
    this.results.start_frame_rate = s.frameRate ? Math.round(s.frameRate) : null;
    this.set('placing', 'Touch your desk where the sheet should go.');
    const t0 = performance.now();
    try {
      const desk = await this.app.place();
      this.results.placement = { source: desk.source, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      this.results.error = `place: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      this.set('failed', 'Placing the desk did not finish.');
      return;
    }
    this.buildOverlay();
    this.startMeasure('frames72', performance.now(), this.windows.frames72Ms);
  }

  private startMeasure(stage: 'frames72' | 'frames90', now: number, ms: number): void {
    this.intervals = [];
    this.measureFrom = now + SETTLE_MS;
    this.stageEnds = this.measureFrom + ms;
    this.set(stage, `Frame test at ${stage === 'frames72' ? 72 : 90} Hz. Sit still and look at the people.`);
  }

  private period(): number {
    const r = this.session?.frameRate;
    return 1000 / (r && r > 0 ? r : this.stage === 'frames90' ? 90 : 72);
  }

  private busy = false;
  private async nextRate(now: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const st = frameStats(this.intervals, this.period());
      const s = this.session;
      if (this.stage === 'frames72') {
        this.results.frames_72 = st;
        this.results.render = this.renderStats();
        const can = !!s?.updateTargetFrameRate && !!this.results.supported_frame_rates?.includes(90);
        if (can && s?.updateTargetFrameRate) {
          this.results.rate_90.tried = true;
          try {
            await s.updateTargetFrameRate(90);
            this.results.rate_90.ok = true;
          } catch (e) {
            this.results.rate_90.ok = false;
            this.results.rate_90.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
          }
          this.results.rate_90.frame_rate_after = s.frameRate ? Math.round(s.frameRate) : null;
          if (this.results.rate_90.ok) {
            this.startMeasure('frames90', performance.now(), this.windows.frames90Ms);
            return;
          }
        }
      } else {
        this.results.frames_90 = st;
        await s?.updateTargetFrameRate?.(72).catch(() => undefined);
      }
      this.startHands(now);
    } finally {
      this.busy = false;
    }
  }

  private renderStats(): XrResults['render'] {
    const r = this.app.stats();
    return { calls: r.calls, triangles: r.triangles, textures: r.textures, programs: r.programs, multiview: r.multiview, views: r.views };
  }

  // ---- hands ----

  private startHands(_now: number): void {
    const flow = new HandFlow(() => this.finish());
    this.flow = flow;
    flow.setInput(this.app.activeInput());
    // The board's pointer: a hand's pinch, or a controller's trigger by touch or by ray.
    const adapter = new HandAdapter(this.app, (p) => this.projector.project(p), { cast: (o, d) => this.projector.cast(o, d) });
    this.adapter = adapter;
    const pt = (p: { x_cm: number; y_cm: number }): P2 => ({ x: p.x_cm, y: p.y_cm });
    adapter.onDown((p) => {
      this.activeHand = p.hand === 'left' || p.hand === 'right' ? p.hand : null;
      const by = this.activeHand ? adapter.kindOf(this.activeHand) : null;
      const ray = !!adapter.pointers().find((q) => q.hand === p.hand)?.ray;
      flow.down(pt(p), p.t_ms, by ?? 'hand', ray);
    });
    adapter.onMove((p) => {
      if (this.activeHand && p.hand === this.activeHand) flow.move(pt(p), p.t_ms);
    });
    adapter.onUp((p) => {
      if (p.hand !== this.activeHand) return;
      this.activeHand = null;
      flow.up(pt(p), p.t_ms);
    });
    adapter.onCancel((p) => {
      if (p.hand !== this.activeHand) return;
      this.activeHand = null;
      flow.cancel();
    });
    for (let i = 0; i < 2; i++) {
      const ring = new Mesh(new RingGeometry(0.006, 0.009, 24), new MeshBasicMaterial({ color: 0x7fd4ff, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 12;
      ring.visible = false;
      this.app.sheetAnchor.add(ring);
      this.rings.push(ring);
    }
    this.set('hands', 'Hand tests on the sheet.');
  }

  private handsFrame(now: number): void {
    const flow = this.flow;
    if (!flow) return;
    const hands = this.app.hands();
    this.handFrames++;
    hands.forEach((h, i) => {
      if (h.tracked) this.tracked[h.hand]++;
      if (this.pinches[i]!.feed(h.tracked ? h.pinch : null)) this.results.finger_pinches++;
    });
    const h = this.activeHand ? hands.find((x) => x.hand === this.activeHand) : undefined;
    if (h?.tracked) {
      const mid = { x: (h.indexTip.x + h.thumbTip.x) / 2, y: (h.indexTip.y + h.thumbTip.y) / 2, z: (h.indexTip.z + h.thumbTip.z) / 2 };
      const p = this.projector.project(mid);
      flow.raw({ x: p.x_cm, y: p.y_cm }, now);
    } else flow.raw(null, now);
    flow.tick(now);
    const ptrs = this.adapter?.pointers() ?? [];
    this.rings.forEach((r, i) => {
      const p = ptrs[i];
      r.visible = !!p;
      if (p) boardToLocal(p.x_cm, p.y_cm, 0.5, r.position);
    });
    this.results.hands = flow.results();
    this.results.select_per_pinch = selectRatio(this.results.selects.starts, this.results.finger_pinches);
    this.results.tracked_pct = { left: Math.round((this.tracked.left / this.handFrames) * 100), right: Math.round((this.tracked.right / this.handFrames) * 100) };
  }

  private finish(): void {
    if (this.flow) this.results.hands = this.flow.results();
    this.results.ended_by = 'done';
    this.set('done', 'All tests done.');
    this.app.exit();
  }

  private sessionEnded(): void {
    if (this.stage === 'done' || this.stage === 'failed') return;
    if (this.stage === 'frames72') this.results.frames_72 = frameStats(this.intervals, this.period());
    if (this.stage === 'frames90') this.results.frames_90 = frameStats(this.intervals, this.period());
    this.results.ended_by = 'system';
    this.set('ended', 'The headset view ended before the tests finished.');
  }

  // ---- the sheet overlay ----

  private buildOverlay(): void {
    if (this.overlay) return;
    const canvas = document.createElement('canvas');
    canvas.width = SHEET.w * PX;
    canvas.height = SHEET.h * PX;
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(new PlaneGeometry(SHEET.w / 100, SHEET.h / 100), new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.003, -SHEET.h / 200);
    mesh.renderOrder = 10;
    (this.app.sheetAnchor as Object3D).add(mesh);
    this.overlay = { canvas, tex, mesh, drawnKey: '', drawnAt: 0 };
  }

  private drawOverlay(now: number): void {
    const o = this.overlay;
    if (!o) return;
    const flow = this.flow;
    const secs = Math.max(0, Math.ceil((this.stageEnds - Math.max(now, this.measureFrom)) / 1000));
    const hold = flow ? Math.round(flow.holdProgress(now) * 10) : 0;
    const key = `${this.stage}|${secs}|${flow?.version ?? 0}|${flow?.stage ?? ''}|${flow?.target ?? 0}|${hold}`;
    // Upload only when something changed, and at most 10 times a second.
    if (key === o.drawnKey || now - o.drawnAt < 100) return;
    o.drawnKey = key;
    o.drawnAt = now;
    drawSheet(o.canvas, this.stage, secs, flow, now);
    o.tex.needsUpdate = true;
    o.mesh.visible = this.stage !== 'done';
  }
}

function drawSheet(c: HTMLCanvasElement, stage: XrStage, secs: number, flow: HandFlow | null, now: number): void {
  const g = c.getContext('2d');
  if (!g) return;
  const P = (p: P2) => [p.x * PX, p.y * PX] as const;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(24, 26, 31, 0.9)';
  g.fillRect(0, 0, c.width, c.height);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f2efe9';
  const text = (s: string, x: number, y: number, cm: number, color = '#f2efe9') => {
    g.fillStyle = color;
    g.font = `600 ${Math.round(cm * PX)}px system-ui, sans-serif`;
    g.fillText(s, x * PX, y * PX);
  };
  const dot = (p: P2, r: number, color: string) => {
    const [x, y] = P(p);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r * PX, 0, Math.PI * 2);
    g.fill();
  };
  const ring = (p: P2, r: number, color: string, w = 0.3) => {
    const [x, y] = P(p);
    g.strokeStyle = color;
    g.lineWidth = w * PX;
    g.beginPath();
    g.arc(x, y, r * PX, 0, Math.PI * 2);
    g.stroke();
  };
  if (stage === 'frames72' || stage === 'frames90') {
    text(`Frame test at ${stage === 'frames72' ? 72 : 90} Hz`, 32, 12, 2.6);
    text('Sit still and look at the people.', 32, 19, 1.8, '#c9c4bb');
    text(`${secs} s`, 32, 28, 4, '#7fd4ff');
    return;
  }
  if (stage !== 'hands' || !flow) return;
  const skip = () => {
    g.strokeStyle = '#8c877e';
    g.lineWidth = 0.15 * PX;
    g.strokeRect(SKIP_BOX.x * PX, SKIP_BOX.y * PX, SKIP_BOX.w * PX, SKIP_BOX.h * PX);
    text('Skip', SKIP_BOX.x + SKIP_BOX.w / 2, SKIP_BOX.y + SKIP_BOX.h / 2, 1.5, '#c9c4bb');
  };
  const title: Record<string, string> = { hold: '1 of 3: hold still', line: '2 of 3: draw a line', targets: '3 of 3: tap the rings', done: 'Done' };
  text(title[flow.stage] ?? '', 32, 3.5, 2.2);
  if (flow.stage === 'hold') {
    dot(HOLD_AT, 1, '#7fd4ff');
    const p = flow.holdProgress(now);
    if (p > 0) {
      const [x, y] = P(HOLD_AT);
      g.strokeStyle = '#2fd17a';
      g.lineWidth = 0.4 * PX;
      g.beginPath();
      g.arc(x, y, 2.4 * PX, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      g.stroke();
    }
  } else if (flow.stage === 'line') {
    g.setLineDash([0.6 * PX, 0.6 * PX]);
    g.strokeStyle = '#5d6470';
    g.lineWidth = 0.2 * PX;
    g.beginPath();
    g.moveTo(...P(LINE_FROM));
    g.lineTo(...P(LINE_TO));
    g.stroke();
    g.setLineDash([]);
    dot(LINE_FROM, 0.8, '#7fd4ff');
    dot(LINE_TO, 0.8, '#7fd4ff');
    const st = flow.stroke();
    if (st.length > 1) {
      g.strokeStyle = '#ffd166';
      g.lineWidth = 0.3 * PX;
      g.beginPath();
      g.moveTo(...P(st[0]!));
      for (const p of st.slice(1)) g.lineTo(...P(p));
      g.stroke();
    }
  } else if (flow.stage === 'targets') {
    TARGETS.forEach((t, i) => {
      if (i < flow.target) ring(t, TARGET_R, '#3b4049');
      else if (i === flow.target) {
        ring(t, TARGET_R, '#7fd4ff', 0.4);
        dot(t, 0.35, '#7fd4ff');
      } else ring(t, TARGET_R, '#5d6470');
    });
  } else if (flow.stage === 'done') {
    g.fillStyle = '#2f6f4a';
    g.fillRect(DONE_BOX.x * PX, DONE_BOX.y * PX, DONE_BOX.w * PX, DONE_BOX.h * PX);
    text('Done', DONE_BOX.x + DONE_BOX.w / 2, DONE_BOX.y + DONE_BOX.h / 2, 3);
  }
  if (flow.stage !== 'done') skip();
  // The instruction line, wrapped at about 50 characters.
  const words = flow.message.split(' ');
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= 50) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  lines.slice(0, 2).forEach((l, i) => text(l, 28, 33.5 + i * 2.4, 1.6, '#e9e4da'));
}

/** Creates the room for the test before the Start tap (so the tap only enters). Null without immersive-ar. */
export async function createXrTest(container: HTMLElement, onUpdate: (stage: XrStage, line: string) => void): Promise<XrTest | null> {
  const { pickMode } = await import('../xr/entry');
  if ((await pickMode()) !== 'ar') return null;
  const [{ createXRApp }, project] = await Promise.all([import('../xr/world'), import('virtual:iwsdk-project')]);
  const q = new URLSearchParams(location.search);
  const dev = import.meta.env.DEV;
  const fallback = Number(q.get('fallback'));
  const app = await createXRApp(container, {
    mode: 'ar',
    base: project.default,
    seats: 3,
    // Three converted people on the seats, breathing: the load the round puts on the headset.
    standins: true,
    adaptiveRate: false,
    // Dev and emulator tooling only.
    offer: dev && q.get('offer') === '1',
    placementFallbackMs: dev && fallback > 0 ? fallback * 1000 : undefined,
  });
  // Dev and emulator: short frame windows (?quick=1) and a handle for scripted hands.
  const quick = dev && q.get('quick') === '1';
  const test = new XrTest(app, onUpdate, quick ? { frames72Ms: 3000, frames90Ms: 2000 } : undefined);
  if (dev) {
    (globalThis as { __diagXr?: unknown }).__diagXr = {
      test,
      app,
      toWorld: (pts: [number, number][], hCm = 1) => pts.map(([x, y]) => sheetToWorld(app.sheetAnchor, x, y, hCm)),
    };
  }
  return test;
}
