"""Databento OPRA Live sidecar.

Architecture: Python sidecar owns the raw TCP + DBN binary protocol to the
upstream live gateway via the official SDK. The Node engine (port 8080)
queries this process on localhost:9090 for the current chain.

Why a sidecar: no official Node SDK exists; the upstream protocol is raw
TCP + DBN binary records, not WebSocket. Porting that to Node would be
~1000 LOC of binary parsing with high parity risk against the official
client. A Python sidecar with the canonical SDK keeps the IV math + edge
methodology in Node (where the existing fallback solver in
src/engine/options.js already lives) while the binary-protocol layer
runs in a thoroughly-tested SDK.

Scope (Phase 1): SLV only. Subscribes to OPRA.PILLAR for schemas
mbp-1 (top of book, every quote), definition (strike/expiry/type),
and trades (last price + cumulative volume). Holds the book in memory,
exposes it as JSON on GET /chain/<underlying>.

Health: GET /health returns connectivity + tick counters. Node polls
this every 30s and routes it into observability/health.js so the existing
/health JSON contract on port 8080 surfaces sidecar liveness too.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import databento as db


# --- config ------------------------------------------------------------

DATASET = "OPRA.PILLAR"
SYMBOLS = (os.environ.get("DATABENTO_SYMBOLS") or "SLV.OPT").split(",")
LISTEN_HOST = os.environ.get("DATABENTO_SIDECAR_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DATABENTO_SIDECAR_PORT", "9090"))

# 24h trade-volume window. Rolling sum keyed by (instrument_id) over deque
# of (ts_ns, size). The bound here caps memory if a strike sees pathological
# print rates — older entries get evicted lazily on read.
VOLUME_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000


# --- logging -----------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="[databento-sidecar] %(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("databento-sidecar")


# --- state -------------------------------------------------------------

# All shared state lives behind one lock. The SDK callback thread writes;
# the HTTP handler threads read. Hot path is small (dict get/set), so a
# coarse lock is fine for this workload (<10k records/sec sustained on SLV).
_lock = threading.Lock()
_instruments: dict[int, dict[str, Any]] = {}
_book: dict[int, dict[str, Any]] = {}
_trade_history: dict[int, deque[tuple[int, int]]] = defaultdict(deque)
_counters = {
    "definitions": 0,
    "quotes": 0,
    "trades": 0,
    "last_tick_at_ns": 0,
    "last_error": None,
    "connected_at_ns": 0,
}


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _ns_to_iso(ns: int) -> str | None:
    if not ns:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ns / 1_000_000_000))


def _evict_old_trades(history: deque[tuple[int, int]], cutoff_ns: int) -> None:
    while history and history[0][0] < cutoff_ns:
        history.popleft()


def _rolling_volume(instrument_id: int, now_ns: int) -> int:
    history = _trade_history.get(instrument_id)
    if not history:
        return 0
    _evict_old_trades(history, now_ns - VOLUME_WINDOW_NS)
    return sum(size for _, size in history)


# --- record callback ---------------------------------------------------


def on_record(record: Any) -> None:
    """Single dispatch entry. Updates state under the lock and bumps tick.

    Recognized types (databento-python ≥0.36):
      - InstrumentDefMsg → instrument metadata
      - Cmbp1Msg         → consolidated NBBO across the 18 OPRA venues
                           (OPRA's cmbp-1 schema; fields are flattened —
                           bid_px_00 / ask_px_00 etc., not nested in levels)
      - TradeMsg         → trade prints
      - SymbolMappingMsg → ignored (raw_symbol is already on the def)
      - SystemMsg        → server messages, log only
      - ErrorMsg         → server errors, log + surface in /health
    """
    try:
        rtype = type(record).__name__

        if rtype == "InstrumentDefMsg":
            with _lock:
                _instruments[record.instrument_id] = {
                    "raw_symbol": getattr(record, "raw_symbol", None),
                    # Strike is stored as int64 fixed-point ($/1e9). pretty_strike_price
                    # is provided by the SDK for convenience.
                    "strike": float(getattr(record, "pretty_strike_price", 0.0) or 0.0),
                    # Expiration is YYYYMMDD int or ns since epoch depending on field.
                    "expiration": _format_expiration(record),
                    "contract_type": _format_contract_type(record),
                    "underlying": getattr(record, "underlying", None),
                }
                _counters["definitions"] += 1
                _counters["last_tick_at_ns"] = time.time_ns()
            return

        if rtype == "Cmbp1Msg":
            # OPRA cmbp-1: consolidated NBBO across 18 options venues. Fields
            # are direct on the record (not in a levels array). pretty_* helpers
            # convert int64 fixed-point to floats; NaN-equivalent on either side
            # means no two-sided quote at that venue, which we read as null.
            bid_px = getattr(record, "pretty_bid_px_00", None)
            ask_px = getattr(record, "pretty_ask_px_00", None)
            bid_sz = getattr(record, "bid_sz_00", None)
            ask_sz = getattr(record, "ask_sz_00", None)
            with _lock:
                slot = _book.setdefault(record.instrument_id, {})
                # NaN protects against the int64 max-value sentinel Databento
                # uses for unset bid/ask in the raw stream.
                if bid_px is not None and bid_px == bid_px and bid_px > 0:
                    slot["bid"] = float(bid_px)
                else:
                    slot["bid"] = None
                if ask_px is not None and ask_px == ask_px and ask_px > 0:
                    slot["ask"] = float(ask_px)
                else:
                    slot["ask"] = None
                if bid_sz is not None:
                    slot["bid_size"] = int(bid_sz)
                if ask_sz is not None:
                    slot["ask_size"] = int(ask_sz)
                slot["ts_ns"] = record.ts_event
                _counters["quotes"] += 1
                _counters["last_tick_at_ns"] = time.time_ns()
            return

        if rtype == "TradeMsg":
            price = float(getattr(record, "pretty_price", 0.0) or 0.0)
            size = int(getattr(record, "size", 0) or 0)
            ts_ns = record.ts_event
            with _lock:
                slot = _book.setdefault(record.instrument_id, {})
                if price > 0:
                    slot["last"] = price
                history = _trade_history[record.instrument_id]
                history.append((ts_ns, size))
                _counters["trades"] += 1
                _counters["last_tick_at_ns"] = time.time_ns()
            return

        if rtype == "ErrorMsg":
            msg = getattr(record, "err", str(record))
            log.warning("server error: %s", msg)
            with _lock:
                _counters["last_error"] = str(msg)[:240]
            return

        if rtype == "SystemMsg":
            log.info("system: %s", getattr(record, "msg", ""))
            return

    except Exception:  # noqa: BLE001 — never let one bad record kill the stream
        log.exception("on_record dispatch failed for type=%s", type(record).__name__)


def _format_expiration(record: Any) -> str | None:
    # OPRA definition records use ns-epoch for expiration; SDK exposes
    # pretty_expiration as a datetime. Fall back to integer date if not present.
    pe = getattr(record, "pretty_expiration", None)
    if pe is not None:
        try:
            return pe.strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            pass
    raw = getattr(record, "expiration", None)
    if raw and isinstance(raw, int) and raw > 19000000:
        s = str(raw)
        if len(s) == 8:
            return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return None


def _format_contract_type(record: Any) -> str | None:
    # OPRA Definition: instrument_class char 'C' for call, 'P' for put.
    cls = getattr(record, "instrument_class", None)
    if cls in ("C", b"C", "c"):
        return "call"
    if cls in ("P", b"P", "p"):
        return "put"
    return None


# --- HTTP server -------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003
        # Default BaseHTTPRequestHandler logs to stderr per request. Mute to
        # match the Node engine's quieter logs; counters are observable via
        # GET /health.
        return

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            with _lock:
                payload = {
                    "ok": _counters["connected_at_ns"] > 0,
                    "connected_at": _ns_to_iso(_counters["connected_at_ns"]),
                    "last_tick_at": _ns_to_iso(_counters["last_tick_at_ns"]),
                    "instruments": len(_instruments),
                    "contracts_with_quotes": len(_book),
                    "definitions": _counters["definitions"],
                    "quotes": _counters["quotes"],
                    "trades": _counters["trades"],
                    "last_error": _counters["last_error"],
                    "now": _now_iso(),
                }
            self._send_json(200, payload)
            return

        if self.path.startswith("/chain/"):
            underlying = self.path[len("/chain/"):].split("?", 1)[0].upper()
            payload = build_chain_response(underlying)
            self._send_json(200, payload)
            return

        self._send_json(404, {"error": "not_found", "path": self.path})


def build_chain_response(underlying: str) -> dict[str, Any]:
    """Compose the JSON chain Node consumes.

    Filters: instrument's underlying matches the requested symbol (Databento's
    DEFINITION carries `underlying` which is the parent OPRA root, e.g. 'SLV').
    """
    now_ns = time.time_ns()
    contracts: list[dict[str, Any]] = []
    with _lock:
        for iid, meta in _instruments.items():
            if meta.get("underlying") != underlying and meta.get("underlying") != underlying.split(".", 1)[0]:
                continue
            quote = _book.get(iid) or {}
            volume24h = _rolling_volume(iid, now_ns)
            contracts.append({
                "instrument_id": iid,
                "raw_symbol": meta.get("raw_symbol"),
                "contract_type": meta.get("contract_type"),
                "strike": meta.get("strike"),
                "expiration": meta.get("expiration"),
                "bid": quote.get("bid"),
                "ask": quote.get("ask"),
                "bid_size": quote.get("bid_size"),
                "ask_size": quote.get("ask_size"),
                "last": quote.get("last"),
                "volume_24h": volume24h,
                "open_interest": None,  # OPRA OI lives on the daily statistics schema (Phase 2)
                "ts": _ns_to_iso(quote.get("ts_ns")),
            })
    return {
        "fetched_at": _now_iso(),
        "underlying": underlying,
        "contract_count": len(contracts),
        "contracts": contracts,
    }


# --- main --------------------------------------------------------------


def run_http_server() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    log.info("http listening on %s:%s", LISTEN_HOST, LISTEN_PORT)
    server.serve_forever()


def run_live_client() -> None:
    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        # Idle. Don't crash — supervisor would loop us forever and the
        # HTTP /health endpoint must stay reachable so the Node engine can
        # see this state in its own observability snapshot. Block here so
        # the daemon HTTP thread stays alive; operator sets the secret and
        # we come back via the next `fly deploy` or machine restart.
        log.error("DATABENTO_API_KEY not set — sidecar idle, /health still serving")
        with _lock:
            _counters["last_error"] = "DATABENTO_API_KEY not set"
        while True:
            time.sleep(3600)
    client = db.Live(
        key=api_key,
        reconnect_policy=getattr(db, "ReconnectPolicy", None) and db.ReconnectPolicy.RECONNECT or "reconnect",
    )

    # OPRA.PILLAR doesn't carry mbp-1 (that's the per-venue equity schema).
    # cmbp-1 is the consolidated NBBO across all 18 options venues, which is
    # what we actually want for mid-quote pricing. tcbbo is the lower-volume
    # trade-time variant; cmbp-1 is the workhorse.
    for schema in ("definition", "cmbp-1", "trades"):
        client.subscribe(
            dataset=DATASET,
            schema=schema,
            stype_in="parent",
            symbols=SYMBOLS,
        )

    client.add_callback(on_record)
    client.start()

    with _lock:
        _counters["connected_at_ns"] = time.time_ns()
    log.info("live client started dataset=%s schemas=def,mbp-1,trades symbols=%s", DATASET, SYMBOLS)

    # Block forever — SDK runs its own thread; this thread just keeps the
    # process alive alongside the HTTP server thread.
    client.block_for_close()


def main() -> int:
    http_thread = threading.Thread(target=run_http_server, name="http", daemon=True)
    http_thread.start()
    try:
        run_live_client()
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001
        log.exception("live client crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
