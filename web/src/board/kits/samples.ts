// Start boards for the 2D sandbox and the emulator shots: what the server would hand over at
// the start of each kind of round (an empty code block for coding, the agenda and key numbers
// for a meeting). Dev and tests only.
import type { Board, BoardKit } from '../../shared/types';
import { emptyBoard } from '../model';

export function sampleStartBoard(kit: BoardKit): Board {
  switch (kit) {
    case 'hld':
      return emptyBoard({ id: 'dev', kit, question: 'Design a URL shortener' });
    case 'lld':
      return emptyBoard({ id: 'dev', kit, question: 'Design a parking lot' });
    case 'pm':
      return emptyBoard({ id: 'dev', kit, question: 'Improve parking for office commuters' });
    case 'coding':
      return {
        ...emptyBoard({ id: 'dev', kit, question: 'Two sum: return the indices of two numbers that add up to target' }),
        round: { id: 'dev', type: 'coding', question_id: null, language: 'python' },
        code: { language: 'python', lines: [], approach: [], complexity: { time: null, space: null }, trace: [] },
      };
    case 'meeting':
      return {
        ...emptyBoard({ id: 'dev', kit, question: 'Pitch a four day work week to the leadership team' }),
        meeting: {
          agenda: [
            { id: 'a1', text: 'The problem we see', done: false, t: null },
            { id: 'a2', text: 'What a pilot looks like', done: false, t: null },
            { id: 'a3', text: 'Cost and risks', done: false, t: null },
            { id: 'a4', text: 'The ask', done: false, t: null },
          ],
          numbers: [
            { id: 'k1', label: 'Attrition now', value: '18%' },
            { id: 'k2', label: 'Pilot cost', value: '40k' },
            { id: 'k3', label: 'Payback', value: '8 months' },
            { id: 'k4', label: 'Teams in pilot', value: '3' },
          ],
          shown: [],
          parked: [],
        },
      };
  }
}
