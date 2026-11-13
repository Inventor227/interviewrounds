import { describe, expect, it } from 'vitest';
import { seatLayout, userPoint, wallboardPose, AVATAR_DESK_Y } from './seats';

const DEG = Math.PI / 180;

/** Angle between the seat's facing (local +Z turned by yaw) and the direction to p, in degrees. */
function angleTo(seat: { pos: { x: number; z: number }; yaw: number }, p: { x: number; z: number }): number {
  const fx = Math.sin(seat.yaw);
  const fz = Math.cos(seat.yaw);
  const dx = p.x - seat.pos.x;
  const dz = p.z - seat.pos.z;
  const cos = (fx * dx + fz * dz) / Math.hypot(dx, dz);
  return Math.acos(Math.min(1, Math.max(-1, cos))) / DEG;
}

describe('seatLayout', () => {
  for (const yaw of [0, 0.7, -2.4]) {
    const desk = { origin: { x: 0.3, y: 0.74, z: -0.5 }, yaw, deskY: 0.74 };

    it(`seat_layout_faces_user (yaw ${yaw})`, () => {
      const user = userPoint(desk);
      const [lead] = seatLayout(1, desk);
      expect(lead!.lead).toBe(true);
      expect(angleTo(lead!, user)).toBeLessThan(2);
      // Lead sits 1.2 m across from the user.
      expect(Math.hypot(lead!.pos.x - user.x, lead!.pos.z - user.z)).toBeCloseTo(1.2, 6);
      // Hands land on the desk: the avatar root sits AVATAR_DESK_Y below the desk top.
      expect(lead!.pos.y).toBeCloseTo(0.74 - AVATAR_DESK_Y, 6);
    });

    it(`three_seats_1_5_m_apart_and_turned_in (yaw ${yaw})`, () => {
      const user = userPoint(desk);
      const seats = seatLayout(3, desk);
      expect(seats).toHaveLength(3);
      expect(seats.filter((s) => s.lead)).toHaveLength(1);
      const [, a, b] = seats;
      expect(Math.hypot(a!.pos.x - b!.pos.x, a!.pos.z - b!.pos.z)).toBeCloseTo(1.5, 6);
      for (const s of [a!, b!]) {
        // Turned 12 degrees from straight across, toward the user.
        let d = s.yaw - yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        expect(Math.abs(d) / DEG).toBeCloseTo(12, 4);
        const straight = angleTo({ pos: s.pos, yaw }, user);
        expect(angleTo(s, user)).toBeCloseTo(straight - 12, 4);
      }
    });
  }

  it('two_seats_keep_the_lead_in_the_middle', () => {
    const desk = { origin: { x: 0, y: 0.7, z: -0.4 }, yaw: 0, deskY: 0.7 };
    const [lead, other] = seatLayout(2, desk);
    expect(lead!.lead).toBe(true);
    expect(lead!.pos.x).toBeCloseTo(0, 6);
    expect(Math.abs(other!.pos.x)).toBeCloseTo(0.75, 6);
  });

  it('wallboard_stands_behind_the_panel_facing_the_user', () => {
    const desk = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74 };
    const seats = seatLayout(1, desk);
    const wb = wallboardPose(desk);
    expect(wb.pos.z).toBeLessThan(seats[0]!.pos.z - 0.5);
    expect(wb.pos.y).toBeGreaterThan(0.74 + 0.5);
    expect(angleTo(wb, userPoint(desk))).toBeLessThan(1);
  });
});
