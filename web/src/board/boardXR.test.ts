import { describe, expect, it } from 'vitest';
import type { BoardOp, GhostOp } from '../shared/types';
import { createBoardXR } from './boardXR';
import { ghostRect, GHOST_SETTLE_MS } from './ghosts';
import { HLD_KIT } from './kits';
import { emptyBoard } from './model';
import { BoardStore } from './ops';
import type { SfxName } from './port';
import { along, roughBox } from './testkit';
import { FakePort, stubCanvas } from './xrtestkit';

function setup(dominantHand: 'left' | 'right' = 'right') {
  const port = new FakePort();
  const store = new BoardStore(emptyBoard());
  const sent: BoardOp[] = [];
  const rejected: string[] = [];
  const sounds: SfxName[] = [];
  const focus: (string | null)[] = [];
  const xr = createBoardXR(port, {
    sendFocus: (id) => focus.push(id),
    store,
    dominantHand,
    send: (op) => sent.push(op),
    sendGhostReject: (id) => rejected.push(id),
    sfx: { play: (n) => sounds.push(n) },
    makeCanvas: stubCanvas,
  });
  port.frame();
  return { port, store, sent, rejected, sounds, xr, focus };
}

const step = (pts: [number, number][], n = 0.35) => along(pts, n);

describe('board in XR', () => {
  it('shows the sheet once the desk is placed, mirrors it on the wall, and plays the paper flap once', () => {
    const { port, xr, sounds } = setup();
    expect(xr.sheet.group.visible).toBe(true);
    expect(port.wallTex).toBe(xr.sheet.texture);
    port.frame();
    expect(sounds.filter((s) => s === 'flap')).toHaveLength(1);
  });

  it('a pinch-drawn rough box becomes a card, two boxes and a line become a connection', () => {
    const { port, store, sent, sounds } = setup();
    port.pinchStroke('right', roughBox(8, 8, 10, 6, 0.4, 2));
    port.pinchStroke('right', roughBox(34, 8, 10, 6, 0.4, 5));
    expect(store.board.items.map((i) => (i.kind === 'component' ? i.type : i.kind))).toEqual(['service', 'service']);
    const [a, b] = store.board.items as { x: number; y: number; w: number; h: number }[];
    port.pinchStroke('right', step([[a!.x + a!.w - 0.3, a!.y + 3], [b!.x + 2, b!.y + 3]]));
    expect(store.board.edges).toHaveLength(1);
    expect(sent.map((o) => o.op)).toEqual(['item.create', 'item.create', 'edge.create']);
    expect(sent.every((o) => o.src === 'hand')).toBe(true);
    expect(sounds).toEqual(expect.arrayContaining(['snap', 'click']));
  });

  it('a voice command labels the fresh focus card; a statement only suggests', () => {
    const { port, store, sent, xr } = setup();
    port.pinchStroke('right', roughBox(8, 8, 10, 6, 0.4, 2));
    expect(xr.say('call that the order service')?.mode).toBe('commit');
    expect(store.board.items[0]).toMatchObject({ label: 'Order service' });
    expect(sent.at(-1)).toMatchObject({ op: 'item.label', src: 'voice_grammar' });
    expect(xr.say("that's the gateway")?.mode).toBe('suggest');
    expect(store.board.items[0]).toMatchObject({ label: 'Order service' });
    expect(store.board.ghosts).toHaveLength(1);
    // Ten seconds later nothing is fresh: no label, no suggestion.
    for (let i = 0; i < 10; i++) port.frame(1000);
    expect(xr.say('call that the edge cache')).toBeNull();
  });

  const G: GhostOp = { op_id: 'g1', src: 'scribe', op: 'item.create', args: { id: 'n9', kind: 'component', type: 'cache', label: 'Redis', x: 40, y: 20, w: 8, h: 5 } };

  it('pinching a Scribe ghost accepts it: sent as a board.op with the same op_id and src scribe', () => {
    const { port, store, sent, sounds } = setup();
    store.setGhosts([G]);
    port.pinchStroke('right', [[44, 22]]);
    expect(sent).toEqual([{ op_id: 'g1', src: 'scribe', op: 'item.create', args: G.args }]);
    expect(store.board.items.map((i) => i.id)).toEqual(['n9']);
    expect(sounds).toContain('snap');
  });

  it('a pinch-hold of 0.6 s on a ghost dismisses it with board.ghost_reject', () => {
    const { port, store, sent, rejected, sounds } = setup();
    store.setGhosts([G]);
    port.handAt('right', 44, 22);
    port.frame();
    port.select('right', 'start');
    for (let i = 0; i < 50; i++) port.frame();
    port.select('right', 'end');
    expect(rejected).toEqual(['g1']);
    expect(sent).toEqual([]);
    expect(store.board.ghosts).toEqual([]);
    expect(sounds).toContain('erase');
  });

  it('dropping a ghost on the bin dismisses it', () => {
    const { port, store, rejected } = setup();
    store.setGhosts([G]);
    const bin = HLD_KIT.bin;
    port.pinchStroke('right', step([[44, 22], [bin.x + bin.w / 2, bin.y + bin.h / 2]], 0.8));
    expect(rejected).toEqual(['g1']);
  });

  it('an untouched ghost settles after 4 s', () => {
    const { port, store, sent } = setup();
    store.setGhosts([G]);
    for (let i = 0; i < Math.ceil(GHOST_SETTLE_MS / 100) + 1; i++) port.frame(100);
    expect(sent.map((o) => o.op_id)).toEqual(['g1']);
  });

  it('a local voice suggestion is accepted as a voice_grammar op and dismissed without telling the server', () => {
    const { port, store, sent, rejected, xr } = setup();
    port.pinchStroke('right', roughBox(8, 8, 10, 6, 0.4, 2));
    xr.say("that's the gateway");
    const g = store.board.ghosts[0]!;
    const r = ghostRect(store.board, g)!;
    port.pinchStroke('right', [[r.x + r.w / 2, r.y + r.h / 2]]);
    expect(sent.at(-1)).toMatchObject({ op_id: g.op_id, op: 'item.label', src: 'voice_grammar', args: { text: 'Gateway' } });
    xr.say("that's the edge");
    const g2 = store.board.ghosts[0]!;
    const r2 = ghostRect(store.board, g2)!;
    port.handAt('right', r2.x + r2.w / 2, r2.y + r2.h / 2);
    port.frame();
    port.select('right', 'start');
    for (let i = 0; i < 50; i++) port.frame();
    port.select('right', 'end');
    expect(rejected).toEqual([]);
    expect(store.board.ghosts).toEqual([]);
  });

  it('a left-handed user pulls cards from a tray on the right', () => {
    const { port, store, xr } = setup('left');
    const slot = xr.kit.tray.find((s) => s.type === 'db')!;
    expect(slot.x).toBeGreaterThan(64);
    port.pinchStroke('right', step([[slot.x + 3, slot.y + 1.3], [40, 25]], 0.8));
    expect(store.board.items[0]).toMatchObject({ kind: 'component', type: 'db' });
  });

  it('the board texture uploads once per change while a stroke is drawn', () => {
    const { port, xr } = setup();
    const before = xr.sheet.stats.boardUploads;
    port.pinchStroke('right', step([[30, 30], [40, 34], [50, 30]]));
    // One upload for the committed ink item; the stroke itself went to the gesture mesh.
    expect(xr.sheet.stats.boardUploads - before).toBe(1);
    expect(xr.sheet.stats.gestureUploads).toBeGreaterThan(10);
  });

  it('sends board.focus once the touched or created card has held for 300 ms', () => {
    const { port, store, focus } = setup();
    port.pinchStroke('right', roughBox(8, 8, 10, 6, 0.4, 2));
    const id = store.board.items[0]!.id;
    for (let i = 0; i < 25; i++) port.frame();
    expect(focus).toEqual([id]);
    // A tap on empty sheet clears it; a quick change back and forth sends only where it ends up.
    port.pinchStroke('right', [[50, 35]]);
    for (let i = 0; i < 25; i++) port.frame();
    expect(focus).toEqual([id, null]);
    store.setFocus(id, port.now);
    port.frame();
    store.setFocus(null, port.now);
    for (let i = 0; i < 25; i++) port.frame();
    expect(focus).toEqual([id, null]);
  });

  it('stops on destroy', () => {
    const { port, store, xr } = setup();
    xr.destroy();
    port.pinchStroke('right', roughBox(8, 8, 10, 6, 0.4, 2));
    expect(store.board.items).toEqual([]);
    expect(port.sheetAnchor.children).toHaveLength(0);
  });
});
