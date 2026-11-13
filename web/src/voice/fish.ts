// Fish Agents transport: one WebRTC (LiveKit) session per panelist through @fishaudio/agent-client.
//
// - The SDK captures the mic with echo cancellation, noise suppression and auto gain on, and
//   plays the agent through its own <audio> element. We never touch playback: Chromium's echo
//   canceller only sees audio played by media elements, so the agent must not go through WebAudio
//   output. outputStream() hands the remote track to lip sync for analysis only.
// - Markers go in as typed user turns with audio on, so the agent answers them out loud. The SDK
//   echoes typed turns back as user transcripts; marker echoes are dropped here.

import type { AgentSessionCallbacks, SessionToken as LiveKitSessionToken } from '@fishaudio/agent-client';
import type { FishSession, Panelist } from '../shared/types';
import { Emitter, isMarker, VoiceError, type TransportEvents, type VoiceErrorCode, type VoiceTransport } from './transport';

/** The AgentSession methods this transport uses (the SDK class satisfies it). */
export interface FishSessionLike {
  sendUserMessage(text: string, options?: { audio?: boolean }): void;
  sendUserActivity(): void;
  interrupt(): void;
  setMicMuted(muted: boolean): Promise<void>;
  startAudio(): Promise<void>;
  end(): Promise<void>;
  getRoom(): RoomLike | undefined;
}

/** The slice of a livekit-client Room needed to find the agent's audio track. */
export interface RoomLike {
  remoteParticipants: Map<
    string,
    { trackPublications: Map<string, { kind: string; track?: { mediaStreamTrack?: MediaStreamTrack } | undefined }> }
  >;
}

export interface FishStartOptions {
  sessionToken: LiveKitSessionToken;
  callbacks: Partial<AgentSessionCallbacks>;
  microphone: boolean;
  wakeLock: boolean;
}

export interface FishTransportOptions {
  /** AgentSession.start, injectable for tests. */
  start?: (opts: FishStartOptions) => Promise<FishSessionLike>;
}

const sdkStart = async (opts: FishStartOptions): Promise<FishSessionLike> => {
  // Loaded on demand: the 2D pages never pay for WebRTC.
  const { AgentSession } = await import('@fishaudio/agent-client');
  const session: FishSessionLike = await AgentSession.start(opts);
  return session;
};

/**
 * The server passes Fish's whole session response through (`{session_id, token, livekit_url,
 * expires_at, max_duration_seconds, ...}`, docs/protocol.md); the SDK gets all of it. Fields
 * the SDK's type wants and Fish left out get neutral values (it connects with `livekit_url` and
 * `token`, and skips the expiry check when the date does not parse).
 */
export function toSessionToken(fish: FishSession): LiveKitSessionToken {
  return {
    ...fish,
    transport: 'livekit',
    session_id: fish.session_id ?? '',
    expires_at: fish.expires_at == null ? '' : String(fish.expires_at),
    max_duration_seconds: typeof fish.max_duration_seconds === 'number' ? fish.max_duration_seconds : 0,
    livekit_url: fish.livekit_url,
    token: fish.token,
  } as LiveKitSessionToken;
}

/** A failed unmute is tried again after this long. */
export const UNMUTE_RETRY_MS = 300;

const ERROR_CODES: Record<string, VoiceErrorCode> = {
  mic_permission_denied: 'mic_denied',
  connection_failed: 'connect_failed',
  origin_forbidden: 'connect_failed',
  agent_not_public: 'connect_failed',
  session_request_failed: 'connect_failed',
  unsupported_transport: 'connect_failed',
  session_expired: 'session_expired',
  insufficient_credit: 'no_credit',
  provider_error: 'provider_error',
  internal_error: 'provider_error',
};

function toVoiceError(err: unknown): VoiceError {
  if (err instanceof VoiceError) return err;
  const code = (err as { code?: unknown })?.code;
  const mapped = (typeof code === 'string' && ERROR_CODES[code]) || 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  return new VoiceError(mapped, message, err);
}

