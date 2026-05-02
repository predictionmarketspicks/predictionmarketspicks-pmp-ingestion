// Phase 2B cross-platform arb mappings — verified live against gamma-api on
// 2026-05-02. Each row pairs ONE Kalshi market YES with ONE Polymarket outcome
// YES so the comparator's spread is a direct probability subtraction.
//
// Departure from BUILD_PLAN §10: original 4 markets (KXFED-25-DEC, KXFED-26-MAR,
// KXCPIYOY-26-JAN, KXNBERRECESSQ-26) all resolved before today. CPI threshold
// buckets (Kalshi cumulative-above vs Polymarket exact bucket) and recession
// (Kalshi quarterly chronology vs Polymarket "by year-end") need synthetic
// comparator logic — pushed to Phase 2B+.
//
// Pure-Fed pairings give the WS feed a clean structural validation:
// 4 outcomes split across 2 events × 2 platforms. Polymarket CLOB WS subscribes
// to YES tokens (yesTokenId); the NO token's price is just 1 - yesPrice.

export const ARB_MAPPINGS = [
  {
    pair_slug: 'fed-jun-2026-no-change',
    label: 'Fed Jun 2026 — No Change',
    kalshi: { ticker: 'KXFEDDECISION-26JUN-H0' },
    polymarket: {
      conditionId: '0xde04b189b3f19eaccda02529a3ea67abfc46bff5c0c8fc42d8a2d0ed7b8f0d41',
      yesTokenId: '30767812841387255642892182147223249245545002662653079696958384408588201824258',
      eventSlug: 'fed-decision-in-june-825',
      outcomeLabel: 'No change',
    },
  },
  {
    pair_slug: 'fed-jun-2026-cut-25bps',
    label: 'Fed Jun 2026 — Cut 25bps',
    kalshi: { ticker: 'KXFEDDECISION-26JUN-C25' },
    polymarket: {
      conditionId: '0xdde06286a7b9464d344f410ab0b3d2ebc6469904e72c27fd982f65fdbf78768d',
      yesTokenId: '65193234666628291664907888364936366210889305490897648116746073820519263548476',
      eventSlug: 'fed-decision-in-june-825',
      outcomeLabel: '25 bps decrease',
    },
  },
  {
    pair_slug: 'fed-sep-2026-no-change',
    label: 'Fed Sep 2026 — No Change',
    kalshi: { ticker: 'KXFEDDECISION-26SEP-H0' },
    polymarket: {
      conditionId: '0x5c0eb0be1b96f688bbd700259c9fd4a96ebb66454d3db63e57457539a5351d01',
      yesTokenId: '105275363999962243078890826573477817229052004571369709283536181169501899960451',
      eventSlug: 'fed-decision-in-september-568',
      outcomeLabel: 'No change',
    },
  },
  {
    pair_slug: 'fed-sep-2026-cut-25bps',
    label: 'Fed Sep 2026 — Cut 25bps',
    kalshi: { ticker: 'KXFEDDECISION-26SEP-C25' },
    polymarket: {
      conditionId: '0x29519bf9c3008a29bf901188f0f6dc6067e1f0ea1079fcd4e2c8c908a1f8d3d2',
      yesTokenId: '80439121917193473911805555468169259309230305417772082063473718910883954435290',
      eventSlug: 'fed-decision-in-september-568',
      outcomeLabel: '25 bps decrease',
    },
  },
];

export function getKalshiTickers() {
  return ARB_MAPPINGS.map((m) => m.kalshi.ticker);
}

export function getPolymarketYesTokenIds() {
  return ARB_MAPPINGS.map((m) => m.polymarket.yesTokenId);
}

export function getMappingByKalshiTicker(ticker) {
  return ARB_MAPPINGS.find((m) => m.kalshi.ticker === ticker) || null;
}

export function getMappingByPolyToken(tokenId) {
  return ARB_MAPPINGS.find((m) => m.polymarket.yesTokenId === tokenId) || null;
}
