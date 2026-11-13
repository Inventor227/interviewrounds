// The XR app: one IWSDK world for the round room, in passthrough (`ar`) or as a 2D preview in the page (`preview`).
//
// ar:      immersive-ar, hand tracking and hit test required, anchors optional, 90 Hz when the device offers it,
//          medium fixed foveation. On session start the desk placement runs ("Touch your desk where the sheet
//          should go"), then the room is built and anchored around that desk.
// preview: no WebXR. The same room in a calm virtual meeting room, camera at seated eye height, mouse input.
//
// The round controller drives `ui` and reads `room.seatPoses()`, `headPose()` and `hands()`.

import {
  createSystem,
  IBLTexture,
  PokeInteractable,
  RayInteractable,
  ReferenceSpaceType,
  SessionMode,
  signal,
  VisibilityState,
  World,
  type ReadonlySignal,
  type WorldOptions,
} from '@iwsdk/core';
import { ACESFilmicToneMapping, Matrix4, Quaternion, Vector3, type Mesh, type Object3D, type Scene } from 'three';
import { yawPitchFromQuat } from './math';
import { DeskPlacement, type DeskPose, type HandState, type HeadPose } from './placement';
import { PlacementView } from './placementView';
import { buildPreviewRoom, MouseLook, PREVIEW_DESK, PREVIEW_FOV } from './preview';
import { Room } from './room';
import type { SeatPose } from './seats';
import { createSounds, type Sounds } from './sound';
import { DEFAULT_STANDINS, loadStandIn, placeStandIn, type StandIn } from './standin';
import { RoundUI } from './ui';

export type XRMode = 'ar' | 'preview';

export interface XRAppOptions {
  mode: XRMode;
  /** Panelists to seat (default 1). */
  seats?: 1 | 2 | 3;
  /** Dev/emulator: offer the session so tooling can accept it (`iwsdk xr enter`). */
  offer?: boolean;
  /** Load converted avatars as stand-ins on the seats (screens and preview until the avatar runtime seats people). */
  standins?: boolean | string[];
  /** Base world options (from iwsdk.config.json via virtual:iwsdk-project). */
  base?: WorldOptions;
  /** How long placement waits for a touch before the head-height fallback (default 6 s; tooling raises it). */
  placementFallbackMs?: number;
}

export interface RenderStats {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  fps: number;
  /** Views rendered per frame (2 in a stereo session) and whether they share draw calls (multiview). */
  views: number;
  multiview: boolean;
  /** Draw calls per eye: calls / views without multiview. */
  callsPerView: number;
}

export interface XRApp {
  world: World;
  scene: Scene;
  mode: XRMode;
  room: Room;
  ui: RoundUI;
  sounds: Sounds;
  /** Enters the immersive session (ar; needs a user gesture) or starts the preview. */
  enter(): Promise<void>;
  exit(): void;
  destroy(): void;
  /** Per-frame callback after the world's systems; dt in seconds. Returns an unsubscribe. */
  onFrame(cb: (dt: number, nowMs: number) => void): () => void;
  headPose(): HeadPose;
  hands(): HandState[];
  visibility$: ReadonlySignal<VisibilityState>;
  /** The placed desk, null until placement finishes. */
  desk$: ReadonlySignal<DeskPose | null>;
  /** Re-runs placement (also runs by itself on session start). */
  placeDesk(): Promise<DeskPose>;
  /** Re-seats the room for 1 to 3 people. */
  setSeats(n: 1 | 2 | 3): SeatPose[];
  standins(): StandIn[];
  stats(): RenderStats;
}

const TIPS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;

type FrameCb = (dt: number, nowMs: number) => void;
const hooks = new WeakMap<World, Set<FrameCb>>();

class FrameHookSystem extends createSystem({}) {
  override update(delta: number): void {
    const set = hooks.get(this.world as World);
    if (!set) return;
    const now = performance.now();
    for (const cb of set) cb(delta, now);
  }
}

