import { describe, expect, it } from 'vitest';
import type { Catalog } from '../shared/types';
import { roundAvatars } from './prefetch';

const catalog = {
  roles: [],
  meeting_templates: [],
  personas: [
    { id: 'persona.daniel', display_name: 'Daniel', title: '', avatar_id: 'm02', style: 'neutral' },
    { id: 'maya', display_name: 'Maya', title: '', avatar_id: 'f01', style: 'neutral' },
  ],
  rounds: [
    { id: 'a.short', panel: { lead: 'daniel', second: null } },
    { id: 'a.full', panel: { lead: 'daniel', second: 'maya' } },
  ],
} as unknown as Catalog;

describe('prefetch', () => {
  it('round_avatars_come_from_the_panel_personas', () => {
    expect(roundAvatars(catalog, 'a.short')).toEqual(['m02']);
    expect(roundAvatars(catalog, 'a.full')).toEqual(['m02', 'f01']);
    expect(roundAvatars(catalog, 'nope')).toEqual([]);
  });
});
