import { describe, expect, it, vi } from 'vitest';
import type { Report, RoundStatePayload } from '../shared/types';
import { createXRPort, type XRAppLike } from './port';
import type { RoundAction } from './ui/types';

function fakeApp() {
  const listeners = new Set<(a: RoundAction) => void>();
  const app = {
    enter: vi.fn(async () => {}),
    exit: vi.fn(),
    place: vi.fn(async () => ({ origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74, source: 'touch' as const })),
    room: {
      seatPoses: () => [{ seat: 0 as const, lead: true, pos: { x: 0, y: 0, z: -1.4 }, yaw: 0.1, eye: { x: 0, y: 1.29, z: -1.4 } }],
    },
    ui: {
      setRoundState: vi.fn(),
      showSummary: vi.fn(),
      setStatus: vi.fn(),
      hideStatus: vi.fn(),
      showStatusText: vi.fn(),
      onAction: (cb: (a: RoundAction) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  };
  const press = (a: RoundAction) => listeners.forEach((cb) => cb(a));
  return { app: app as unknown as XRAppLike & typeof app, press };
}

const ROUND: RoundStatePayload = {
  status: 'live',
  phase_id: 'p1',
  phase_index: 0,
  phases: [{ id: 'p1', minutes: 8 }],
  elapsed_s: 60,
  remaining_s: 420,
  phase_remaining_s: 420,
  brief: { question: 'Design a URL shortener.', lines: ['100M links a day'] },
  floor: 'daniel',
};

describe('createXRPort', () => {
  it('place_resolves_once_the_app_has_placed_the_desk', async () => {
    const { app } = fakeApp();
    const port = createXRPort(app);
    await port.enter();
    await expect(port.place()).resolves.toBeUndefined();
    expect(app.place).toHaveBeenCalledTimes(1);
  });

  it('round_state_maps_to_the_round_bar', () => {
    const { app } = fakeApp();
    createXRPort(app).ui.setRoundState({ ...ROUND, controller: 'live' });
    expect(app.ui.setRoundState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'live', elapsed_s: 60, total_s: 480, muted: false, brief: ROUND.brief }),
    );
  });

  it('a_paused_controller_shows_paused_and_mute_is_remembered', () => {
    const { app, press } = fakeApp();
    const port = createXRPort(app);
    port.ui.onAction(() => {});
    press('mute');
    port.ui.setRoundState({ ...ROUND, controller: 'paused' });
    expect(app.ui.setRoundState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused', muted: true }));
  });

  it('the_tap_to_hear_status_gets_its_button_and_other_lines_are_plain_text', () => {
    const { app } = fakeApp();
    const port = createXRPort(app);
    port.ui.setStatus('Tap to hear your interviewer');
    expect(app.ui.setStatus).toHaveBeenCalledWith('hear');
    port.ui.setStatus('Writing your scorecard', 0.4);
    expect(app.ui.showStatusText).toHaveBeenCalledWith('Writing your scorecard', 0.4);
    port.ui.setStatus(null);
    expect(app.ui.hideStatus).toHaveBeenCalled();
  });

  it('actions_pass_through_except_the_local_captions_toggle', () => {
    const { app, press } = fakeApp();
    const seen: string[] = [];
    createXRPort(app).ui.onAction((a) => seen.push(a));
    for (const a of ['mute', 'captions', 'hear', 'end', 'retry'] as RoundAction[]) press(a);
    expect(seen).toEqual(['mute', 'hear', 'end', 'retry']);
  });

  it('seat_poses_use_position', () => {
    const { app } = fakeApp();
    expect(createXRPort(app).room.seatPoses()).toEqual([{ position: { x: 0, y: 0, z: -1.4 }, yaw: 0.1 }]);
  });

  it('summary_passes_the_report', () => {
    const { app } = fakeApp();
    const r = { schema_version: '1.0' } as Report;
    createXRPort(app).ui.showSummary(r);
    expect(app.ui.showSummary).toHaveBeenCalledWith(r);
  });
});
