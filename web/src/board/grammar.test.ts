import { describe, expect, it } from 'vitest';
import { inferComponentType, parseLabelCommand, parseLabelStatement, voiceLabel } from './grammar';
import { emptyBoard } from './model';

describe('parseLabelCommand (instant labels)', () => {
  it.each([
    ['call that the order service', 'Order service'],
    ['Name it Redis.', 'Redis'],
    ['label this API gateway', 'API gateway'],
    ['OK, call this one the payments service', 'Payments service'],
    ['rename it to user DB', 'User DB'],
    ['call that as the edge cache please', 'Edge cache'],
    ['call it a load balancer', 'Load balancer'],
  ])('label_grammar: %s', (text, label) => {
    expect(parseLabelCommand(text)).toEqual({ label });
  });

  it.each([
    'I think that is fine',
    "I think that's fine",
    'call that',
    'so we call that service from the gateway',
    'call it a day',
    'call it a night',
    'call it even',
    'call it good',
    'call it quits',
    'call it fair enough',
    'call that a win',
    'call that a mistake',
    'call that fair',
    'call that a deal',
    'call it out',
    'call that out in the doc',
    'name a few',
    'name it later',
    'label that one',
    'call that the service that handles writes',
    // Statements never label at once.
    "that's the URL store",
    'this is our Kafka cluster',
    '',
  ])('label_grammar ignores %j', (text) => {
    expect(parseLabelCommand(text)).toBeNull();
  });
});

describe('parseLabelStatement (suggestions only)', () => {
  it.each([
    ["that's the URL store", 'URL store'],
    ['this is our Kafka cluster', 'Kafka cluster'],
    ['and that’s our fanout worker!', 'Fanout worker'],
    ['That is the read replica', 'Read replica'],
    ["it's the order service", 'Order service'],
  ])('%s', (text, label) => {
    expect(parseLabelStatement(text)).toEqual({ label });
  });

  it.each([
    "that's fine",
    "that's the problem",
    'this is a tricky one',
    "that's the main bottleneck",
    "it's the same thing",
    "that's the right call",
    "that's our biggest risk",
    'this is the part where it gets tricky',
    "that's the hard part",
    "it's the obvious choice",
    'this is our main concern here really because of the traffic spikes we expect',
    'call that the order service',
  ])('ignores %j', (text) => {
    expect(parseLabelStatement(text)).toBeNull();
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

  it('needs a fresh focus card to name (the caller passes it; null when stale)', () => {
    expect(voiceLabel(board, 'call that the order service', null)).toBeNull();
    expect(voiceLabel(board, 'call that the order service', 'i1')).toBeNull();
    expect(voiceLabel(board, 'call that the order service', 'gone')).toBeNull();
    expect(voiceLabel(board, 'call that the order service', 'n1')).toEqual({ id: 'n1', label: 'Order service', mode: 'commit' });
  });

  it('turns statements into suggestions, never commits', () => {
    expect(voiceLabel(board, "that's the URL store", 'n1')).toEqual({ id: 'n1', label: 'URL store', mode: 'suggest' });
    // Talk the review traced through the statement path: at most a suggestion, never a label.
    for (const t of ["that's the scaling bottleneck", "it's the latency", "that's the downside", 'this is the failure mode', "that's the hot path"]) {
      expect(voiceLabel(board, t, 'n1')?.mode ?? null).not.toBe('commit');
    }
    expect(voiceLabel(board, "that's the URL store", null)).toBeNull();
  });
});

describe('inferComponentType (what a spoken name says a drawn box is)', () => {
  it.each([
    ['Seat table', 'db'],
    ['Orders database', 'db'],
    ['User DB', 'db'],
    ['Postgres', 'db'],
    ['URL store', 'db'],
    ['Redis', 'cache'],
    ['Edge cache', 'cache'],
    ['Job queue', 'queue'],
    ['Kafka', 'queue'],
    ['Event stream', 'queue'],
    ['S3 bucket', 'object_store'],
    ['Blob storage', 'object_store'],
    ['Object store', 'object_store'],
    ['Search index', 'search'],
    ['Hold sweeper', 'worker'],
    ['Cron', 'worker'],
    ['API gateway', 'api_gateway'],
    ['Load balancer', 'lb'],
    ['LB', 'lb'],
    ['CDN', 'cdn'],
    ['Mobile app', 'client'],
    ['Browser', 'client'],
    ['Dynamo', 'kv'],
  ])('%s is a %s', (label, type) => {
    expect(inferComponentType(label)).toBe(type);
  });

  it.each(['Order service', 'Ticket service', 'App server', 'Payments API', 'Checkout', 'Restore', 'Tablet'])(
    '%s says nothing about the type (it stays a service)',
    (label) => {
      expect(inferComponentType(label)).toBeNull();
    },
  );
});
