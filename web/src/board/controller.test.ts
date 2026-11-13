// The board with held controllers: the trigger is the pinch, the tip draws by touch, the aim ray draws from a
// distance, and everything a hand does on the sheet a controller does too.
import { describe, expect, it } from 'vitest';
import type { Board, BoardOp, GhostOp } from '../shared/types';
import { createBoardXR } from './boardXR';
import { HandAdapter } from './hand';
import type { BoardPoint } from './input';
import { HLD_KIT } from './kits';
import { codeLineRect, visibleLines } from './kits/coding';
import { emptyBoard } from './model';
import { BoardStore } from './ops';
import { CONTROLLER_FAR_PROFILE, CONTROLLER_NEAR_PROFILE, HAND_PROFILE } from './pointer';
import type { SfxName } from './port';
import { SurfaceProjector, sheetToWorld } from './sheetMath';
import { along, roughBox } from './testkit';
import { FakePort, stubCanvas } from './xrtestkit';

function setup(board: Board = emptyBoard(), dominantHand: 'left' | 'right' = 'right') {
  const port = new FakePort();
  const store = new BoardStore(board);
  const sent: BoardOp[] = [];
  const rejected: string[] = [];
  const sounds: SfxName[] = [];
  const xr = createBoardXR(port, {
    store,
    dominantHand,
    send: (op) => sent.push(op),
    sendGhostReject: (id) => rejected.push(id),
    sfx: { play: (n) => sounds.push(n) },
    makeCanvas: stubCanvas,
  });
  port.frame();
  return { port, store, sent, rejected, sounds, xr };
}

const step = (pts: [number, number][], n = 0.35) => along(pts, n);
const kinds = (b: Board) => b.items.map((i) => (i.kind === 'component' ? i.type : i.kind));
const G: GhostOp = { op_id: 'g1', src: 'scribe', op: 'item.create', args: { id: 'n9', kind: 'component', type: 'cache', label: 'Cache', x: 40, y: 20, w: 8, h: 5 } };

function events(adapter: HandAdapter) {
  const ev: [string, BoardPoint][] = [];
  adapter.onDown((p) => ev.push(['down', p]));
  adapter.onMove((p) => ev.push(['move', p]));
  adapter.onUp((p) => ev.push(['up', p]));
  adapter.onCancel((p) => ev.push(['cancel', p]));
  return ev;
}

