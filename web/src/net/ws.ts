// Session WebSocket: /ws/session/{id}, envelope {"t", "seq", "d"} (docs/protocol.md).
//
// - First frame on every connection is `hello {client_token, last_seq}`, where last_seq is the
//   highest server seq we have seen, so the server can replay what we missed.
// - Reliable client messages (board.op, board.ghost_reject, transcript.mark, ui.event) get a seq
//   and stay queued until the server acks them (`ack` on any server frame = highest client seq
//   processed). After a reconnect they are replayed with the same seq, right after hello, so the
//   server can drop duplicates. At most 1000 are kept; an evicted one is reported (onDropped).
// - Telemetry (head.samples, voice.state) is sent only while open and never queued or replayed.
// - Server frames with a seq we already saw are dropped.
// - Ping every 20 s. If nothing arrived since the last ping, the link is dead: reconnect.
// - Reconnect backoff 0.5, 1, 2, 4 s (then 4 s). It resets only once a frame arrives on the new
//   connection, so a server that accepts and then drops us keeps backing off.
// - A server close with code 1000 or 4001-4999 (4401 bad token, 4404 unknown session, 4409
//   session ended) is final: no reconnect, status `closed`, onTerminal fires.

import type {
  ClientMsgMap,
  ClientMsgType,
  Envelope,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Client messages that are queued and replayed until acked. Everything else is lossy. */
export const RELIABLE_TYPES: ReadonlySet<ClientMsgType> = new Set<ClientMsgType>([
  'board.op',
  'board.ghost_reject',
  'transcript.mark',
  'ui.event',
]);

/** Close codes the server uses for a final close (docs/protocol.md). */
export const CLOSE_CODES = {
  normal: 1000,
  /** The client closes with this itself when the link looks dead; it reconnects. */
  deadLink: 4000,
  badToken: 4401,
  unknownSession: 4404,
  sessionEnded: 4409,
} as const;

/** True for a server close after which reconnecting cannot help. */
export function isTerminalClose(code: number): boolean {
  return code === CLOSE_CODES.normal || (code > CLOSE_CODES.deadLink && code <= 4999);
}

export interface CloseInfo {
  code: number;
  reason: string;
}

export class SocketClosedError extends Error {
  override readonly name = 'SocketClosedError';
  constructor(readonly info: CloseInfo | null) {
    super(info ? `socket closed (${info.code}${info.reason ? `: ${info.reason}` : ''})` : 'socket closed');
  }
}

export interface SessionSocketOptions {
  /** WebSocket constructor, injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: readonly number[];
  pingMs?: number;
  /** Unacked reliable messages kept for replay; beyond this the oldest is dropped and reported. */
  maxQueue?: number;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 4000] as const;
const OPEN = 1;

type Handler = (d: never, env: Envelope) => void;

function detachAndClose(ws: WebSocket, code: number): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    ws.close(code);
  } catch {
    // already closed
  }
}

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
  private readonly terminalHandlers = new Set<(info: CloseInfo) => void>();
  private readonly droppedHandlers = new Set<(env: Envelope) => void>();
  private firstOpen: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | null = null;
  private heardOnConnection = false;
  private finalClose: CloseInfo | null = null;

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
    if (this.status === 'closed') return Promise.reject(new SocketClosedError(this.finalClose));
    if (this.firstOpen) return this.firstOpen.promise;
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.firstOpen = { promise, resolve, reject };
    if (!this.ws && !this.reconnectTimer) this.open('connecting');
    return promise;
  }

  /**
   * Sends a client message. Reliable types are queued until acked and replayed after a
   * reconnect; telemetry is sent only while open and dropped otherwise. Returns false when the
   * message was dropped (socket closed, or telemetry while down).
   */
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): boolean {
    if (this.status === 'closed') return false;
    if (!RELIABLE_TYPES.has(t)) {
      if (!this.isOpen()) return false;
      this.write({ t, seq: this.nextClientSeq++, d });
      return true;
    }
    const env: Envelope = { t, seq: this.nextClientSeq++, d };
    this.unacked.push(env);
    while (this.unacked.length > this.maxQueue) {
      const dropped = this.unacked.shift();
      if (dropped) for (const cb of [...this.droppedHandlers]) cb(dropped);
    }
    if (this.isOpen()) this.write(env);
    return true;
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

  /** The server closed for good (bad token, unknown or ended session). Fires once. */
  onTerminal(cb: (info: CloseInfo) => void): () => void {
    this.terminalHandlers.add(cb);
    return () => this.terminalHandlers.delete(cb);
  }

  /** A reliable message was evicted from a full replay queue and will never be sent. */
  onDropped(cb: (env: Envelope) => void): () => void {
    this.droppedHandlers.add(cb);
    return () => this.droppedHandlers.delete(cb);
  }

  get state(): SocketStatus {
    return this.status;
  }

  /** Why the server closed for good, once it has. */
  get closeInfo(): CloseInfo | null {
    return this.finalClose;
  }

  /** Number of reliable client messages not yet acked by the server. */
  get pending(): number {
    return this.unacked.length;
  }

  close(): void {
    if (this.status === 'closed') return;
    this.setStatus('closed');
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) detachAndClose(ws, CLOSE_CODES.normal);
    this.firstOpen?.reject(new SocketClosedError(this.finalClose));
    this.firstOpen = null;
  }

  // ---------- internals ----------

  private open(status: 'connecting' | 'reconnecting'): void {
    this.setStatus(status);
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev: MessageEvent) => this.handleMessage(ws, ev);
    ws.onclose = (ev: CloseEvent) => this.handleClose(ws, ev);
    ws.onerror = () => {
      // onclose follows and drives the reconnect.
    };
  }

  private handleOpen(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.heardOnConnection = false;
    this.setStatus('open');
    this.write({ t: 'hello', seq: 0, d: { client_token: this.clientToken, last_seq: this.lastServerSeq } });
    for (const env of this.unacked) this.write(env);
    this.heardSincePing = true;
    this.pingTimer = setInterval(() => this.tickPing(), this.pingMs);
    this.firstOpen?.resolve();
    this.firstOpen = null;
  }

  private handleMessage(ws: WebSocket, ev: MessageEvent): void {
    if (ws !== this.ws) return;
    this.heardSincePing = true;
    if (!this.heardOnConnection) {
      // The server is really talking to us: the next drop starts the backoff again.
      this.heardOnConnection = true;
      this.attempt = 0;
    }
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

  private handleClose(ws: WebSocket, ev?: { code?: number; reason?: string }): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearTimers();
    if (this.status === 'closed') return;
    const code = ev?.code ?? 1006;
    if (ev && isTerminalClose(code)) {
      this.finalClose = { code, reason: ev.reason ?? '' };
      this.close();
      for (const cb of [...this.terminalHandlers]) cb(this.finalClose);
      return;
    }
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
        detachAndClose(ws, CLOSE_CODES.deadLink);
        this.handleClose(ws); // no event: always a transient close
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