export class FishTransport implements VoiceTransport {
  readonly panelistId: string;
  private readonly events = new Emitter<TransportEvents>();
  private readonly startFn: (opts: FishStartOptions) => Promise<FishSessionLike>;
  private session: FishSessionLike | null = null;
  private stopping = false;
  private muted = false;
  private stream: { track: MediaStreamTrack; stream: MediaStream } | null = null;

  constructor(
    private readonly panelist: Panelist,
    opts: FishTransportOptions = {},
  ) {
    this.panelistId = panelist.panelist_id;
    this.startFn = opts.start ?? sdkStart;
  }

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): () => void {
    return this.events.on(event, cb);
  }

  async start(): Promise<void> {
    const v = this.panelist.voice;
    if (v.transport !== 'fish') {
      throw new VoiceError('connect_failed', `panelist ${this.panelistId} has no Fish voice yet`);
    }
    const callbacks: Partial<AgentSessionCallbacks> = {
      onModeChange: (m) => this.events.emit('mode', m),
      onUserTranscript: (e) => {
        if (isMarker(e.text)) return;
        this.events.emit('userTranscript', { segmentId: e.segmentId, text: e.text, final: e.final });
      },
      onAgentResponseDelta: (e) => this.events.emit('agentText', { segmentId: e.segmentId, delta: e.delta, text: e.text }),
      onDisconnect: ({ reason }) => {
        this.session = null;
        this.events.emit('ended', { reason });
      },
      onError: (e) => {
        // The runtime still answers this turn by itself: nothing to show.
        if (e.recovered === true) return;
        this.events.emit('error', toVoiceError(e));
      },
    };
    let session: FishSessionLike;
    try {
      session = await this.startFn({
        sessionToken: toSessionToken(v.fish),
        callbacks,
        // A panelist muted before start (swap hand-over, joined non-floor) publishes no capture
        // until it is unmuted, so two sessions never hear the user at once.
        microphone: !this.muted,
        wakeLock: false,
      });
    } catch (err) {
      throw toVoiceError(err);
    }
    if (this.stopping) {
      // stop() came while we were connecting: end the session now, or it keeps billing.
      await session.end().catch(() => undefined);
      return;
    }
    this.session = session;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const s = this.session;
    this.session = null;
    this.stream = null;
    if (s) await s.end().catch(() => undefined);
  }

  /** Resolves once the SDK has muted or unmuted the capture track; a failure is reported as an error event. */
  setMicMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    const s = this.session;
    if (!s) return Promise.resolve();
    return s
      .setMicMuted(muted)
      .catch(async (e) => {
        // The SDK puts its own flag back when the toggle fails. An unmute is tried once more (the
        // first unmute after a muted start captures the mic there and then); only then is it reported,
        // as a mic problem, not as a lost connection.
        if (!muted && this.session === s && !this.muted) {
          await new Promise((r) => setTimeout(r, UNMUTE_RETRY_MS));
          if (this.session === s && !this.muted) return s.setMicMuted(false);
          return;
        }
        throw e;
      })
      .catch((e) => void this.events.emit('error', new VoiceError('mic_toggle_failed', 'Could not switch the microphone', e)));
  }

  sendEvent(marker: string): void {
    this.session?.sendUserMessage(marker, { audio: true });
  }

  sendText(text: string): void {
    this.session?.sendUserMessage(text, { audio: true });
  }

  interrupt(): void {
    this.session?.interrupt();
  }

  async startAudio(): Promise<void> {
    await this.session?.startAudio();
  }

  noteActivity(): void {
    this.session?.sendUserActivity();
  }

  outputStream(): MediaStream | null {
    const room = this.session?.getRoom();
    if (!room) return null;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const track = pub.kind === 'audio' ? pub.track?.mediaStreamTrack : undefined;
        if (!track) continue;
        if (this.stream?.track !== track) this.stream = { track, stream: new MediaStream([track]) };
        return this.stream.stream;
      }
    }
    return null;
  }
}
