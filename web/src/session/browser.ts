// Browser implementations of the controller's ports that do not belong to another lane:
// mic and audio unlock, the transport factory, the socket factory and page visibility.

import { SessionSocket } from '../net/ws';
import type { CreateSessionRes, Panelist } from '../shared/types';
import { resumeAudio } from '../voice/audio';
import { FakeTransport } from '../voice/fake';
import { FishTransport } from '../voice/fish';
import { MIC_CONSTRAINTS, type TransportOptions, type VoiceTransport } from '../voice/transport';
import type { MediaPort, SocketPort, VisibilityPort } from './ports';

export const browserMedia: MediaPort = {
  async getMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('getUserMedia is not available'), { name: 'NotFoundError' });
    }
    return navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
  },
  resumeAudio,
};

/** Fish voices go through Fish Agents; everything else uses the typed-turn fake. */
export function makeTransport(settings: { voice_speed?: number } = {}) {
  return (p: Panelist, _opts: TransportOptions | undefined, res: CreateSessionRes): VoiceTransport =>
    p.voice.transport === 'fish'
      ? new FishTransport(p)
      : new FakeTransport(p, {
          sessionId: res.session_id,
          clientToken: res.client_token,
          rate: settings.voice_speed ?? 1,
        });
}

export const makeSocket = (wsUrl: string, clientToken: string, lastSeq = 0): SocketPort => new SessionSocket(wsUrl, clientToken, { lastSeq });

export const pageVisibility: VisibilityPort | undefined = typeof document === 'undefined' ? undefined : document;

/** `?debug=1` turns on the dev console and the latency overlay. */
export function isDebug(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}
