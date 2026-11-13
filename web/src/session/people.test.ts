import { describe, expect, it, vi } from 'vitest';
import { panelist } from '../voice/testkit';
import { FADE_IN_S, People, type AvatarLike, type RoomSeat, type Vec3 } from './people';

function fakeAvatar() {
  const calls: string[] = [];
  const a = {
    root: { visible: true },
    looks: [] as (Vec3 | null)[],
    placed: null as { position: Vec3; yaw: number; deskY: number } | null,
    points: [] as (Vec3 | null)[],
    calls,
    place(seat: { position: Vec3; yaw: number; deskY: number }) {
      a.placed = seat;
    },
    setMode: (m: string) => void calls.push(`mode:${m}`),
    lookAt: (w: Vec3 | null) => void a.looks.push(w),
    pointAt: (w: Vec3 | null) => void a.points.push(w),
    attachVoice: vi.fn(async () => undefined),
    setUserSpeaking: (b: boolean) => void calls.push(`user:${b}`),
    update: vi.fn(),
    dispose: vi.fn(),
  };
  return a satisfies AvatarLike;
}

const seat = (n: 0 | 1 | 2, x: number): RoomSeat => ({ seat: n, pos: { x, y: 0.02, z: -1.4 }, yaw: 0.1 * n, eye: { x, y: 1.31, z: -1.4 } });
const HEAD = { x: 0, y: 1.2, z: 0 };

function setup(n = 2) {
  const panel = [panelist('p1', 0), panelist('p2', 1)].slice(0, n);
  const avatars = new Map<string, ReturnType<typeof fakeAvatar>>();
  const gates = new Map<string, () => void>();
  const fades: [string, number][] = [];
  const onAppear = vi.fn();
  const attached: string[] = [];
  const people = new People({
    panel,
    load: (_id, p) =>
      new Promise((resolve) => {
        const a = fakeAvatar();
        avatars.set(p.panelist_id, a);
        gates.set(p.panelist_id, () => resolve(a));
      }),
    attach: (_a, p) => void attached.push(p.panelist_id),
    fade: (a, k) => void fades.push([[...avatars].find(([, v]) => v === a)![0], k]),
    onAppear,
  });
  return { people, avatars, gates, fades, onAppear, attached };
}

describe('people in the room', () => {
  it('an_avatar_shows_only_once_loaded_and_seated_then_fades_in', async () => {
    const { people, avatars, gates, fades, onAppear, attached } = setup(1);
    const loading = people.load();
    people.place([seat(0, 0)]);
    people.update(0.016, HEAD); // not loaded yet: nothing to show
    expect(onAppear).not.toHaveBeenCalled();

    gates.get('p1')!();
    await loading;
    const a = avatars.get('p1')!;
    expect(attached).toEqual(['p1']);
    expect(a.root.visible).toBe(false);
    expect(a.placed).toEqual({ position: { x: 0, y: 0.02, z: -1.4 }, yaw: 0, deskY: 0.76 });

    people.update(0.016, HEAD);
    expect(a.root.visible).toBe(true);
    expect(onAppear).toHaveBeenCalledTimes(1);
    expect(fades).toEqual([['p1', 0]]);
    people.update(FADE_IN_S / 2, HEAD);
    people.update(FADE_IN_S, HEAD);
    people.update(0.016, HEAD);
    expect(fades.map((f) => f[1])).toEqual([0, 0.5, 1]); // stops once fully in
    expect(onAppear).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledTimes(4);
  });

  it('loaded_before_placement_stays_hidden_until_the_desk_is_down', async () => {
    const { people, avatars, gates } = setup(1);
    const loading = people.load();
    gates.get('p1')!();
    await loading;
    people.update(0.016, HEAD);
    expect(avatars.get('p1')!.root.visible).toBe(false);
    people.place([seat(0, 0)]);
    people.update(0.016, HEAD);
    expect(avatars.get('p1')!.root.visible).toBe(true);
  });

  it('panelists_take_their_own_seats_and_look_at_the_user_or_the_speaker', async () => {
    const { people, avatars, gates } = setup(2);
    const loading = people.load();
    gates.get('p1')!();
    gates.get('p2')!();
    await loading;
    // Seats arrive in any order; each panelist takes the one with its number.
    people.place([seat(1, -0.75), seat(0, 0)]);
    const [a1, a2] = [avatars.get('p1')!, avatars.get('p2')!];
    expect(a1.placed!.position.x).toBe(0);
    expect(a2.placed!.position.x).toBe(-0.75);

    people.update(0.016, HEAD);
    expect(a1.looks.at(-1)).toEqual(HEAD);
    expect(a2.looks.at(-1)).toEqual(HEAD);

    people.port('p1')!.setMode('speaking');
    people.update(0.016, HEAD);
    expect(a1.looks.at(-1)).toEqual(HEAD); // the speaker keeps eye contact with the user
    expect(a2.looks.at(-1)).toEqual({ x: 0, y: 1.31, z: -1.4 }); // the other one looks at the speaker

    people.port('p1')!.setMode('listening');
    people.update(0.016, HEAD);
    expect(a2.looks.at(-1)).toEqual(HEAD);
    expect(people.eyes().map((e) => e.id)).toEqual(['p1', 'p2']);
  });

  it('mode_voice_and_user_speech_reach_an_avatar_that_loads_late', async () => {
    const { people, avatars, gates } = setup(1);
    const loading = people.load();
    const stream = {} as MediaStream;
    people.port('p1')!.setMode('speaking');
    people.port('p1')!.attachVoice(stream);
    people.setUserSpeaking(true);
    gates.get('p1')!();
    await loading;
    const a = avatars.get('p1')!;
    expect(a.calls).toEqual(['mode:speaking', 'user:true']);
    expect(a.attachVoice).toHaveBeenCalledWith(stream);
    people.setUserSpeaking(false);
    expect(a.calls.at(-1)).toBe('user:false');
    expect(people.port('nobody')).toBeUndefined();
  });

  it('a_failed_avatar_leaves_the_seat_empty_and_dispose_frees_the_rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = fakeAvatar();
    const people = new People({
      panel: [panelist('p1', 0), panelist('p2', 1)],
      load: async (_id, p) => {
        if (p.panelist_id === 'p2') throw new Error('404');
        return ok;
      },
      attach: () => undefined,
    });
    await people.load();
    expect(people.loadedCount).toBe(1);
    people.place([seat(0, 0), seat(1, -0.75)]);
    people.update(0.016, HEAD);
    people.pointAt('p1', { x: 0.1, y: 0.8, z: -0.5 });
    people.pointAt('p2', { x: 0.1, y: 0.8, z: -0.5 }); // no avatar: ignored
    expect(ok.points).toEqual([{ x: 0.1, y: 0.8, z: -0.5 }]);
    people.dispose();
    expect(ok.dispose).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