export async function createXRApp(root: HTMLElement, opts: XRAppOptions): Promise<XRApp> {
  const mode = opts.mode;
  let seatsN: 1 | 2 | 3 = opts.seats ?? 1;
  const base = opts.base ?? {};
  const options: WorldOptions =
    mode === 'ar'
      ? {
          ...base,
          xr: {
            sessionMode: SessionMode.ImmersiveAR,
            referenceSpace: ReferenceSpaceType.LocalFloor,
            offer: opts.offer ? 'once' : 'none',
            // Plane and mesh detection stay off: they cost a permission prompt (research/06 §2.2).
            features: { handTracking: { required: true }, hitTest: { required: true }, anchors: true },
          },
          render: { near: 0.01, far: 50, ...base.render },
          features: { ...base.features, sceneUnderstanding: false },
        }
      : {
          ...base,
          xr: false,
          render: { near: 0.01, far: 50, ...base.render, fov: PREVIEW_FOV },
          features: { ...base.features, sceneUnderstanding: false, environmentRaycast: false },
        };

  const world = await World.create(root, options);
  const { renderer, scene, camera } = world;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = mode === 'ar' ? 0.9 : 1.0;
  renderer.xr.setFoveation(0.5);
  world.registerSystem(FrameHookSystem, { priority: 10 });
  const frameCbs = new Set<FrameCb>();
  hooks.set(world, frameCbs);

  // Neutral indoor IBL so skin and cloth do not look plastic; the room adds one soft key light.
  world.activeLevel.value.addComponent(IBLTexture, { src: 'room', intensity: mode === 'ar' ? 0.85 : 0.6 });

  const sounds = createSounds();
  const room = new Room(world, { mode });
  const ui = new RoundUI(sounds);
  const placementView = new PlacementView();
  placementView.group.visible = false;
  scene.add(placementView.group);

  // Panels are entities so rays, pokes and the mouse reach them.
  const panelEntities = Object.values(ui.groups).map((g) => {
    const e = world.createTransformEntity(g);
    e.addComponent(RayInteractable);
    e.addComponent(PokeInteractable);
    return e;
  });

  const desk$ = signal<DeskPose | null>(null);
  let standins: StandIn[] = [];
  const wantStandins = opts.standins === true ? DEFAULT_STANDINS : Array.isArray(opts.standins) ? opts.standins : [];

  // ---- head and hands ----
  const tmpV = new Vector3();
  const tmpQ = new Quaternion();
  const headPose = (): HeadPose => {
    const src: Object3D = mode === 'ar' && world.session ? world.player.head : camera;
    src.getWorldPosition(tmpV);
    src.getWorldQuaternion(tmpQ);
    const { yaw, pitch } = yawPitchFromQuat(tmpQ);
    return { pos: { x: tmpV.x, y: tmpV.y, z: tmpV.z }, yaw, pitch };
  };

  let handStates: HandState[] = [];
  world.onXRFrame((frame) => {
    const ref = world.xrReferenceSpace;
    const session = world.session;
    if (!ref || !session) return;
    const out: HandState[] = [];
    for (const src of session.inputSources) {
      const hand = src.hand;
      if (!hand || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
      const tips = [];
      let ok = true;
      for (const name of TIPS) {
        const space = hand.get(name);
        const pose = space ? frame.getJointPose?.(space, ref) : undefined;
        if (!pose) {
          ok = false;
          break;
        }
        const p = pose.transform.position;
        tips.push({ x: p.x, y: p.y, z: p.z });
      }
      if (!ok) {
        out.push({ hand: src.handedness, tracked: false, indexTip: { x: 0, y: 0, z: 0 }, tips: [], pinch: 0 });
        continue;
      }
      const [thumb, index] = [tips[0]!, tips[1]!];
      const d = Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z);
      out.push({ hand: src.handedness, tracked: true, indexTip: index, tips, pinch: Math.max(0, Math.min(1, 1 - (d - 0.012) / 0.03)) });
    }
    handStates = out;
    updateAnchor(frame, ref);
  });

  // ---- anchoring ----
  let anchor: { space: XRSpace; m0: Matrix4 } | null = null;
  const anchorM = new Matrix4();
  const updateAnchor = (frame: XRFrame, ref: XRReferenceSpace) => {
    if (!anchor) return;
    const pose = frame.getPose(anchor.space, ref);
    if (!pose) return;
    anchorM.fromArray(pose.transform.matrix).multiply(anchor.m0);
    room.setAnchorOffset(anchorM);
  };
  const createAnchor = async (desk: DeskPose) => {
    const frame = world.xrFrame;
    const ref = world.xrReferenceSpace;
    if (!frame || !ref || typeof frame.createAnchor !== 'function') return;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), desk.yaw);
    try {
      const a = await frame.createAnchor(new XRRigidTransform({ ...desk.origin }, { x: q.x, y: q.y, z: q.z, w: q.w }), ref);
      if (!a) return;
      const m = new Matrix4().compose(new Vector3(desk.origin.x, desk.origin.y, desk.origin.z), q, new Vector3(1, 1, 1));
      anchor = { space: a.anchorSpace, m0: m.invert() };
    } catch {
      // Anchors are optional; the room stays where it was placed.
    }
  };

  // ---- placing the room ----
  const attachUI = () => {
    const g = ui.groups;
    if (mode === 'preview') {
      for (const k of ['roundBar', 'brief', 'captions'] as const) camera.add(g[k]);
      room.root.add(g.status, g.summary);
      layoutPreviewHud();
    } else {
      room.root.add(...Object.values(g));
    }
  };

  const build = (desk: DeskPose) => {
    const seats = room.place(desk, seatsN);
    if (mode === 'preview') room.addFloorShadows(0);
    if (mode === 'preview') ui.layoutDesk(desk, ['roundBar', 'brief', 'captions']);
    else ui.layoutDesk(desk);
    for (const [i, s] of standins.entries()) {
      const seat = seats[i];
      s.object.visible = !!seat;
      if (seat) placeStandIn(s, seat);
    }
    return seats;
  };

  const loadStandins = async () => {
    if (wantStandins.length === 0) return;
    const loaded = await Promise.all(
      wantStandins.slice(0, 3).map((id) =>
        loadStandIn(renderer, id).catch((e) => {
          console.warn('[xr] stand-in failed', id, e);
          return null;
        }),
      ),
    );
    standins = loaded.filter((s): s is StandIn => !!s);
    for (const s of standins) room.root.add(s.object);
    const desk = desk$.value;
    if (desk) build(desk);
    else for (const s of standins) s.object.visible = false;
  };

  let placing: { p: DeskPlacement; resolve: (d: DeskPose) => void; laidOut: boolean } | null = null;
  const placeDesk = (): Promise<DeskPose> => {
    if (mode === 'preview') {
      desk$.value = PREVIEW_DESK;
      build(PREVIEW_DESK);
      return Promise.resolve(PREVIEW_DESK);
    }
    return new Promise<DeskPose>((resolve) => {
      placing = { p: new DeskPlacement(performance.now(), opts.placementFallbackMs), resolve, laidOut: false };
      placementView.reset();
      placementView.group.visible = true;
      ui.setStatus('placing');
    });
  };

  const finishPlacement = (desk: DeskPose, now: number) => {
    const p = placing;
    placing = null;
    anchor = null;
    room.setAnchorOffset(new Matrix4());
    build(desk);
    placementView.finish(room.sheet, now);
    ui.hideStatus();
    sounds.flap();
    desk$.value = desk;
    void createAnchor(desk);
    p?.resolve(desk);
  };

  // ---- preview camera ----
  let mouse: MouseLook | null = null;
  let previewRest: HeadPose | null = null;
  let previewGroup: Object3D | null = null;
  const layoutPreviewHud = () => {
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    ui.layoutHud(w / h, camera.fov);
  };
  const buildPreview = () => {
    if (previewGroup) {
      previewGroup.removeFromParent();
      previewGroup.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
      });
    }
    const seats = room.seatPoses();
    const pr = buildPreviewRoom(PREVIEW_DESK, seatsN, seats);
    previewGroup = pr.group;
    world.activeLevel.value.object3D!.add(pr.group);
    previewRest = pr.rest;
  };

  let resizeObs: ResizeObserver | null = null;
  if (mode === 'preview') {
    // Fit the canvas to its container (the world sizes to the window by default).
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const fit = () => {
      const w = root.clientWidth;
      const h = root.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      layoutPreviewHud();
    };
    resizeObs = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    resizeObs?.observe(root);
    window.addEventListener('resize', fit);
    world.addCleanup(() => window.removeEventListener('resize', fit));
    fit();
    mouse = new MouseLook(canvas);
    attachUI();
    await placeDesk();
    buildPreview();
  } else {
    attachUI();
  }

  // ---- per frame ----
  let fps = 0;
  let fpsAcc = 0;
  let fpsN = 0;
  frameCbs.add((dt, now) => {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
    }
    if (mode === 'preview' && mouse && previewRest) mouse.apply(camera, previewRest, dt);
    if (placing) {
      const head = headPose();
      if (!placing.laidOut && head.pos.y > 0.4) {
        ui.layoutHeadStatus(head);
        scene.add(ui.status.group);
        placing.laidOut = true;
      }
      const st = placing.p.update(now, head, handStates);
      placementView.update(head, st, now);
      if (st.state === 'done' && st.result) {
        room.root.add(ui.status.group);
        finishPlacement(st.result, now);
      }
    }
    placementView.animate(now);
    ui.update(dt, now);
    for (const s of standins) if (s.object.visible) s.mixer.update(dt);
  });

  // Session tuning: 90 Hz when offered, foveation, then placement.
  renderer.xr.addEventListener('sessionstart', () => {
    const s = renderer.xr.getSession();
    const rates = (s as XRSession & { supportedFrameRates?: Float32Array })?.supportedFrameRates;
    if (s && rates && Array.from(rates).includes(90)) {
      (s as XRSession & { updateTargetFrameRate?(r: number): Promise<void> }).updateTargetFrameRate?.(90)?.catch(() => {});
    }
    renderer.xr.setFoveation(0.5);
    void placeDesk();
  });
  renderer.xr.addEventListener('sessionend', () => {
    placing = null;
    placementView.group.visible = false;
  });

  void loadStandins();

  let enterWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  renderer.xr.addEventListener('sessionstart', () => {
    enterWaiter?.resolve();
    enterWaiter = null;
  });

  const app: XRApp = {
    world,
    scene,
    mode,
    room,
    ui,
    sounds,
    enter() {
      if (mode === 'preview') return Promise.resolve();
      if (world.session) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        enterWaiter = { resolve, reject };
        try {
          world.launchXR();
        } catch (e) {
          enterWaiter = null;
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        // launchXR reports failures only to the console: notice when the request ends without a session.
        const started = performance.now();
        const poll = setInterval(() => {
          if (!enterWaiter) return clearInterval(poll);
          if (world.session) return;
          if (!world.sessionRequestPending && performance.now() - started > 500) {
            clearInterval(poll);
            enterWaiter.reject(new Error('The headset did not start the session.'));
            enterWaiter = null;
          }
        }, 250);
      });
    },
    exit() {
      if (mode === 'ar') world.exitXR();
    },
    destroy() {
      resizeObs?.disconnect();
      mouse?.dispose();
      for (const e of panelEntities) e.destroy();
      room.dispose();
      hooks.delete(world);
      world.destroy();
    },
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    headPose,
    hands: () => handStates.map((h) => ({ ...h, tips: [...h.tips] })),
    visibility$: world.visibilityState,
    desk$,
    placeDesk,
    setSeats(n) {
      seatsN = n;
      const desk = desk$.value;
      if (!desk) return [];
      const seats = build(desk);
      if (mode === 'preview') buildPreview();
      return seats;
    },
    standins: () => standins,
    stats() {
      const i = renderer.info;
      const xrCam = renderer.xr.isPresenting ? renderer.xr.getCamera() : null;
      const views = xrCam ? Math.max(1, xrCam.cameras.length) : 1;
      const multiview = !!(renderer.xr as unknown as { isMultiview?: boolean }).isMultiview;
      return {
        views,
        multiview,
        callsPerView: multiview ? i.render.calls : Math.round(i.render.calls / views),
        calls: i.render.calls,
        triangles: i.render.triangles,
        points: i.render.points,
        lines: i.render.lines,
        geometries: i.memory.geometries,
        textures: i.memory.textures,
        programs: i.programs?.length ?? 0,
        fps: Math.round(fps * 10) / 10,
      };
    },
  };
  return app;
}
