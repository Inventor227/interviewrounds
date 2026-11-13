// The real room for one round: the round controller's dependencies built from the XR app, the
// avatars, the board, the head sampler and the room socket.
//
//   mic tap   → preload(session): room code, world and renderer, this round's people (model, clips,
//               lip sync model) and, in rounds with a board, the sheet. No XR session yet.
//   Enter tap → enter(): the XR session request, nothing else.
//   then      → place(): the desk; people appear when loaded and seated; voices are already
//               connecting (the controller does that).
//
// Everything heavy is imported on demand inside preload(), so registering this runtime costs the
// 2D pages nothing. The session page reads the live room through ./room.

import type { RuntimeOptions } from '../app/launch';
import { loadMe } from '../app/components/data';
import type { BoardXR } from '../board/boardXR';
import type { BoardPoint, PointerAdapter } from '../board/input';
import type { BoardStore } from '../board/ops';
import { api } from '../net/api';
import { SessionSocket } from '../net/ws';
import type { CreateSessionRes, Panelist, Settings } from '../shared/types';
import { isMarker, type TransportOptions, type VoiceTransport } from '../voice/transport';
import type { Avatar } from '../xr/avatar';
import type { XRApp } from '../xr/world';
import { syncBoard, type BoardSync } from './boardSync';
import * as browser from './browser';
import type { RoundControllerDeps } from './controller';
import { createHeadPort } from './headPort';
import { People, type AvatarLike } from './people';
import type { HeadSamplerPort, SocketPort, UiAction, XRPort } from './ports';
import { clearLiveRoom, setLiveRoom, type LiveRoom } from './room';
import { StageTimings } from './timings';

/** Longest the mic tap waits for the avatars; slower ones appear when they are loaded. */
export const AVATAR_WAIT_MS = 12_000;
/** The board items are pointed at a little above the sheet (cm). */
const POINT_ABOVE_CM = 2;

type Cb = (p: BoardPoint) => void;

/** A pointer whose source arrives later (the preview's canvas mounts after the room is built). */
class RelayPointer implements PointerAdapter {
  private readonly sets = { down: new Set<Cb>(), move: new Set<Cb>(), up: new Set<Cb>(), cancel: new Set<Cb>() };
  private sub(set: Set<Cb>, cb: Cb): () => void {
    set.add(cb);
    return () => set.delete(cb);
  }
  onDown = (cb: Cb) => this.sub(this.sets.down, cb);
  onMove = (cb: Cb) => this.sub(this.sets.move, cb);
  onUp = (cb: Cb) => this.sub(this.sets.up, cb);
  onCancel = (cb: Cb) => this.sub(this.sets.cancel, cb);
  /** Forwards a source's events; returns an unbind. */
  bind(src: PointerAdapter): () => void {
    const fwd = (set: Set<Cb>) => (p: BoardPoint) => {
      for (const cb of [...set]) cb(p);
    };
    const offs = [src.onDown(fwd(this.sets.down)), src.onMove(fwd(this.sets.move)), src.onUp(fwd(this.sets.up)), src.onCancel?.(fwd(this.sets.cancel))];
    return () => offs.forEach((off) => off?.());
  }
  destroy(): void {
    for (const s of Object.values(this.sets)) s.clear();
  }
}

/** Dev flags for emulator tooling: from the query, else from this tab's storage (they survive client routing). */
function devFlag(name: string): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(location.search).get(name) ?? sessionStorage.getItem(`ir_${name}`);
  } catch {
    return null;
  }
}

function after<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

