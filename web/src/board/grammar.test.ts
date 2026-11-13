import { describe, expect, it } from 'vitest';
import { parseLabelCommand } from './grammar';

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
    '',
  ])('label_grammar ignores %j', (text) => {
    expect(parseLabelCommand(text)).toBeNull();
  });
});
