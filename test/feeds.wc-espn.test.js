// wc-espn normalizeEvents — locks the knockout match_id synthesis that keeps the
// result writer from dropping bracket scores (a group pair resolves to its
// scheduled match:<G>-MD<n>-… id; a cross-group knockout pair gets a stable
// match:KO-<sorted codes> id). handoffs/WC_KNOCKOUT_SHIP_2026-07-01.md.

import { describe, it, expect } from 'vitest';
import { __test__ } from '../src/feeds/wc-espn.js';

const { normalizeEvents } = __test__;

const event = (home, away, over = {}) => ({
  id: '401',
  date: '2026-07-04T20:00Z',
  status: { type: { state: 'post', name: 'STATUS_FULL_TIME', shortDetail: 'FT' }, period: 2 },
  competitions: [
    {
      competitors: [
        { homeAway: 'home', team: { displayName: home }, score: '2', ...(over.home || {}) },
        { homeAway: 'away', team: { displayName: away }, score: '0', ...(over.away || {}) },
      ],
    },
  ],
});

describe('normalizeEvents — knockout id synthesis', () => {
  it('group pairing resolves to its scheduled match id', () => {
    // Mexico vs Korea Republic is a real Group A fixture.
    const [g] = normalizeEvents({ events: [event('Mexico', 'Korea Republic')] });
    expect(g.match_id).toBe('match:A-MD1-MEX-KOR');
    expect(g.is_knockout).toBe(false);
  });

  it('cross-group knockout pairing gets a stable sorted-code KO id', () => {
    // Canada (B) vs Morocco (C) is not a group fixture → knockout.
    const [k] = normalizeEvents({ events: [event('Canada', 'Morocco')] });
    expect(k.match_id).toBe('match:KO-CAN-MOR');
    expect(k.is_knockout).toBe(true);
  });

  it('KO id is orientation-independent (home/away swap → same id)', () => {
    const [a] = normalizeEvents({ events: [event('Canada', 'Morocco')] });
    const [b] = normalizeEvents({ events: [event('Morocco', 'Canada')] });
    expect(a.match_id).toBe(b.match_id);
  });

  it('captures shootout tally + winner flag for penalty ties', () => {
    const [k] = normalizeEvents({
      events: [
        event('Canada', 'Morocco', {
          home: { score: '1', shootoutScore: '4', winner: true },
          away: { score: '1', shootoutScore: '2', winner: false },
        }),
      ],
    });
    expect(k.home_shootout).toBe(4);
    expect(k.away_shootout).toBe(2);
    expect(k.home_winner).toBe(true);
  });
});
