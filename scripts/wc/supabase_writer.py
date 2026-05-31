"""
Supabase writer + matview refresh for the WC sim.

Uses the Python supabase-py SDK with service-role key (writes to public.world_cup_*
tables; respects RLS-bypass via service role).

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY  (NOT the anon key — RLS would block writes)
"""
import os
from functools import lru_cache
from typing import List


@lru_cache(maxsize=1)
def get_supabase_client():
    """Lazy-init singleton client. lru_cache so repeated calls return the same instance."""
    from supabase import create_client, Client  # type: ignore

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    return create_client(url, key)


def insert_simulation_rows(rows: List[dict]) -> int:
    """Bulk-insert rows into world_cup_simulation. Returns count inserted.

    Each row dict shape:
      {
        "entity_id":         "team:france",
        "kind":              "champion",
        "sim_run_id":        "v4_20260531_120000",
        "sim_pct":           15.20,
        "sim_american_odds": 558,                # or None
        "metadata":          {...},
      }

    `sim_ran_at` is set server-side by `default now()`.
    """
    if not rows:
        return 0
    sb = get_supabase_client()
    # Supabase REST has a request size limit; chunk at 500 rows.
    inserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        sb.table("world_cup_simulation").insert(chunk).execute()
        inserted += len(chunk)
    return inserted


def insert_player_rows(rows: List[dict]) -> int:
    """Bulk-insert rows into world_cup_player_simulation."""
    if not rows:
        return 0
    sb = get_supabase_client()
    sb.table("world_cup_player_simulation").insert(rows).execute()
    return len(rows)


def refresh_matviews() -> None:
    """Refresh both _latest matviews so downstream readers see the new sim_run_id.

    Calls a Postgres RPC because supabase-py can't issue raw `REFRESH MATERIALIZED VIEW`
    statements directly. The RPC must exist in the schema:

      create or replace function refresh_world_cup_latest_matviews()
      returns void language plpgsql security definer as $$
      begin
        refresh materialized view public.world_cup_simulation_latest;
        refresh materialized view public.world_cup_player_simulation_latest;
      end;
      $$;

    If the RPC doesn't exist (PR 1 didn't ship it), this raises — caller logs a
    warning rather than failing the whole sim. The matviews will be stale until
    something else refreshes them, but the underlying tables are correct.
    """
    sb = get_supabase_client()
    try:
        sb.rpc("refresh_world_cup_latest_matviews").execute()
    except Exception as e:
        print(f"[wc-sim] WARNING: matview refresh RPC failed: {e!s}")
        print("[wc-sim] sim rows are written; matviews may be stale until next refresh")


def fetch_seed_simulation() -> List[dict]:
    """Pull the v2_april_2026_seed rows for validation comparison."""
    sb = get_supabase_client()
    resp = (
        sb.table("world_cup_simulation")
          .select("entity_id, kind, sim_pct")
          .eq("sim_run_id", "v2_april_2026_seed")
          .execute()
    )
    return resp.data or []
