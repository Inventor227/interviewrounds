// Adapter from the XR app to the round controller's XRPort (session/ports.ts). Thin on purpose: the controller owns
// the round; the app owns the room, the placement and the panels.

import type { ControllerState, SeatPoseLike, UiAction, XRPort } from '../session/ports';
import type { HeadsetCard, Report, RoundStatePayload } from '../shared/types';
import type { DeskPose } from './placement';
import type { SeatPose } from './seats';
import type { RoundAction, RoundUIState, StatusStage } from './ui/types';

/** The parts of XRApp the adapter needs (kept narrow so tests can fake it). */
export interface XRAppLike {
  enter(): Promise<void>;
  exit(): void;
  place(): Promise<DeskPose>;
  /** XR select events per hand (a pinch): user gestures. */
  onSelect?(cb: (hand: 'left' | 'right', phase: 'start' | 'end' | 'cancel', nowMs: number) => void): () => void;
  room: { seatPoses(): SeatPose[] };
  ui: {
    setRoundState(s: RoundUIState): void;
    showSummary(r: Report): void;
    showQuickCard(c: HeadsetCard): void;
    setStatus(stage: StatusStage, pct?: number | null): void;
    showStatusText(text: string, pct?: number | null): void;
    hideStatus(): void;
    onAction(cb: (a: RoundAction) => void): () => void;
  };
}

/** The controller's "audio seems blocked" line; it gets the Tap to hear button. */
const HEAR_LINE = /hear your interviewer/i;

export function createXRPort(app: XRAppLike): XRPort & { dispose(): void } {
  // The round state from the server has no mute flag: the bar keeps what the user last pressed, and shows a press
  // at once (re-rendered from the last round state) instead of waiting for the next state push.
  let muted = false;
  let last: RoundUIState | null = null;
  const show = (s: RoundUIState) => {
    last = s;
    app.ui.setRoundState(s);
  };
  const off = app.ui.onAction((a) => {
    if (a !== 'mute' && a !== 'unmute') return;
    muted = a === 'mute';
    if (last) show({ ...last, muted });
  });

  return {
    enter: () => app.enter(),
    place: () => app.place().then(() => undefined),
    exit: () => app.exit(),
    onGesture: (cb: () => void) => app.onSelect?.((_hand, phase) => phase === 'start' && cb()) ?? (() => {}),
    ui: {
      setRoundState(s: RoundStatePayload & { controller: ControllerState }) {
        const status = s.controller === 'paused' ? 'paused' : s.status;
        show({
          status,
          elapsed_s: s.elapsed_s,
          total_s: s.elapsed_s + s.remaining_s,
          muted,
          brief: s.brief,
        });
      },
      showSummary: (r: Report) => app.ui.showSummary(r),
      showCard: (c: HeadsetCard) => app.ui.showQuickCard(c),
      setStatus(text: string | null, progress?: number) {
        if (text === null) app.ui.hideStatus();
        else if (HEAR_LINE.test(text)) app.ui.setStatus('hear');
        else app.ui.showStatusText(text, progress ?? null);
      },
      onAction(cb: (a: UiAction) => void) {
        return app.ui.onAction((a) => {
          // Captions are a local view setting; everything else is the controller's.
          if (a !== 'captions') cb(a);
        });
      },
    },
    room: {
      seatPoses: (): SeatPoseLike[] => app.room.seatPoses().map((p) => ({ position: { ...p.pos }, yaw: p.yaw })),
    },
    /** Removes the port's own action listener (one port per round). */
    dispose: off,
  };
}
