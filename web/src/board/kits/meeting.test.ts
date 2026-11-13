import { describe, expect, it } from 'vitest';
import type { Board, BoardOp } from '../../shared/types';
import { BoardInput } from '../input';
import { emptyBoard } from '../model';
import { BoardStore } from '../ops';
import { FakeAdapter } from '../testkit';
import { agendaRowRect, MEETING_KIT, numberCardRect, SCREEN } from './meeting';

function meetingBoard(): Board {
  return {
    ...emptyBoard({ kit: 'meeting' }),
    meeting: {
      agenda: [
        { id: 'a1', text: 'Problem', done: false, t: null },
        { id: 'a2', text: 'The ask', done: false, t: null },
      ],
      numbers: [
        { id: 'k1', label: 'Payback', value: '8 months' },
        { id: 'k2', label: 'Cost', value: '120k' },
      ],
      shown: [],
      parked: ['What is the payback period?'],
    },
  };
}

function setup() {
  const store = new BoardStore(meetingBoard());
  const adapter = new FakeAdapter();
  const emitted: BoardOp[] = [];
  let t = 95;
  new BoardInput(store, adapter, MEETING_KIT, (op) => {
    emitted.push(op);
    store.apply(op, { local: true });
  }, { now_s: () => t });
  return { store, adapter, emitted, setT: (v: number) => (t = v) };
}

describe('meeting kit', () => {
  it('ticks and unticks an agenda item with a pinch on its row', () => {
    const { store, adapter, emitted, setT } = setup();
    const r = agendaRowRect(1);
    adapter.down(r.x + 4, r.y + r.h / 2);
    adapter.up(r.x + 4, r.y + r.h / 2);
    expect(emitted[0]).toMatchObject({ op: 'agenda.check', args: { id: 'a2', done: true, t: 95 } });
    setT(120);
    adapter.down(r.x + 4, r.y + r.h / 2);
    adapter.up(r.x + 4, r.y + r.h / 2);
    expect(emitted[1]).toMatchObject({ op: 'agenda.check', args: { id: 'a2', done: false, t: 120 } });
    expect(store.board.meeting!.agenda[1]).toMatchObject({ done: false, t: null });
  });

  it('agenda rows are hand sized (at least 2.2 cm tall)', () => {
    expect(agendaRowRect(0).h).toBeGreaterThanOrEqual(2.2);
  });

  it('a number card dropped on the screen pad is shown; dropped elsewhere nothing happens', () => {
    const { store, adapter, emitted } = setup();
    const c = numberCardRect(0);
    adapter.stroke([[c.x + 2, c.y + 2], [30, 30], [10, 30]]);
    expect(emitted).toEqual([]);
    adapter.stroke([[c.x + 2, c.y + 2], [40, 28], [SCREEN.x + SCREEN.w / 2, SCREEN.y + SCREEN.h / 2]]);
    expect(emitted[0]).toMatchObject({ op: 'present.show', args: { kind: 'number', ref: 'k1', t: 95 } });
    expect(store.board.meeting!.shown).toHaveLength(1);
  });

  it('has no tray and draws nothing outside the board data', () => {
    expect(MEETING_KIT.tray).toEqual([]);
  });
});