export function createRoundRuntime({ preview }: RuntimeOptions): RoundControllerDeps {
  const timings = new StageTimings();
  const changeCbs = new Set<() => void>();
  const changed = () => {
    for (const cb of [...changeCbs]) cb();
  };

  // The canvas lives here. In passthrough the page never shows it (the round is in the headset);
  // in the preview the session page moves this element into its stage.
  const host = document.createElement('div');
  host.dataset.test = 'room-host';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = preview
    ? 'position:fixed;left:-10000px;top:0;width:960px;height:540px;'
    : 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(host);

  let disposed = false;
  let userSpeaking = false;
  let app: XRApp | null = null;
  let port: (XRPort & { dispose(): void }) | null = null;
  let people: People | null = null;
  let board: BoardXR | null = null;
  let store: BoardStore | null = null;
  let sync: BoardSync | null = null;
  let socket: SessionSocket | null = null;
  let settings: Settings | null = null;
  let relay: RelayPointer | null = null;
  let sheetToWorld: ((x: number, y: number, h: number) => { x: number; y: number; z: number }) | null = null;
  const cleanups: (() => void)[] = [];
  const actionCbs = new Set<(a: UiAction) => void>();
  const gestureCbs = new Set<() => void>();
  const activityCbs = new Set<() => void>();
  const active = () => {
    for (const cb of [...activityCbs]) cb();
  };

  const room: LiveRoom = {
    host,
    preview,
    timings,
    hasBoard: false,
    sessionLost: false,
    onChange(cb) {
      changeCbs.add(cb);
      return () => changeCbs.delete(cb);
    },
    async reenter() {
      if (!app) throw new Error('The room is not loaded');
      await app.enter();
      room.sessionLost = false;
      changed();
      await app.place();
    },
  };
  setLiveRoom(room);

  // ---------- the room socket: board sync and pointing ----------

  const wireSocket = () => {
    if (!socket) return;
    if (store && !sync) {
      sync = syncBoard(store, socket);
      cleanups.push(() => sync?.dispose());
    }
    cleanups.push(
      socket.on('avatar.point_at', (d) => {
        const item = store?.board.items.find((i) => i.id === d.item_id);
        if (!item || !sheetToWorld || !('x' in item)) return;
        const w = 'w' in item && typeof item.w === 'number' ? item.w : 0;
        const h = 'h' in item && typeof item.h === 'number' ? item.h : 0;
        people?.pointAt(d.panelist_id, sheetToWorld(item.x + w / 2, item.y + h / 2, POINT_ABOVE_CM));
      }),
    );
  };

  // ---------- loading ----------

  async function loadPeople(a: XRApp, res: CreateSessionRes): Promise<void> {
    const [avatars, lip] = await Promise.all([import('../xr/avatar'), import('../xr/avatar/lipsync')]);
    if (disposed) return;
    const fade = makeFader();
    const crowd = new People({
      panel: res.panel,
      load: async (id) => Avatar_load(avatars, a, id),
      attach: (av) => a.room.root.add((av as Avatar).root),
      fade: (av, k) => fade((av as Avatar).root, k),
      onAppear: () => a.sceneChanged(),
    });
    people = crowd;
    // The viseme model rides along, so the first word already moves the lips.
    await Promise.all([crowd.load(), lip.preloadVisemeModel()]);
  }

  async function loadBoard(a: XRApp, res: CreateSessionRes): Promise<void> {
    const [{ createBoardXR }, { BoardStore }, { emptyBoard }, { HLD_KIT }, { sheetToWorld: toWorld }] = await Promise.all([
      import('../board/boardXR'),
      import('../board/ops'),
      import('../board/model'),
      import('../board/kits'),
      import('../board/sheetMath'),
    ]);
    if (disposed) return;
    // The same empty board the server starts the round with.
    const s = new BoardStore(emptyBoard({ id: res.session_id, kit: 'hld' }));
    store = s;
    if (preview) relay = new RelayPointer();
    board = createBoardXR(a, {
      store: s,
      dominantHand: settings?.dominant_hand ?? 'right',
      kit: HLD_KIT,
      send: (op) => {
        sync?.send(op);
        active();
      },
      sendGhostReject: (id) => sync?.sendGhostReject(id),
      sendFocus: (id) => sync?.sendFocus(id),
      sfx: { play: (n) => a.sounds.play(n) },
      pointer: relay ?? undefined,
    });
    sheetToWorld = (x, y, h) => toWorld(a.sheetAnchor, x, y, h);
    wireSocket();
    if (import.meta.env.DEV) {
      const { ghostRect } = await import('../board/ghosts');
      room.debug = {
        store: s,
        toWorld: (pts: [number, number][], hCm = 0) => pts.map(([x, y]) => toWorld(a.sheetAnchor, x, y, hCm)),
        ghostRect: (opId: string) => {
          const g = s.board.ghosts.find((x) => x.op_id === opId);
          return g ? ghostRect(s.board, g) : null;
        },
      };
    }

    if (preview) {
      const [{ BoardView }, { MouseAdapter }] = await Promise.all([import('../board/render'), import('../board/mouse')]);
      const kit = board.kit;
      room.attachBoardCanvas = (canvas) => {
        const b = board;
        if (!b || !relay) return () => undefined;
        const view = new BoardView(canvas, {
          pxPerCm: 10,
          originCm: { x: kit.view.x, y: kit.view.y },
          widthCm: kit.view.w,
          heightCm: kit.view.h,
          kit,
          dpr: window.devicePixelRatio || 1,
          targets: 'mouse',
        });
        const mouse = new MouseAdapter(canvas, (x, y) => view.toBoard(x, y));
        const unbind = relay.bind(mouse);
        const fit = () => {
          const w = canvas.parentElement?.clientWidth ?? 0;
          if (w <= 0) return;
          const k = Math.max(4, w / kit.view.w);
          view.configure({ pxPerCm: k, dpr: window.devicePixelRatio || 1 });
          canvas.style.width = `${kit.view.w * k}px`;
          canvas.style.height = `${kit.view.h * k}px`;
        };
        const ro = typeof ResizeObserver !== 'undefined' && canvas.parentElement ? new ResizeObserver(fit) : null;
        if (canvas.parentElement) ro?.observe(canvas.parentElement);
        fit();
        const offFrame = a.onFrame((_dt, t) => {
          view.draw(s.board, { highlight: b.input.hover, overlays: b.input.overlays, rings: b.ghosts.rings(t) });
        });
        return () => {
          offFrame();
          ro?.disconnect();
          unbind();
          mouse.destroy();
        };
      };
    }
    room.hasBoard = true;
  }

  // ---------- the XR port ----------

  const ui: XRPort['ui'] = {
    setRoundState: (s) => port?.ui.setRoundState(s),
    showSummary: (r) => port?.ui.showSummary(r),
    showCard: (c) => port?.ui.showCard?.(c),
    setStatus: (t, p) => port?.ui.setStatus(t, p),
    onAction(cb) {
      actionCbs.add(cb);
      return () => actionCbs.delete(cb);
    },
  };

  const xr: XRPort = {
    async preload(res) {
      if (app || disposed) return;
      // In dev the managed emulator browser keeps a small tooling world on 2D pages; a script can ask to drop it.
      if (devFlag('one_world') === '1') await import('../xr/devtools').then((m) => m.stopToolingWorld()).catch(() => undefined);
      timings.begin('chunk');
      const [world, project, portMod, me] = await Promise.all([
        import('../xr/world'),
        import('virtual:iwsdk-project'),
        import('../xr/port'),
        loadMe().catch(() => null),
      ]);
      timings.mark('chunk_loaded');
      if (disposed) return;
      settings = me?.settings ?? null;
      const n = Math.max(1, Math.min(3, res.panel.length)) as 1 | 2 | 3;
      const fallbackS = Number(devFlag('fallback'));
      const a = await world.createXRApp(host, {
        mode: preview ? 'preview' : 'ar',
        base: project.default,
        seats: n,
        offer: devFlag('offer') === '1',
        standins: false,
        placementFallbackMs: fallbackS > 0 ? fallbackS * 1000 : undefined,
        isUserSpeaking: () => userSpeaking,
      });
      if (disposed) return a.destroy();
      app = a;
      if (import.meta.env.DEV) (globalThis as { __xrApp?: XRApp }).__xrApp = a;
      timings.mark('room_ready');

      const p = portMod.createXRPort(a);
      port = p;
      cleanups.push(
        p.ui.onAction((act) => {
          for (const cb of [...actionCbs]) cb(act);
        }),
        p.onGesture?.(() => {
          for (const cb of [...gestureCbs]) cb();
        }) ?? (() => undefined),
        a.onSessionEnd(({ byApp }) => {
          if (byApp || disposed) return;
          // The user left the headset view mid round: the page offers the way back.
          room.sessionLost = true;
          changed();
        }),
      );
      if (settings) {
        a.ui.captions.setEnabled(settings.captions);
        a.ui.roundBar.setCaptions(settings.captions);
        a.sounds.setVolume(settings.sfx_volume);
      }

      const hasBoard = res.round.board_kit === 'hld';
      a.room.setWallboardVisible(hasBoard);

      // Seats follow the desk; people follow the seats. The paper placeholder gives way to the
      // board's own sheet, and in rounds without a board there is no sheet at all.
      let lastDesk: unknown = null;
      const tmp = { x: 0, y: 0, z: 0 };
      cleanups.push(
        a.onFrame((dt) => {
          const desk = a.desk();
          if (desk !== lastDesk) {
            lastDesk = desk;
            if (desk) people?.place(a.room.seatPoses());
            // The sheet is for drawing: the brief card stands beyond it instead of lying on it.
            if (desk && hasBoard && !preview) a.ui.layoutBriefBeyondSheet(desk);
          }
          if (a.room.sheet.visible) a.room.sheet.visible = false;
          const h = a.headPose().pos;
          tmp.x = h.x;
          tmp.y = h.y;
          tmp.z = h.z;
          people?.update(dt, tmp);
        }),
      );

      timings.begin('avatars');
      const peopleReady = loadPeople(a, res).then(() => {
        timings.mark('avatars_loaded');
        const desk = a.desk();
        if (desk) people?.place(a.room.seatPoses());
      });
      // A slow avatar never holds the start: it appears when it is loaded.
      await Promise.all([after(peopleReady, AVATAR_WAIT_MS), hasBoard ? loadBoard(a, res) : Promise.resolve()]);
      changed();
    },
    enter() {
      // Synchronous on purpose: the XR request must run inside the Enter tap.
      if (!port) return Promise.reject(new Error('The room is not loaded'));
      return port.enter();
    },
    place: () => (port ? port.place() : Promise.reject(new Error('The room is not loaded'))),
    exit: () => port?.exit?.(),
    onGesture(cb) {
      gestureCbs.add(cb);
      return () => gestureCbs.delete(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const c of cleanups.splice(0)) c();
      board?.destroy();
      relay?.destroy();
      people?.dispose();
      port?.dispose();
      app?.destroy();
      app = null;
      host.remove();
      clearLiveRoom(room);
      if (import.meta.env.DEV) {
        delete (globalThis as { __xrApp?: XRApp }).__xrApp;
        // The managed emulator browser needs a world on the 2D pages again.
        if (navigator.webdriver && devFlag('one_world') === '1') void import('../xr/devtools').then((m) => m.startToolingWorld()).catch(() => undefined);
      }
    },
    ui,
    room: { seatPoses: () => port?.room.seatPoses() ?? [] },
  };

  // ---------- head, voices, socket ----------

  const head: HeadSamplerPort = (() => {
    let inner: HeadSamplerPort | null = null;
    let floor: string | null = null;
    const get = async () => {
      if (inner || !app) return inner;
      const a = app;
      const { HeadSampler } = await import('../xr/head');
      inner = createHeadPort({
        makeSampler: (send) => new HeadSampler({ send }),
        onFrame: (cb) => a.onFrame(cb),
        headPose: () => a.headPose(),
        targets: () => [...(people?.eyes() ?? []), ...(sheetToWorld ? [{ id: 'sheet', pos: sheetToWorld(32, 20, 0), coneDeg: 20 }] : [])],
      });
      if (floor) inner.setFloor(floor);
      return inner;
    };
    return {
      start: (sink) => void get().then((h) => !disposed && h?.start(sink)),
      stop: () => inner?.stop(),
      setUserSpeaking(b) {
        userSpeaking = b;
        people?.setUserSpeaking(b);
        inner?.setUserSpeaking(b);
      },
      setFloor(id) {
        floor = id;
        inner?.setFloor(id);
      },
    };
  })();

  const base = browser.makeTransport();
  const makeTransport = (p: Panelist, o: TransportOptions | undefined, res: CreateSessionRes): VoiceTransport => {
    const make = settings ? browser.makeTransport({ voice_speed: settings.voice_speed }) : base;
    const t = make(p, o, res);
    // Captions follow the words as they play; the board hears what the user said.
    t.on('agentText', (e) => app?.ui.setCaption(p.display_name, e.text));
    t.on('userTranscript', (e) => {
      if (e.final && !isMarker(e.text)) board?.say(e.text);
    });
    return t;
  };

  const makeSocket = (wsUrl: string, clientToken: string): SocketPort => {
    socket = new SessionSocket(wsUrl, clientToken);
    wireSocket();
    return socket;
  };

  return {
    api,
    makeSocket,
    makeTransport,
    xr,
    media: browser.browserMedia,
    visibility: browser.pageVisibility,
    avatars: (id) => people?.port(id),
    board: {
      onActivity(cb) {
        activityCbs.add(cb);
        return () => activityCbs.delete(cb);
      },
    },
    head,
    timings,
  };
}

async function Avatar_load(avatars: typeof import('../xr/avatar'), a: XRApp, id: string): Promise<AvatarLike> {
  const entry = await avatars.manifestEntry(id);
  return avatars.Avatar.load(entry, { renderer: a.world.renderer });
}

interface FadeMaterial {
  transparent: boolean;
  opacity: number;
  needsUpdate: boolean;
}

/** Fades an avatar in through its materials' opacity, then puts each material back as it was. */
function makeFader(): (root: Avatar['root'], k: number) => void {
  const saved = new Map<FadeMaterial, { transparent: boolean; opacity: number }>();
  return (root, k) => {
    root.traverse((o) => {
      const m = (o as { material?: FadeMaterial | FadeMaterial[] }).material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        let was = saved.get(mat);
        if (!was) {
          if (k >= 1) continue;
          was = { transparent: mat.transparent, opacity: mat.opacity };
          saved.set(mat, was);
          mat.transparent = true;
          mat.needsUpdate = true;
        }
        if (k >= 1) {
          mat.transparent = was.transparent;
          mat.opacity = was.opacity;
          mat.needsUpdate = true;
          saved.delete(mat);
        } else {
          mat.opacity = was.opacity * k;
        }
      }
    });
  };
}