describe('controllers on the board', () => {
  it('controller_trigger_draws_on_sheet_near', () => {
    const { port, store, sent, xr } = setup();
    // The tip on the sheet, the trigger held: a rough box becomes a card, exactly as a pinch-drawn one does.
    port.triggerStroke('right', roughBox(8, 8, 10, 6, 0.4, 2), 'near');
    expect(kinds(store.board)).toEqual(['service']);
    expect(sent.map((o) => o.op)).toEqual(['item.create']);
    expect(sent[0]!.src).toBe('hand');
    // Touching, it shows the same ring a hand does, not a ray.
    port.controllerAt('right', 30, 20, 1);
    port.frame();
    expect(xr.sheet.shadow('right').visible).toBe(true);
    expect(xr.sheet.cursor('right').dot.visible).toBe(false);
    // The trigger pulled with the tip 6 cm above the sheet and the ray pointing off it draws nothing: the same
    // box traced in the air leaves the board as it was.
    const air = (x: number, y: number) => port.setController('right', sheetToWorld(port.sheetAnchor, x, y, 6), { x: 0, y: 1, z: 0 });
    const box = roughBox(30, 24, 10, 6, 0.4, 3);
    air(box[0]![0], box[0]![1]);
    port.frame();
    port.select('right', 'start', 'controller');
    for (const [x, y] of box) {
      air(x, y);
      port.frame();
    }
    port.select('right', 'end', 'controller');
    expect(sent).toHaveLength(1);
    expect(store.board.items).toHaveLength(1);
  });

  it('controller_ray_draws_on_sheet_far', () => {
    const { port, store, sent, xr } = setup();
    port.triggerStroke('left', roughBox(30, 10, 12, 7, 0.4, 5), 'far');
    expect(kinds(store.board)).toEqual(['service']);
    const card = store.board.items[0] as { x: number; y: number; w: number; h: number };
    // The card lands where the ray pointed (the box was drawn around 30..42 x 10..17).
    expect(Math.abs(card.x + card.w / 2 - 36)).toBeLessThan(2);
    expect(Math.abs(card.y + card.h / 2 - 13.5)).toBeLessThan(2);
    expect(sent).toHaveLength(1);
    // While it points from a distance the sheet shows the ray and a cursor dot where it lands, and no ring.
    port.controllerAimAt('left', 20, 30);
    for (let i = 0; i < 30; i++) port.frame();
    const { dot, line } = xr.sheet.cursor('left');
    expect(dot.visible).toBe(true);
    expect(line.visible).toBe(true);
    expect(xr.sheet.shadow('left').visible).toBe(false);
    port.scene.updateMatrixWorld(true);
    const want = sheetToWorld(port.sheetAnchor, 20, 30, 0);
    const got = dot.getWorldPosition(dot.position.clone());
    expect(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z)).toBeLessThan(0.004);
    // A ray that is on a panel in front (a button) leaves the board alone: no dot, no stroke.
    port.setController('left', port.controllers()[0]!.tip, port.controllers()[0]!.dir, { busy: true });
    port.frame();
    expect(dot.visible).toBe(false);
    port.select('left', 'start', 'controller');
    port.select('left', 'end', 'controller');
    expect(sent).toHaveLength(1);
  });

  it('two boxes and a connector, one by ray and one by touch', () => {
    const { port, store, sent, sounds } = setup();
    port.triggerStroke('right', roughBox(8, 8, 10, 6, 0.4, 2), 'far');
    port.triggerStroke('right', roughBox(34, 8, 10, 6, 0.4, 5), 'near');
    expect(kinds(store.board)).toEqual(['service', 'service']);
    const [a, b] = store.board.items as { id: string; x: number; y: number; w: number; h: number }[];
    port.triggerStroke('right', step([[a!.x + a!.w - 0.3, a!.y + 3], [b!.x + 2, b!.y + 3]]), 'far');
    expect(store.board.edges).toHaveLength(1);
    expect(store.board.edges[0]).toMatchObject({ from: a!.id, to: b!.id });
    expect(sent.map((o) => o.op)).toEqual(['item.create', 'item.create', 'edge.create']);
    expect(sounds).toEqual(expect.arrayContaining(['snap', 'click']));
  });

  it.each(['near', 'far'] as const)('controller_picks_tray_card (%s)', (mode) => {
    const { port, store, xr } = setup();
    const slot = xr.kit.tray.find((s) => s.type === 'db')!;
    port.triggerStroke('right', step([[slot.x + 3, slot.y + 1.3], [40, 25]], 0.8), mode);
    expect(store.board.items[0]).toMatchObject({ kind: 'component', type: 'db' });
    const it0 = store.board.items[0] as { x: number; y: number; w: number; h: number };
    expect(Math.abs(it0.x + it0.w / 2 - 40)).toBeLessThan(1.5);
    // Picking it up was a press: the controller felt it, then the drop snapped.
    expect(port.pulses).toEqual([
      { hand: 'right', name: 'press' },
      { hand: 'right', name: 'snap' },
    ]);
  });

  it('a card dragged to the bin by ray is deleted, with the bin pulse', () => {
    const { port, store, sent } = setup();
    port.triggerStroke('right', roughBox(20, 12, 10, 6, 0.4, 2), 'near');
    const c = store.board.items[0] as { id: string; x: number; y: number; w: number; h: number };
    const bin = HLD_KIT.bin;
    port.pulses.length = 0;
    port.triggerStroke('right', step([[c.x + c.w / 2, c.y + c.h / 2], [bin.x + bin.w / 2, bin.y + bin.h / 2]], 0.8), 'far');
    expect(store.board.items).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ op: 'item.delete', args: { id: c.id } });
    expect(port.pulses.map((p) => p.name)).toEqual(['press', 'bin']);
  });

  it.each(['near', 'far'] as const)('a trigger tap on a ghost accepts it; trigger and hold dismisses it (%s)', (mode) => {
    const { port, store, sent, rejected } = setup();
    store.setGhosts([G]);
    port.triggerStroke('right', [[44, 22]], mode);
    expect(sent).toEqual([{ op_id: 'g1', src: 'scribe', op: 'item.create', args: G.args }]);
    store.setGhosts([{ ...G, op_id: 'g2', args: { ...G.args, id: 'n10', x: 10, y: 28 } } as GhostOp]);
    if (mode === 'near') port.controllerAt('right', 14, 30);
    else port.controllerAimAt('right', 14, 30);
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'start', 'controller');
    for (let i = 0; i < 50; i++) port.frame();
    port.select('right', 'end', 'controller');
    expect(rejected).toEqual(['g2']);
    expect(store.board.ghosts).toEqual([]);
  });

  it('switching_hands_to_controllers_mid_stroke_ends_stroke_cleanly', () => {
    const { port, store, sent, xr } = setup();
    const ev = events(xr.hands!);
    // A hand is half way through a stroke...
    const pts = step([[10, 10], [30, 10]]);
    for (let i = 0; i < 12; i++) {
      port.handAt('right', 10, 10);
      port.frame();
    }
    port.select('right', 'start', 'hand');
    for (let i = 0; i < 8; i++) port.frame();
    for (const [x, y] of pts.slice(0, 30)) {
      port.handAt('right', x, y);
      port.frame();
    }
    expect(xr.input.holding('right')).toBe('ink');
    // ...when the user picks up a controller: the hand is gone from that side and a controller is there.
    port.setHand('right', null);
    port.controllerAt('right', 22, 12);
    port.frame();
    // The stroke ended at once, with no op and nothing left held.
    expect(ev.at(-1)![0]).not.toBe('down');
    expect(ev.filter((e) => e[0] === 'cancel')).toHaveLength(1);
    expect(xr.input.holding('right')).toBeNull();
    expect(xr.input.overlays).toEqual([]);
    expect(sent).toEqual([]);
    expect(store.board.items).toEqual([]);
    // The hand's pinch ending late (the system lets go of it) changes nothing.
    port.select('right', 'cancel', 'hand');
    port.select('right', 'end', 'hand');
    expect(ev.filter((e) => e[0] === 'up')).toEqual([]);
    // The controller starts clean: its own trigger draws a box.
    port.triggerStroke('right', roughBox(30, 20, 10, 6, 0.4, 2), 'near');
    expect(kinds(store.board)).toEqual(['service']);
    // And back: the controller goes down mid drag, the hand takes over and draws.
    const c = store.board.items[0] as { x: number; y: number; w: number; h: number };
    port.controllerAt('right', c.x + c.w / 2, c.y + c.h / 2);
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'start', 'controller');
    for (const [x, y] of step([[c.x + c.w / 2, c.y + c.h / 2], [c.x + c.w / 2 + 6, c.y + c.h / 2]])) {
      port.controllerAt('right', x, y);
      port.frame();
    }
    expect(xr.input.holding('right')).toBe('pick');
    port.setController('right', null);
    port.handAt('right', 12, 30);
    port.frame();
    expect(xr.input.holding('right')).toBeNull();
    // A card that was being carried is dropped where it was (on the sheet), as when tracking is lost.
    const moved = store.board.items[0] as { x: number };
    expect(moved.x).toBeGreaterThan(c.x + 3);
    port.pinchStroke('right', roughBox(6, 26, 10, 6, 0.4, 7));
    expect(kinds(store.board)).toEqual(['service', 'service']);
  });

  it('a_button_undoes_last_action', () => {
    const { port, store, sent } = setup();
    port.triggerStroke('right', roughBox(8, 8, 10, 6, 0.4, 2), 'near');
    port.triggerStroke('right', roughBox(34, 8, 10, 6, 0.4, 5), 'far');
    expect(store.board.items).toHaveLength(2);
    const second = sent[1]!.op_id;
    port.pulses.length = 0;
    // A on the right controller (X on the left does the same).
    port.button('right', 'primary');
    expect(store.board.items).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ op: 'undo', src: 'hand', args: { target_op_id: second } });
    expect(port.pulses).toEqual([{ hand: 'right', name: 'bin' }]);
    port.button('left', 'primary');
    expect(store.board.items).toHaveLength(0);
    // Nothing left to undo: no op. B and Y do nothing.
    const n = sent.length;
    port.button('right', 'primary');
    port.button('right', 'secondary');
    expect(sent).toHaveLength(n);
  });

  it('A does not undo while that controller is in the middle of a stroke', () => {
    const { port, store, sent } = setup();
    port.triggerStroke('right', roughBox(8, 8, 10, 6, 0.4, 2), 'near');
    port.controllerAt('right', 40, 20);
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'start', 'controller');
    port.controllerAt('right', 44, 20);
    port.frame();
    port.button('right', 'primary');
    expect(store.board.items).toHaveLength(1);
    expect(sent.map((o) => o.op)).toEqual(['item.create']);
  });

  it('haptics_pulse_on_snap', () => {
    const { port, store } = setup();
    // A box drawn by a controller snaps into a card: one snap pulse, in the hand that drew it.
    port.triggerStroke('left', roughBox(8, 8, 10, 6, 0.4, 2), 'near');
    expect(port.pulses).toEqual([{ hand: 'left', name: 'snap' }]);
    // A connection clicks.
    port.triggerStroke('right', roughBox(34, 8, 10, 6, 0.4, 5), 'near');
    const [a, b] = store.board.items as { x: number; y: number; w: number; h: number }[];
    port.pulses.length = 0;
    port.triggerStroke('right', step([[a!.x + a!.w - 0.3, a!.y + 3], [b!.x + 2, b!.y + 3]]), 'near');
    expect(port.pulses).toEqual([{ hand: 'right', name: 'connect' }]);
    // A suggestion that settles by itself pulses nobody.
    port.pulses.length = 0;
    store.setGhosts([G]);
    for (let i = 0; i < 60; i++) port.frame(100);
    expect(store.board.items).toHaveLength(3);
    expect(port.pulses).toEqual([]);
  });

  it('one pointer model: each side is a hand or a controller, with a tip, a ray and a pressed state', () => {
    const { port, xr } = setup();
    port.handAt('left', 10, 10, 2);
    port.controllerAimAt('right', 40, 20);
    port.frame();
    const src = xr.hands!.sources();
    expect(src.map((s) => [s.hand, s.kind, s.pressed, !!s.ray])).toEqual([
      ['left', 'hand', false, false],
      ['right', 'controller', false, true],
    ]);
    expect(xr.hands!.kindOf('left')).toBe('hand');
    expect(xr.hands!.kindOf('right')).toBe('controller');
    port.select('right', 'start', 'controller');
    port.frame();
    expect(xr.hands!.sources()[1]!.pressed).toBe(true);
    // Both draw at the same time, each with its own pointer.
    expect(xr.hands!.pointers().map((p) => [p.hand, p.kind, !!p.ray])).toEqual([
      ['left', 'hand', false],
      ['right', 'controller', true],
    ]);
  });

  it('a stroke keeps the way it started: a touch stroke stays on the tip when it lifts, a ray stroke stays on the ray', () => {
    const port = new FakePort();
    const proj = new SurfaceProjector(port.sheetAnchor);
    const adapter = new HandAdapter(port, (p) => proj.project(p), { zone: HLD_KIT.view, cast: (o, d) => proj.cast(o, d) });
    const ev = events(adapter);
    for (let i = 0; i < 12; i++) {
      port.controllerAt('right', 20, 20, 0.5);
      port.frame();
    }
    port.select('right', 'start', 'controller');
    for (let i = 0; i < 8; i++) port.frame();
    // The tip lifts to 8 cm mid stroke and aims elsewhere: the stroke still follows the tip.
    const tip = sheetToWorld(port.sheetAnchor, 30, 20, 8);
    const far = sheetToWorld(port.sheetAnchor, 60, 5, 0);
    for (let i = 0; i < 30; i++) {
      port.setController('right', tip, { x: far.x - tip.x, y: far.y - tip.y, z: far.z - tip.z });
      port.frame();
    }
    const last = ev.at(-1)![1];
    expect(Math.abs(last.x_cm - 30)).toBeLessThan(0.5);
    expect(Math.abs(last.y_cm - 20)).toBeLessThan(0.5);
    port.select('right', 'end', 'controller');
    // A ray stroke whose ray swings off the sheet's plane waits where it was, and carries on when it comes back.
    ev.length = 0;
    for (let i = 0; i < 12; i++) {
      port.controllerAimAt('right', 20, 20);
      port.frame();
    }
    port.select('right', 'start', 'controller');
    for (let i = 0; i < 8; i++) port.frame();
    const c = port.controllers()[0]!;
    port.setController('right', c.tip, { x: 0, y: 1, z: 0 });
    for (let i = 0; i < 40; i++) port.frame();
    expect(ev.filter((e) => e[0] === 'cancel')).toEqual([]);
    port.controllerAimAt('right', 26, 20);
    for (let i = 0; i < 30; i++) port.frame();
    port.select('right', 'end', 'controller');
    const up = ev.find((e) => e[0] === 'up')![1];
    expect(Math.abs(up.x_cm - 26)).toBeLessThan(0.6);
  });

  it('a tip that is touching stays the pointer a little above the band, then the ray takes over', () => {
    const { port, xr } = setup();
    const at = (h: number) => {
      port.controllerAt('right', 30, 20, h);
      port.frame();
      return !!xr.hands!.pointers()[0]?.ray;
    };
    // Coming down from above: the ray until the tip is within 3 cm.
    expect(at(3.6)).toBe(true);
    expect(at(2.5)).toBe(false);
    // Lifting a little past 3 cm keeps the touch; past the slack it is the ray again.
    expect(at(4)).toBe(false);
    expect(at(5)).toBe(true);
    expect(at(4)).toBe(true);
  });

  it('a controller is smoothed less than a pinch: it follows a fast move sooner, and a held ray still sits still', () => {
    // The profiles: a steadier pointer gets a higher cutoff (less lag) and a shorter settle.
    expect(CONTROLLER_NEAR_PROFILE.minCutoff).toBeGreaterThan(CONTROLLER_FAR_PROFILE.minCutoff);
    expect(CONTROLLER_FAR_PROFILE.minCutoff).toBeGreaterThan(HAND_PROFILE.minCutoff);
    expect(CONTROLLER_NEAR_PROFILE.settleMs).toBeLessThan(HAND_PROFILE.settleMs);
    expect(CONTROLLER_NEAR_PROFILE.driftMaxCm).toBeLessThan(HAND_PROFILE.driftMaxCm);
    const lag = (kind: 'hand' | 'controller') => {
      const port = new FakePort();
      const proj = new SurfaceProjector(port.sheetAnchor);
      const adapter = new HandAdapter(port, (p) => proj.project(p), { zone: HLD_KIT.view, cast: (o, d) => proj.cast(o, d) });
      const ev = events(adapter);
      const at = (x: number) => (kind === 'hand' ? port.handAt('right', x, 20) : port.controllerAt('right', x, 20));
      for (let i = 0; i < 20; i++) {
        at(10);
        port.frame();
      }
      // A slow, steady move (2 cm/s): how far behind is the pointer after half a second?
      for (let i = 1; i <= 36; i++) {
        at(10 + i * 0.028);
        port.frame();
      }
      return 10 + 36 * 0.028 - ev.at(-1)![1].x_cm;
    };
    const hand = lag('hand');
    const ctrl = lag('controller');
    expect(ctrl).toBeLessThan(hand * 0.6);
    expect(ctrl).toBeLessThan(0.12);
    // A ray held from 40 cm away with a 0.15 degree tremor: the dot stays within 2 mm.
    const port = new FakePort();
    const proj = new SurfaceProjector(port.sheetAnchor);
    const adapter = new HandAdapter(port, (p) => proj.project(p), { zone: HLD_KIT.view, cast: (o, d) => proj.cast(o, d) });
    const ev = events(adapter);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const tip = sheetToWorld(port.sheetAnchor, 32, 40, 30);
    const on = sheetToWorld(port.sheetAnchor, 32, 20, 0);
    const d = { x: on.x - tip.x, y: on.y - tip.y, z: on.z - tip.z };
    const len = Math.hypot(d.x, d.y, d.z);
    for (let i = 0; i < 150; i++) {
      const k = len * Math.tan((0.15 * Math.PI) / 180);
      port.setController('right', tip, { x: d.x + rnd() * k, y: d.y + rnd() * k, z: d.z + rnd() * k });
      port.frame();
    }
    const xs = ev.slice(40).map((e) => e[1].x_cm);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.2);
  });
});

