// Session WebSocket: /ws/session/{id}, envelope {"t", "seq", "d"} (docs/protocol.md).
//
// - First frame on every connection is `hello {client_token, last_seq}`, where last_seq is the
//   highest server seq we have seen, so the server can replay what we missed.
// - Client messages get a seq and stay queued until the server acks them (`ack` on any server
//   frame = highest client seq processed). After a reconnect they are replayed with the same
//   seq, right after hello, so the server can drop duplicates.
// - Server frames with a seq we already saw are dropped.
// - Ping every 20 s. If nothing arrived since the last ping, the link is dead: reconnect.
// - Reconnect backoff 0.5, 1, 2, 4 s (then 4 s), reset after a successful open.

import type {
  ClientMsgMap,
  ClientMsgType,
  Envelope,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SessionSocketOptions {
  /** WebSocket constructor, injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: readonly number[];
  pingMs?: number;
  /** Unacked messages kept for replay; the oldest are dropped beyond this. */
  maxQueue?: number;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000] as const;
const OPEN = 1;

type Handler = (d: never, env: Envelope) => void;

/** Turns a relative ws_url ("/ws/session/x") into an absolute ws:// or wss:// URL. */
export function resolveWsUrl(url: string, base: string = globalThis.location?.href ?? 'http://localhost/'): string {
  const u = new URL(url, base);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.toString();
}

export class SessionSocket {
  private readonly url: string;
  private readonly WS: typeof WebSocket;
  private readonly backoff: readonly number[];
  private readonly pingMs: number;
  private readonly maxQueue: number;

  private ws: WebSocket | null = null;
  private status: SocketStatus = 'idle';
  private lastServerSeq = 0;
  private nextClientSeq = 1;
  private unacked: Envelope[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private heardSincePing = true;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly statusHandlers = new Set<(s: SocketStatus) => void>();
  private firstOpen: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    url: string,
    private readonly clientToken: string,
    opts: SessionSocketOptions = {},
  ) {
    this.url = resolveWsUrl(url);
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.pingMs = opts.pingMs ?? 20_000;
    this.maxQueue = opts.maxQueue ?? 1000;
  }

  /** Opens the socket. Resolves on the first successful open; keeps retrying until then. */
  connect(): Promise<void> {
    if (this.status === 'open') return Promise.resolve();
    if (this.status === 'closed') return Promise.reject(new Error('socket closed'));
    const p = new Promise<void>((resolve, reject) => {
      this.firstOpen = { resolve, reject };
    });
    if (!this.ws && !this.reconnectTimer) this.open('connecting');
    return p;
  }

  /** Queues a client message and sends it now if the socket is open. */
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): void {
    if (this.status === 'closed') return;
    const env: Envelope = { t, seq: this.nextClientSeq++, d };
    this.unacked.push(env);
    if (this.unacked.length > this.maxQueue) this.unacked.splice(0, this.unacked.length - this.maxQueue);
    if (this.isOpen()) this.write(env);
  }

  /** Subscribes to one server message type. Returns an unsubscribe function. */
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T], env: Envelope<T, ServerMsgMap[T]>) => void): () => void {
    let set = this.handlers.get(t);
    if (!set) this.handlers.set(t, (set = new Set()));
    const h = cb as unknown as Handler;
    set.add(h);
    return () => set.delete(h);
  }

  /** Connection status changes, for a reconnect banner. */
  onStatus(cb: (s: SocketStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  get state(): SocketStatus {
    return this.status;
  }

  /** Number of client messages not yet acked by the server. */
  get pending(): number {
    return this.unacked.length;
  }

  close(): void {
    if (this.status === 'closed') return;
    this.setStatus('closed');
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onopen = null;
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
    this.firstOpen?.reject(new Error('socket closed'));
    this.firstOpen = null;
  }

  // ---------- internals ----------

  private open(status: 'connecting' | 'reconnecting'): void {
    this.setStatus(status);
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);
    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      // onclose follows and drives the reconnect.
    };
  }

  private handleOpen(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.attempt = 0;
    this.setStatus('open');
    this.write({ t: 'hello', seq: 0, d: { client_token: this.clientToken, last_seq: this.lastServerSeq } });
    for (const env of this.unacked) this.write(env);
    this.heardSincePing = true;
    this.pingTimer = setInterval(() => this.tickPing(), this.pingMs);
    this.firstOpen?.resolve();
    this.firstOpen = null;
  }

  private handleMessage(ev: MessageEvent): void {
    this.heardSincePing = true;
    let env: Envelope;
    try {
      env = JSON.parse(String(ev.data)) as Envelope;
    } catch {
      return;
    }
    if (!env || typeof env.t !== 'string') return;
    if (typeof env.ack === 'number') this.ackUpTo(env.ack);
    if (typeof env.seq === 'number' && env.seq > 0) {
      if (env.seq <= this.lastServerSeq) return; // already seen (replay overlap)
      this.lastServerSeq = env.seq;
    }
    const set = this.handlers.get(env.t);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(env.d as never, env);
      } catch (err) {
        console.error('socket handler failed', env.t, err);
      }
    }
  }

  private handleClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.status === 'closed') return;
    this.setStatus('reconnecting');
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 4000;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status !== 'closed') this.open('reconnecting');
    }, delay);
  }

  private tickPing(): void {
    if (!this.isOpen()) return;
    if (!this.heardSincePing) {
      // Nothing for a whole interval: treat the link as dead and reconnect.
      const ws = this.ws;
      if (ws) {
        try {
          ws.close(4000);
        } catch {
          // ignore
        }
        this.handleClose(ws);
      }
      return;
    }
    this.heardSincePing = false;
    this.write({ t: 'ping', seq: 0, d: {} });
  }

  private ackUpTo(seq: number): void {
    let n = 0;
    while (n < this.unacked.length && (this.unacked[n]?.seq ?? Infinity) <= seq) n++;
    if (n > 0) this.unacked.splice(0, n);
  }

  private write(env: Envelope): void {
    try {
      this.ws?.send(JSON.stringify(env));
    } catch {
      // The close handler reconnects; unacked messages are replayed then.
    }
  }

  private isOpen(): boolean {
    return this.status === 'open' && this.ws?.readyState === OPEN;
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const cb of [...this.statusHandlers]) cb(s);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }
}
