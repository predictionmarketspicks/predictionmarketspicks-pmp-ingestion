"""
Market backdrop reader.

Per option A from the PR 2 spec discussion: the simulator does NOT use prediction-
market or sportsbook prices to calibrate strength ratings. Instead, we attach
whatever the Fly engine has already written into world_cup_market_latest as a
metadata payload on each sim row, purely for downstream display ("sim says 18.6,
Kalshi says 16.0, DK consensus says 14.0").

If PR 3 (Fly engine WC writers) hasn't shipped yet, world_cup_market_latest is
empty and we attach an empty dict — sim still completes successfully.

PR 4 (mispricing engine) is what actually compares sim_pct vs market prices.
"""
from typing import Dict, Tuple

from .supabase_writer import get_supabase_client


# Tuple key: (entity_id, kind). Value: dict keyed by platform.
MarketBackdrop = Dict[Tuple[str, str], Dict[str, dict]]


def fetch_market_backdrop() -> MarketBackdrop:
    """Read world_cup_market_latest and group by (entity_id, kind).

    Returns:
      {
        ("team:france", "champion"): {
          "kalshi":     {"yes_price_cents": 16, "volume_24h": 8421, "as_of_age_seconds": 312, ...},
          "polymarket": {"yes_price_cents": 17, "volume_24h": 1840, "as_of_age_seconds": 412, ...},
          "draftkings": {"yes_price_cents": 14, ...},
        },
        ...
      }

    Empty dict if the matview is empty or the table doesn't exist yet.
    """
    sb = get_supabase_client()
    try:
        # Use the matview directly. If empty, returns []. If table doesn't exist
        # (PR 3 not shipped, schema mismatch), supabase-py raises — caller catches.
        resp = (
            sb.table("world_cup_market_latest")
              .select("entity_id, kind, platform, yes_price_cents, volume_24h, "
                      "price_change_24h_pp, liquidity, url, snapshot_at, as_of_age_seconds")
              .execute()
        )
        rows = resp.data or []
    except Exception as e:
        print(f"[wc-sim] market backdrop unavailable: {e!s} — proceeding without")
        return {}

    out: MarketBackdrop = {}
    for r in rows:
        key = (r["entity_id"], r["kind"])
        out.setdefault(key, {})[r["platform"]] = {
            "yes_price_cents":      r["yes_price_cents"],
            "volume_24h":           float(r["volume_24h"]) if r.get("volume_24h") is not None else None,
            "price_change_24h_pp":  float(r["price_change_24h_pp"]) if r.get("price_change_24h_pp") is not None else None,
            "liquidity":            float(r["liquidity"]) if r.get("liquidity") is not None else None,
            "url":                  r.get("url"),
            "as_of_age_seconds":    r.get("as_of_age_seconds"),
            "snapshot_at":          r.get("snapshot_at"),
        }
    print(f"[wc-sim] market backdrop loaded: {len(out)} (entity, kind) pairs across "
          f"{sum(len(v) for v in out.values())} total platform rows")
    return out


def attach_to_metadata(metadata: dict, entity_id: str, kind: str, backdrop: MarketBackdrop) -> dict:
    """Merge backdrop entries into a sim row's metadata jsonb.

    Resulting metadata layout:
      {
        ...existing keys (group, home, away, etc.)...
        "market_backdrop": {
          "kalshi":     {...},
          "polymarket": {...},
          "draftkings": {...},
        }
      }

    If no backdrop exists for this (entity_id, kind), metadata is returned unchanged.
    """
    md = dict(metadata)
    bd = backdrop.get((entity_id, kind))
    if bd:
        md["market_backdrop"] = bd
    return md
