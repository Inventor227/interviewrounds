// Dev only: the board in a minimal IWSDK passthrough scene, without the room, for emulator
// runs and checks before the XR room is integrated. It implements BoardXRPort from the World:
// hands from joint poses, controllers from their aim rays and gamepads, selects (a pinch or
// the trigger) from select events, the head, and a desk placed in front of the head (or where
// a script puts it). A plain plane stands in for the wall whiteboard.
import { Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3, type Texture } from 'three';
import type { BoardOp, GhostOp } from '../shared/types';
import { createBoardXR, type BoardXR } from './boardXR';
import type { BoardKit } from '../shared/types';
import { sampleStartBoard } from './kits/samples';
import { IdGen } from './model';
import { BoardStore } from './ops';
import type { BoardXRPort, DeskPose, HeadPose, SelectPhase, Vec3, XRControllerSample, XRHandSample } from './port';
import { placeAnchor, sheetToWorld } from './sheetMath';
import { ButtonEdges, pulsePad, HAPTICS, readGamepad, type HapticPad } from '../xr/input';

type FrameCb = (dt: number, nowMs: number) => void;
type SelectCb = (hand: 'left' | 'right', phase: SelectPhase, nowMs: number, kind?: 'hand' | 'controller') => void;

export interface DevSheetHandle {
  store: BoardStore;
  xr: BoardXR;
  /** Puts the desk (sheet near edge centre) somewhere explicit; default: in front of the head. */
  placeDesk(desk?: DeskPose): DeskPose;
  /** Board cm (+ height above the sheet, cm) to XR-origin metres, for scripted hands. */
  toWorld(points: [number, number][], hCm?: number): Vec3[];
  ghosts(list: GhostOp[]): void;
  say(text: string): string;
  /** Applies an op as the Scribe would (src scribe), for scripted runs. */
  scribe(op: { op: string; args: unknown }): boolean;
  /** The sheet's board texture as a PNG data URL (what the wall board shows). */
  snapshot(): string;
  sent: BoardOp[];
  /** Every pinch start on the board (board cm), for checking where pinches land. */
  pinches: { x_cm: number; y_cm: number; hand: string }[];
  destroy(): void;
}

declare global {
  interface Window {
    __boardxr?: DevSheetHandle;
  }
}

