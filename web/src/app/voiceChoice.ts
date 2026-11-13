// Which voice a new round asks for: the real one, or the typed-turn fake in fixture mode and when a
// development key is set for this tab (see net/api.ts devKey).

import { devKey } from '../net/api';
import type { VoiceChoice } from '../shared/types';
import { isFake } from './fake/mode';

export function voiceChoice(): VoiceChoice {
  return isFake() || devKey() ? 'fake' : 'fish';
}
