import { describe, expect, it } from 'vitest';
import { emptyBoard } from './model';
import { parseLabelCommand, voiceLabel } from './grammar';

describe('parseLabelCommand', () => {
  it.each([
    ['call that the order service', 'Order service'],
    ['Name it Redis.', 'Redis'],
    ['label this API gateway', 'API gateway'],
    ["that's the URL store", 'URL store'],
    ['this is our Kafka cluster', 'Kafka cluster'],
    ['OK, call this one the payments service', 'Payments service'],
    ['rename it to user DB', 'User DB'],
    ['and that’s our fanout worker!', 'Fanout worker'],
    ['call that as the edge cache please', 'Edge cache'],
    ['That is the read replica', 'Read replica'],
  ])('label_grammar: %s', (text, label) => {
    expect(parseLabelCommand(text)).toEqual({ label });
  });

  it.each([
    'I think that is fine',
    "I think that's fine",
    "that's fine",
    "that's the problem",
    'this is a tricky one',
    'call that',
    'so we call that service from the gateway',
    'this is our main concern here really because of the traffic spikes we expect',
    // Ordinary talk that an earlier version labelled (review round 1).
    "that's the main bottleneck",
    "it's the same thing",
    "that's the right call",
    "that's our biggest risk",
    'this is the part where it gets tricky',
    'call it a day',
    'name it later',
    'call that out in the doc',
    'label that one',
    'call that the service that handles writes',
    "that's the hard part",
    "it's the obvious choice",
    '',
  ])('label_grammar ignores %j', (text) => {
    expect(parseLabelCommand(text)).toBeNull();
  });
});

describe('voiceLabel', () => {
  const board = {
    ...emptyBoard(),
    items: [
      { id: 'n1', kind: 'component' as const, type: 'service' as const, label: null, x: 1, y: 1, w: 8, h: 5 },
      { id: 'i1', kind: 'ink' as const, points: [[1, 1], [3, 3]] as [number, number][], recognized: null },
    ],
  };

  it('needs a focus card to name', () => {
    expect(voiceLabel(board, 'call that the order service')).toBeNull();
    expect(voiceLabel({ ...board, focus: 'i1' }, 'call that the order service')).toBeNull();
    expect(voiceLabel({ ...board, focus: 'gone' }, 'call that the order service')).toBeNull();
    expect(voiceLabel({ ...board, focus: 'n1' }, 'call that the order service')).toEqual({ id: 'n1', label: 'Order service' });
  });

  it('uses the fresh focus the caller passes (null once it is stale)', () => {
    expect(voiceLabel({ ...board, focus: 'n1' }, 'call that the order service', null)).toBeNull();
  });
});
