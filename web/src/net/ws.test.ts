import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSocket } from './ws';

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

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 } as CloseEvent);
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
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006 } as CloseEvent);
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

const op = {
  op_id: 'op-1',
  rev_base: 0,
  src: 'hand' as const,
  op: 'item.create' as const,
  args: { id: 'n1', kind: 'component', type: 'cache', label: 'Redis' },
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
    // A successful open resets the backoff.
    FakeWebSocket.last().serverOpen();
    FakeWebSocket.last().serverDrop();
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
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
