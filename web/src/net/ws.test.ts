import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMsgMap } from '../shared/types';
import { SessionSocket, SocketClosedError } from './ws';

/** In-memory stand-in for the browser WebSocket, driven by the test as "the server". */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no socket created');
    return ws;
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('send while not open');
    this.sent.push(data);
  }

  closedWith: number | null = null;

  close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = code;
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }

  // ----- server side controls -----
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  serverSend(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }

  serverDrop(): void {
    this.serverClose(1006);
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  frames(): { t: string; seq: number; d: Record<string, unknown> }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const roundState = {
  status: 'live',
  phase_id: 'intro',
  phase_index: 0,
  phases: [{ id: 'intro', minutes: 1 }],
  elapsed_s: 3,
  remaining_s: 477,
  phase_remaining_s: 57,
  brief: { question: 'Design a URL shortener', lines: [] },
  floor: 'p1',
};

const op: ClientMsgMap['board.op'] = {
  op_id: 'op-1',
  rev_base: 0,
  src: 'hand',
  op: 'item.create',
  args: { id: 'n1', kind: 'component', type: 'cache', label: 'Redis', x: 4, y: 6, w: 8, h: 5 },
  at_ms: 1200,
};

function makeSocket() {
  return new SessionSocket('wss://example.test/ws/session/s1', 'tok-1', {
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
}

describe('SessionSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnect_replays_unacked_and_sends_last_seq', async () => {
    const sock = makeSocket();
    const states: unknown[] = [];
    sock.on('round.state', (d) => states.push(d));

    const connected = sock.connect();
    const ws1 = FakeWebSocket.last();
    ws1.serverOpen();
    await connected;

    expect(ws1.frames()[0]).toMatchObject({ t: 'hello', d: { client_token: 'tok-1', last_seq: 0 } });

    sock.send('board.op', op);
    // The server sends two messages, never acks the op, then the connection drops.
    ws1.serverSend({ t: 'round.state', seq: 1, d: roundState });
    ws1.serverSend({ t: 'round.state', seq: 2, d: { ...roundState, elapsed_s: 4 } });
    ws1.serverDrop();
    expect(states).toHaveLength(2);

    // First backoff step is 0.5 s.
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const ws2 = FakeWebSocket.last();
    ws2.serverOpen();
    const frames = ws2.frames();
    expect(frames[0]).toMatchObject({ t: 'hello', d: { client_token: 'tok-1', last_seq: 2 } });
    expect(frames[1]).toMatchObject({ t: 'board.op', d: op });
    // Replayed with its original seq so the server can drop duplicates.
    const firstSend = ws1.frames().find((f) => f.t === 'board.op');
    expect(frames[1]?.seq).toBe(firstSend?.seq);
    sock.close();
  });

  it('does_not_replay_acked_messages', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    FakeWebSocket.last().serverOpen();
    await connected;
    const ws1 = FakeWebSocket.last();

    sock.send('board.op', op);
    sock.send('ui.event', { kind: 'pause' });
    const [, first, second] = ws1.frames();
    ws1.serverSend({ t: 'board.ack', seq: 1, ack: first?.seq, d: { op_id: 'op-1', rev: 1 } });
    ws1.serverDrop();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = FakeWebSocket.last();
    ws2.serverOpen();
    const replay = ws2.frames().slice(1);
    expect(replay.map((f) => f.seq)).toEqual([second?.seq]);
    sock.close();
  });

  it('ignores_duplicate_server_seq', async () => {
    const sock = makeSocket();
    const got: number[] = [];
    sock.on('round.state', (d) => got.push(d.elapsed_s));
    const connected = sock.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    await connected;
    ws.serverSend({ t: 'round.state', seq: 1, d: roundState });
    ws.serverSend({ t: 'round.state', seq: 1, d: roundState });
    ws.serverSend({ t: 'round.state', seq: 2, d: { ...roundState, elapsed_s: 9 } });
    expect(got).toEqual([3, 9]);
    sock.close();
  });

  it('backs_off_0_5_1_2_4_seconds', async () => {
    const sock = makeSocket();
    sock.connect().catch(() => {});
    for (const wait of [500, 1000, 2000, 4000, 4000]) {
      FakeWebSocket.last().serverDrop();
      const before = FakeWebSocket.instances.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeWebSocket.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    }
    // A connection that delivers a frame resets the backoff.
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    ws.serverSend({ t: 'pong', seq: 0, d: {} });
    ws.serverDrop();
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    sock.close();
  });

  it('accept_then_drop_keeps_backing_off', async () => {
    const sock = makeSocket();
    sock.connect().catch(() => {});
    for (const wait of [500, 1000, 2000, 4000]) {
      // The server accepts the upgrade, says nothing, and drops us.
      FakeWebSocket.last().serverOpen();
      FakeWebSocket.last().serverDrop();
      const before = FakeWebSocket.instances.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(FakeWebSocket.instances.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    }
    sock.close();
  });

  it.each([4401, 4404, 4409, 1000])('terminal_close_%i_stops_for_good', async (code) => {
    const sock = makeSocket();
    const statuses: string[] = [];
    const terminal: unknown[] = [];
    sock.onStatus((s) => statuses.push(s));
    sock.onTerminal((info) => terminal.push(info));
    const connected = sock.connect();
    FakeWebSocket.last().serverOpen();
    await connected;
    FakeWebSocket.last().serverClose(code, 'nope');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(sock.state).toBe('closed');
    expect(statuses.at(-1)).toBe('closed');
    expect(terminal).toEqual([{ code, reason: 'nope' }]);
    expect(sock.closeInfo).toEqual({ code, reason: 'nope' });
    await expect(sock.connect()).rejects.toBeInstanceOf(SocketClosedError);
    expect(sock.send('ui.event', { kind: 'pause' })).toBe(false);
  });

  it('terminal_close_before_first_open_rejects_connect', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    FakeWebSocket.last().serverClose(4401, 'bad token');
    await expect(connected).rejects.toMatchObject({ info: { code: 4401, reason: 'bad token' } });
  });

  it('transient_close_codes_reconnect', async () => {
    const sock = makeSocket();
    sock.connect().catch(() => {});
    FakeWebSocket.last().serverClose(1012); // service restart
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(sock.state).toBe('reconnecting');
    sock.close();
  });

  it('telemetry_is_dropped_while_down_and_never_replayed', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    FakeWebSocket.last().serverOpen();
    await connected;
    const ws1 = FakeWebSocket.last();
    expect(sock.send('head.samples', { samples: [] })).toBe(true);
    expect(ws1.frames().map((f) => f.t)).toEqual(['hello', 'head.samples']);
    ws1.serverDrop();
    expect(sock.send('head.samples', { samples: [] })).toBe(false);
    expect(sock.send('voice.state', { panelist_id: 'p1', mode: 'listening', at_ms: 1 })).toBe(false);
    expect(sock.send('ui.event', { kind: 'pause' })).toBe(true);
    expect(sock.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.last().serverOpen();
    expect(FakeWebSocket.last().frames().map((f) => f.t)).toEqual(['hello', 'ui.event']);
    sock.close();
  });

  it('full_queue_reports_evicted_reliable_messages', async () => {
    const sock = new SessionSocket('wss://example.test/ws/session/s1', 'tok-1', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      maxQueue: 2,
    });
    const dropped: unknown[] = [];
    sock.onDropped((env) => dropped.push(env.d));
    sock.connect().catch(() => {});
    sock.send('ui.event', { kind: 'pause' });
    sock.send('ui.event', { kind: 'resume' });
    sock.send('ui.event', { kind: 'end' });
    expect(dropped).toEqual([{ kind: 'pause' }]);
    expect(sock.pending).toBe(2);
    sock.close();
  });

  it('dead_link_reconnects_after_a_silent_ping_interval', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    const ws1 = FakeWebSocket.last();
    ws1.serverOpen();
    await connected;
    await vi.advanceTimersByTimeAsync(20_000); // ping sent, nothing comes back
    expect(ws1.frames().filter((f) => f.t === 'ping')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000); // still silent: link is dead
    expect(ws1.closedWith).toBe(4000);
    expect(sock.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    sock.close();
  });

  it('connect_twice_returns_the_same_promise', async () => {
    const sock = makeSocket();
    const a = sock.connect();
    const b = sock.connect();
    expect(b).toBe(a);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last().serverOpen();
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    sock.close();
  });

  it('ignores_frames_from_a_replaced_socket', async () => {
    const sock = makeSocket();
    const got: number[] = [];
    sock.on('round.state', (d) => got.push(d.elapsed_s));
    sock.connect().catch(() => {});
    const ws1 = FakeWebSocket.last();
    ws1.serverOpen();
    ws1.serverDrop();
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.last().serverOpen();
    ws1.serverSend({ t: 'round.state', seq: 5, d: roundState }); // late frame on the old socket
    expect(got).toEqual([]);
    sock.close();
  });

  it('pings_every_20_seconds', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    const ws = FakeWebSocket.last();
    ws.serverOpen();
    await connected;
    const pings = () => ws.frames().filter((f) => f.t === 'ping').length;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(pings()).toBe(0);
    ws.serverSend({ t: 'pong', seq: 0, d: {} });
    await vi.advanceTimersByTimeAsync(1);
    expect(pings()).toBe(1);
    ws.serverSend({ t: 'pong', seq: 0, d: {} });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pings()).toBe(2);
    sock.close();
  });

  it('close_stops_reconnecting', async () => {
    const sock = makeSocket();
    const connected = sock.connect();
    FakeWebSocket.last().serverOpen();
    await connected;
    sock.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('resolves_relative_ws_url_against_the_page', () => {
    const sock = new SessionSocket('/ws/session/s9', 'tok', {
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    sock.connect().catch(() => {});
    expect(FakeWebSocket.last().url).toMatch(/^wss?:\/\/[^/]+\/ws\/session\/s9$/);
    sock.close();
  });
});