function codingBoard(n = 3): Board {
  return {
    ...emptyBoard({ kit: 'coding' }),
    code: {
      language: 'python',
      lines: Array.from({ length: n }, (_, i) => ({ id: `l${i + 1}`, indent: i === 0 ? 0 : 1, text: i === 0 ? 'def total(xs):' : `step_${i}()`, src: 'scribe' as const })),
      approach: [],
      complexity: { time: null, space: null },
      trace: [],
    },
  };
}

describe('controllers on the code panel', () => {
  it('the ray picks a code line on the standing panel and moves it down a row (Parsons cards)', () => {
    const { port, store, sent, xr } = setup(codingBoard());
    const rect = xr.kit.panel!;
    const r1 = codeLineRect(rect, 1);
    const r2 = codeLineRect(rect, 2);
    port.scene.updateMatrixWorld(true);
    // Aim at the panel from in front of it: the tip 25 cm off the screen along its normal.
    const aim = (x: number, y: number) => {
      const frame = xr.panel!.frame;
      const on = frame.localToWorld(panelPoint(rect, x, y, 0));
      const tip = frame.localToWorld(panelPoint(rect, x, y + 4, 25));
      port.setController('right', { x: tip.x, y: tip.y, z: tip.z }, { x: on.x - tip.x, y: on.y - tip.y, z: on.z - tip.z });
    };
    const x = r1.x + r1.w / 2;
    for (let i = 0; i < 12; i++) {
      aim(x, r1.y + r1.h / 2);
      port.frame();
    }
    expect(xr.sheet.cursor('right').dot.visible).toBe(true);
    port.select('right', 'start', 'controller');
    for (let i = 0; i < 8; i++) port.frame();
    for (const [, y] of step([[x, r1.y + r1.h / 2], [x, r2.y + r2.h / 2 + 0.2]], 0.2)) {
      aim(x, y);
      port.frame();
    }
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'end', 'controller');
    expect(sent.map((o) => o.op)).toEqual(['code.move']);
    expect(store.board.code!.lines.map((l) => l.id)).toEqual(['l1', 'l3', 'l2']);
  });

  it('thumbstick down and up scroll the code panel a line at a time, then repeat while held', () => {
    const { port, store, xr } = setup(codingBoard(40));
    const rows = visibleLines(xr.kit.panel!);
    expect(rows).toBeLessThan(40);
    const top = () => Number(xr.kit.panelKey!(store.board).split(':')[0]);
    expect(top()).toBe(0);
    const tip = sheetToWorld(port.sheetAnchor, 32, 60, 30);
    const stick = (y: number) => port.setController('right', tip, { x: 0, y: 0, z: -1 }, { stick: { x: 0, y } });
    // Pulled toward the user (down): later lines.
    stick(1);
    port.frame();
    expect(top()).toBe(1);
    // Held: one more line every 160 ms, not every frame.
    for (let i = 0; i < 5; i++) port.frame(14);
    expect(top()).toBe(1);
    for (let i = 0; i < 30; i++) port.frame(14);
    expect(top()).toBeGreaterThanOrEqual(3);
    expect(top()).toBeLessThanOrEqual(4);
    // Let go, then up: earlier lines, and it stops at the first.
    stick(0);
    port.frame();
    const at = top();
    stick(-1);
    port.frame();
    expect(top()).toBe(at - 1);
    for (let i = 0; i < 200; i++) port.frame(14);
    expect(top()).toBe(0);
    // A small lean of the stick does nothing.
    stick(0.3);
    for (let i = 0; i < 40; i++) port.frame(14);
    expect(top()).toBe(0);
    // Other kits have no panel: the stick does nothing there.
    const hld = setup();
    hld.port.setController('right', tip, { x: 0, y: 0, z: -1 }, { stick: { x: 0, y: 1 } });
    hld.port.frame();
    expect(hld.xr.panel).toBeNull();
  });
});

import { Vector3 } from 'three';
import { panelToLocal } from './sheetMath';
function panelPoint(rect: { x: number; y: number; w: number; h: number }, x: number, y: number, h: number): Vector3 {
  return panelToLocal(rect, x, y, h);
}
