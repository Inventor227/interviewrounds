// Test doubles for voice transports. Used by the panel and controller tests only.

import type { CreateSessionRes, Panelist, VoiceMode } from '../shared/types';
import { Emitter, type TransportEvents, type TransportOptions, type VoiceTransport } from './transport';

export class ScriptedTransport implements VoiceTransport {
  readonly events = new Emitter<TransportEvents>();
  muted = true;
  started = false;
  stopped = false;
  sentEvents: string[] = [];
  sentTexts: string[] = [];
  interrupts = 0;
  activity = 0;
  audioStarts = 0;
  stream: MediaStream | null = null;
  /** The agent's output loudness the test sets (0..1). */
  level = 0;

  constructor(
    readonly panelistId: string,
    private readonly log: string[] = [],
    readonly opts: TransportOptions = {},
    readonly panelist?: Panelist,
  ) {}

  async start(): Promise<void> {
    this.log.push(`start:${this.panelistId}`);
    this.started = true;
  }
  async stop(): Promise<void> {
    this.log.push(`stop:${this.panelistId}`);
    this.stopped = true;
  }
  setMicMuted(m: boolean): void {
    this.log.push(`${m ? 'mute' : 'unmute'}:${this.panelistId}`);
    this.muted = m;
  }
  sendEvent(marker: string): void {
    this.log.push(`event:${this.panelistId}:${marker}`);
    this.sentEvents.push(marker);
  }
  sendText(text: string): void {
    this.sentTexts.push(text);
  }
  outputStream(): MediaStream | null {
    return this.stream;
  }
  outputLevel(): number {
    return this.level;
  }
  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): () => void {
    return this.events.on(event, cb);
  }
  interrupt(): void {
    this.interrupts++;
  }
  noteActivity(): void {
    this.activity++;
  }
  async startAudio(): Promise<void> {
    this.audioStarts++;
  }

  // ----- driven by the test -----
  mode(m: VoiceMode): void {
    this.events.emit('mode', m);
  }
  user(segmentId: string, text: string, final: boolean): void {
    this.events.emit('userTranscript', { segmentId, text, final });
  }
  agent(segmentId: string, delta: string, text = delta): void {
    this.events.emit('agentText', { segmentId, delta, text });
  }
}

export function panelist(id: string, seat: 0 | 1 | 2, voice: Panelist['voice'] = { transport: 'fake' }): Panelist {
  return {
    panelist_id: id,
    persona_id: `persona_${id}`,
    display_name: id.toUpperCase(),
    title: 'Engineer',
    avatar_id: 'f01',
    seat,
    voice,
  };
}

export function sessionRes(over: Partial<CreateSessionRes> = {}): CreateSessionRes {
  return {
    session_id: 'sess1',
    client_token: 'tok1',
    ws_url: '/ws/session/sess1',
    round: {
      id: 'beh_short',
      title: 'Behavioral',
      role: 'sde',
      round_type: 'behavioral',
      length: 'short',
      target_minutes: 15,
      phases: [{ id: 'intro', minutes: 2 }],
      hands: 'none',
      board_kit: null,
      panel: { lead: 'p1', second: 'p2' },
    },
    panel: [panelist('p1', 0), panelist('p2', 1)],
    floor: 'p1',
    panel_mode: 'swap',
    limits: { short_left_today: null, full_left: null, resets_at: null, reason: null },
    ...over,
  };
}