export async function createDevSheet(root: HTMLElement): Promise<DevSheetHandle> {
  const [{ World, SessionMode, ReferenceSpaceType }, project] = await Promise.all([import('@iwsdk/core'), import('virtual:iwsdk-project')]);
  const base = project.default;
  const world = await World.create(root, {
    ...base,
    xr: {
      sessionMode: SessionMode.ImmersiveAR,
      referenceSpace: ReferenceSpaceType.LocalFloor,
      offer: 'once',
      features: { handTracking: { required: true } },
    },
    render: { ...base.render, near: 0.01, far: 50 },
  });

  const frames = new Set<FrameCb>();
  const ends = new Set<() => void>();
  const selects = new Set<SelectCb>();
  let hands: XRHandSample[] = [];
  let controllers: XRControllerSample[] = [];
  const pads: Partial<Record<'left' | 'right', HapticPad>> = {};
  const buttons = new ButtonEdges();
  let desk: DeskPose | null = null;
  let lastT = 0;
  let frameN = 0;

  const anchor = new Object3D();
  anchor.name = 'board-sheet-anchor';
  world.scene.add(anchor);

  // Stand-in wall whiteboard (the room's Wallboard in the real app).
  const wall = new Mesh(new PlaneGeometry(1.6, 1.0), new MeshBasicMaterial({ color: 0xf3f1ec, toneMapped: false }));
  wall.name = 'dev-wallboard';
  wall.visible = false;
  world.scene.add(wall);

  const headPose = (): HeadPose => {
    const head = world.player.head;
    const p = head.getWorldPosition(new Vector3());
    const q = head.getWorldQuaternion(new Quaternion());
    const f = new Vector3(0, 0, -1).applyQuaternion(q);
    return { pos: { x: p.x, y: p.y, z: p.z }, yaw: Math.atan2(-f.x, -f.z), pitch: Math.atan2(f.y, Math.hypot(f.x, f.z)) };
  };

  const placeDesk = (d?: DeskPose): DeskPose => {
    if (!d) {
      const h = headPose();
      const deskY = h.pos.y - 0.45;
      d = { origin: { x: h.pos.x - Math.sin(h.yaw) * 0.2, y: deskY, z: h.pos.z - Math.cos(h.yaw) * 0.2 }, yaw: h.yaw, deskY };
    }
    desk = d;
    placeAnchor(anchor, d);
    // The wall board stands 1.5 m beyond the sheet, its centre 0.9 m above the desk, facing the user.
    wall.position.set(d.origin.x - Math.sin(d.yaw) * 1.5, d.deskY + 0.9, d.origin.z - Math.cos(d.yaw) * 1.5);
    wall.rotation.set(0, d.yaw, 0);
    wall.visible = true;
    return d;
  };

  const port: BoardXRPort = {
    sheetAnchor: anchor,
    onFrame(cb) {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    onSelect(cb) {
      selects.add(cb);
      return () => selects.delete(cb);
    },
    hands: () => hands,
    controllers: () => controllers,
    onButton: (cb) => buttons.on(cb),
    haptic: (hand, name) => void pulsePad(pads[hand], HAPTICS[name].strength, HAPTICS[name].ms),
    headPose,
    desk: () => desk,
    onSessionEnd(cb) {
      ends.add(cb);
      return () => ends.delete(cb);
    },
    wallboardTexture(tex: Texture | null) {
      const m = wall.material;
      if (tex) tex.colorSpace = SRGBColorSpace;
      m.map = tex;
      m.color.set(tex ? 0xf2f2f2 : 0xf3f1ec);
      m.needsUpdate = true;
    },
  };

  world.onXRFrame((frame) => {
    const ref = world.xrReferenceSpace;
    const session = world.session;
    if (!ref || !session) return;
    const out: XRHandSample[] = [];
    const ctrls: XRControllerSample[] = [];
    const now = performance.now();
    for (const src of session.inputSources) {
      const hand = src.hand;
      if (src.handedness !== 'left' && src.handedness !== 'right') continue;
      if (!hand) {
        // A held controller: its aim ray starts at its front tip.
        const pose = src.gamepad && src.targetRayMode === 'tracked-pointer' ? frame.getPose(src.targetRaySpace, ref) : undefined;
        if (!pose) continue;
        const p = pose.transform.position;
        const q = pose.transform.orientation;
        const pad = readGamepad(src.gamepad);
        ctrls.push({
          hand: src.handedness,
          tracked: true,
          tip: { x: p.x, y: p.y, z: p.z },
          dir: { x: -2 * (q.x * q.z + q.w * q.y), y: -2 * (q.y * q.z - q.w * q.x), z: -(1 - 2 * (q.x * q.x + q.y * q.y)) },
          stick: pad.stick,
        });
        pads[src.handedness] = src.gamepad as unknown as HapticPad;
        buttons.update(src.handedness, pad, now);
        continue;
      }
      const joint = (name: XRHandJoint): Vec3 | null => {
        const space = hand.get(name);
        const pose = space ? frame.getJointPose?.(space, ref) : undefined;
        if (!pose) return null;
        const p = pose.transform.position;
        return { x: p.x, y: p.y, z: p.z };
      };
      const thumbTip = joint('thumb-tip');
      const indexTip = joint('index-finger-tip');
      out.push({ hand: src.handedness, tracked: !!(thumbTip && indexTip), thumbTip, indexTip });
    }
    hands = out;
    controllers = ctrls;
    for (const side of ['left', 'right'] as const) {
      if (ctrls.some((c) => c.hand === side)) continue;
      delete pads[side];
      buttons.update(side, null, now);
    }
    const t = performance.now();
    const dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    frameN += 1;
    if (!desk && frameN > 30) placeDesk();
    for (const cb of [...frames]) cb(dt, t);
  });

  const onSessionStart = () => {
    const s = world.renderer.xr.getSession();
    if (!s) return;
    // A selectend with no select before it is the system cancelling the pinch.
    const selected = new WeakSet<XRInputSource>();
    const fire = (e: XRInputSourceEvent, phase: SelectPhase) => {
      const h = e.inputSource.handedness;
      if (h !== 'left' && h !== 'right') return;
      for (const cb of [...selects]) cb(h, phase, performance.now(), e.inputSource.hand ? 'hand' : 'controller');
    };
    s.addEventListener('selectstart', ((e: XRInputSourceEvent) => {
      selected.delete(e.inputSource);
      fire(e, 'start');
    }) as EventListener);
    s.addEventListener('select', ((e: XRInputSourceEvent) => {
      selected.add(e.inputSource);
    }) as EventListener);
    s.addEventListener('selectend', ((e: XRInputSourceEvent) => fire(e, selected.has(e.inputSource) ? 'end' : 'cancel')) as EventListener);
  };
  world.renderer.xr.addEventListener('sessionstart', onSessionStart);
  const onSessionEnd = () => {
    for (const cb of [...ends]) cb();
  };
  world.renderer.xr.addEventListener('sessionend', onSessionEnd);

  const kitParam = new URLSearchParams(location.search).get('kit');
  const kitName: BoardKit = (['hld', 'lld', 'coding', 'pm', 'meeting'] as const).find((k) => k === kitParam) ?? 'hld';
  const store = new BoardStore(sampleStartBoard(kitName));
  const sent: BoardOp[] = [];
  const xr = createBoardXR(port, {
    store,
    dominantHand: 'right',
    // No server here: every op is confirmed at once.
    send: (op) => {
      sent.push(op);
      store.confirm(op.op_id);
    },
    sendGhostReject: () => {},
    ids: new IdGen('x'),
  });

  const pinches: DevSheetHandle['pinches'] = [];
  xr.hands?.onDown((p) => pinches.push({ x_cm: Math.round(p.x_cm * 100) / 100, y_cm: Math.round(p.y_cm * 100) / 100, hand: p.hand }));

  const handle: DevSheetHandle = {
    pinches,
    store,
    xr,
    sent,
    placeDesk,
    toWorld: (pts, hCm = 1) => pts.map(([x, y]) => sheetToWorld(anchor, x, y, hCm)),
    ghosts: (list) => store.setGhosts(list),
    say: (text) => {
      // Scripted runs are slow (each tooling call takes seconds), so the typed turn stands in
      // for speech right after the touch: at most 1 s after the focus was set.
      const age = Math.round(performance.now() - store.focusAt);
      const hit = xr.say(text, Math.min(performance.now(), store.focusAt + 1000));
      return `${hit ? `${hit.mode} ${hit.label}` : 'nothing'} (focus ${store.board.focus ?? 'none'}, ${age} ms old)`;
    },
    scribe: (op) => store.apply({ op_id: `s${Math.random().toString(36).slice(2, 8)}`, src: 'scribe', ...op } as BoardOp).accepted,
    snapshot: () => {
      const img = xr.sheet.texture.image as HTMLCanvasElement | OffscreenCanvas;
      return 'toDataURL' in img ? img.toDataURL('image/png') : '';
    },
    destroy() {
      xr.destroy();
      world.renderer.xr.removeEventListener('sessionstart', onSessionStart);
      world.renderer.xr.removeEventListener('sessionend', onSessionEnd);
      world.destroy();
    },
  };
  return handle;
}
