// The people across the desk: one avatar per panelist, seated on the room's seats. They appear
// only once loaded and seated (a short fade), look at the user (or at the panelist who is
// talking), follow their voice's mode, lip sync to its audio and nod at the user's pauses.

import type { Panelist } from '../shared/types';
import type { AvatarMode, AvatarPort } from './ports';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The parts of the avatar runtime's Avatar that the room uses (tests pass a fake). */
export interface AvatarLike {
  readonly root: { visible: boolean };
  place(seat: { position: Vec3; yaw: number; deskY: number }): void;
  setMode(mode: AvatarMode): void;
  lookAt(world: Vec3 | null): void;
  pointAt(world: Vec3 | null, seconds?: number): void;
  attachVoice(stream: MediaStream): Promise<unknown>;
  setUserSpeaking(active: boolean): void;
  update(dt: number): void;
  /** Body detail: 0 full (the first seat), 1 simplified (the others). */
  setDetail?(level: 0 | 1): unknown;
  dispose(): void;
}

/** A seat as the room lays it out (xr/seats.ts SeatPose). */
export interface RoomSeat {
  seat: 0 | 1 | 2;
  /** Avatar root, on its floor. */
  pos: Vec3;
  yaw: number;
  /** Where the seated eyes are. */
  eye: Vec3;
}

/** Height of the table top above the avatar's floor (the seated clips were made for it). */
export const SEAT_DESK_ABOVE_ROOT = 0.74;
/** Seconds an avatar takes to fade in once it is loaded and seated. */
export const FADE_IN_S = 0.5;
/** A panelist who is not speaking animates every this many frames (half rate); the one speaking, every frame. */
export const IDLE_FRAME_STRIDE = 2;

export interface PeopleOptions {
  panel: Panelist[];
  /** Loads the avatar for a manifest id (model, clips). */
  load(avatarId: string, panelist: Panelist): Promise<AvatarLike>;
  /** Puts a loaded avatar into the room (hidden until seated). */
  attach(avatar: AvatarLike, panelist: Panelist): void;
  /** Sets how far an avatar has faded in, 0 to 1. */
  fade?(avatar: AvatarLike, k: number): void;
  /** People appeared: the scene got heavier (the frame rate choice starts over). */
  onAppear?(): void;
}

interface Person {
  panelist: Panelist;
  avatar: AvatarLike | null;
  seat: RoomSeat | null;
  mode: AvatarMode;
  voice: MediaStream | null;
  /** Fade progress 0..1; null until the avatar first shows. */
  fade: number | null;
  /** Time not yet given to the avatar's animation (it skips frames while not speaking). */
  owed: number;
}

export class People {
  private readonly people: Person[];
  private userSpeaking = false;
  private disposed = false;
  private frame = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly opts: PeopleOptions) {
    this.people = opts.panel.map((panelist) => ({ panelist, avatar: null, seat: null, mode: 'idle', voice: null, fade: null, owed: 0 }));
  }

  /** Loads every panelist's avatar. One that fails to load leaves its seat empty; the voice still works. */
  load(): Promise<void> {
    this.loading ??= Promise.all(
      this.people.map(async (p) => {
        try {
          const avatar = await this.opts.load(p.panelist.avatar_id, p.panelist);
          if (this.disposed) return avatar.dispose();
          avatar.root.visible = false;
          this.opts.attach(avatar, p.panelist);
          p.avatar = avatar;
          // What the round already said while this avatar was loading.
          avatar.setMode(p.mode);
          avatar.setUserSpeaking(this.userSpeaking);
          if (p.voice) void avatar.attachVoice(p.voice).catch(() => undefined);
          if (p.seat) this.seat(p);
        } catch (err) {
          console.warn('[room] avatar failed to load', p.panelist.avatar_id, err);
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  /** Seats everyone: a panelist takes the seat with its number, else the next free one. */
  place(seats: RoomSeat[]): void {
    const free = [...seats];
    for (const p of this.people) {
      let i = free.findIndex((s) => s.seat === p.panelist.seat);
      if (i < 0) i = 0;
      p.seat = free.splice(i, 1)[0] ?? null;
      if (p.avatar && p.seat) this.seat(p);
    }
  }

  private seat(p: Person): void {
    const s = p.seat!;
    p.avatar!.place({ position: s.pos, yaw: s.yaw, deskY: s.pos.y + SEAT_DESK_ABOVE_ROOT });
    // The lead seat, straight across, keeps the full body; the side seats are further away.
    void Promise.resolve(p.avatar!.setDetail?.(s.seat === 0 ? 0 : 1)).catch(() => undefined);
  }

  /** Every frame: gaze, fade and the avatars' own animation. `head` is the user's head. */
  update(dt: number, head: Vec3): void {
    const speaker = this.people.find((p) => p.mode === 'speaking' && p.seat) ?? null;
    let appeared = false;
    this.frame++;
    for (const [i, p] of this.people.entries()) {
      const a = p.avatar;
      if (!a || !p.seat) continue;
      if (p.fade === null) {
        p.fade = 0;
        a.root.visible = true;
        this.opts.fade?.(a, 0);
        appeared = true;
      } else if (p.fade < 1) {
        p.fade = Math.min(1, p.fade + dt / FADE_IN_S);
        this.opts.fade?.(a, p.fade);
      }
      // A panelist who is not talking looks at the one who is; everyone else looks at the user.
      a.lookAt(speaker && speaker !== p ? speaker.seat!.eye : head);
      // Lip sync and beats need every frame; a listener's breathing and gaze do not. Staggered by seat, so two
      // listeners never animate on the same frame.
      p.owed += dt;
      const everyFrame = p.mode === 'speaking' || p.fade < 1;
      if (!everyFrame && (this.frame + i) % IDLE_FRAME_STRIDE !== 0) continue;
      a.update(p.owed);
      p.owed = 0;
    }
    if (appeared) this.opts.onAppear?.();
  }

  /** What the round controller drives for one panelist. */
  port(panelistId: string): AvatarPort | undefined {
    const p = this.people.find((x) => x.panelist.panelist_id === panelistId);
    if (!p) return undefined;
    return {
      setMode: (mode) => {
        p.mode = mode;
        p.avatar?.setMode(mode);
      },
      attachVoice: (stream) => {
        p.voice = stream;
        void p.avatar?.attachVoice(stream).catch(() => undefined);
      },
    };
  }

  /** The user started or stopped talking: listening nods land on the pauses. */
  setUserSpeaking(active: boolean): void {
    this.userSpeaking = active;
    for (const p of this.people) p.avatar?.setUserSpeaking(active);
  }

  /** A panelist gestures at a point in the room (a card on the sheet). */
  pointAt(panelistId: string, world: Vec3): void {
    this.people.find((x) => x.panelist.panelist_id === panelistId)?.avatar?.pointAt(world);
  }

  /** Where each seated panelist's eyes are, for the head sampler. */
  eyes(): { id: string; pos: Vec3 }[] {
    return this.people.filter((p) => p.seat).map((p) => ({ id: p.panelist.panelist_id, pos: p.seat!.eye }));
  }

  get loadedCount(): number {
    return this.people.filter((p) => p.avatar).length;
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.people) {
      p.avatar?.dispose();
      p.avatar = null;
    }
  }
}
