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
import queue
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

# Worker batching. The SDK callback thread enqueues raw records onto
# _record_queue and returns immediately — this is the only thing that keeps
# Databento from declaring us a "slow client" on peak-volume days (OPEX, etc).
# A dedicated worker thread drains the queue and applies book updates under
# the lock in batches of up to QUEUE_BATCH records per acquisition so we
# amortize lock cost across many quotes. SimpleQueue is lock-free + unbounded;
# if the worker ever falls catastrophically behind, memory growth surfaces in
# /health (queue_depth) long before it OOMs the machine.
QUEUE_BATCH = 512
QUEUE_DRAIN_IDLE_SLEEP_S = 0.001


# --- logging -----------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="[databento-sidecar] %(asctime)s %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("databento-sidecar")


# --- state -------------------------------------------------------------

# All shared state lives behind one lock. The dedicated worker thread writes;
# the HTTP handler threads read. The SDK callback thread NEVER touches the
# lock — it only enqueues, which is essential to keep wire-side throughput
# decoupled from book-update cost.
_lock = threading.Lock()
_instruments: dict[int, dict[str, Any]] = {}
_book: dict[int, dict[str, Any]] = {}
_trade_history: dict[int, deque[tuple[int, int]]] = defaultdict(deque)
_record_queue: queue.SimpleQueue = queue.SimpleQueue()
_counters = {
    "definitions": 0,
    "quotes": 0,
    "trades": 0,
    "enqueued": 0,
    "processed": 0,
    "queue_depth_peak": 0,
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


# --- record callback (hot path) ----------------------------------------


def on_record(record: Any) -> None:
    """SDK callback hot path. Enqueue and return — NO lock acquisition, NO
    heavy work. This is what lets the Databento Live client drain its socket
    fast enough that the gateway never declares us a slow client on high-vol
    days (OPEX, FOMC, etc).

    SimpleQueue.put is implemented as a single atomic deque append in CPython
    — sub-microsecond per call, no GIL contention beyond the deque mutation
    itself.
    """
    _record_queue.put(record)


# --- worker (cold path) ------------------------------------------------


def _process_record(record: Any) -> None:
    """Apply one record to the in-memory book. Caller must hold _lock.

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
    rtype = type(record).__name__

    if rtype == "InstrumentDefMsg":
        _instruments[record.instrument_id] = {
            "raw_symbol": getattr(record, "raw_symbol", None),
            "strike": float(getattr(record, "pretty_strike_price", 0.0) or 0.0),
            "expiration": _format_expiration(record),
            "contract_type": _format_contract_type(record),
            "underlying": getattr(record, "underlying", None),
        }
        _counters["definitions"] += 1
        _counters["last_tick_at_ns"] = time.time_ns()
        return

    if rtype == "Cmbp1Msg":
        bid_px = getattr(record, "pretty_bid_px_00", None)
        ask_px = getattr(record, "pretty_ask_px_00", None)
        bid_sz = getattr(record, "bid_sz_00", None)
        ask_sz = getattr(record, "ask_sz_00", None)
        slot = _book.setdefault(record.instrument_id, {})
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
        _counters["last_error"] = str(msg)[:240]
        return

    if rtype == "SystemMsg":
        log.info("system: %s", getattr(record, "msg", ""))
        return


def _run_worker() -> None:
    """Drain the record queue and apply records to the book.

    Batches up to QUEUE_BATCH records per lock acquisition to amortize the
    lock-acquire/release cost across many quotes. On an empty queue, sleeps
    briefly so the worker doesn't burn CPU spinning during off-hours.
    """
    while True:
        # Block on the first record so we don't busy-spin when idle.
        try:
            first = _record_queue.get(timeout=1.0)
        except queue.Empty:
            continue

        batch: list[Any] = [first]
        # Drain everything currently available, up to QUEUE_BATCH.
        while len(batch) < QUEUE_BATCH:
            try:
                batch.append(_record_queue.get_nowait())
            except queue.Empty:
                break

        with _lock:
            for record in batch:
                try:
                    _process_record(record)
                except Exception:  # noqa: BLE001
                    log.exception(
                        "process_record failed for type=%s",
                        type(record).__name__,
                    )
            _counters["processed"] += len(batch)
            depth = _record_queue.qsize()
            if depth > _counters["queue_depth_peak"]:
                _counters["queue_depth_peak"] = depth


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
                    "processed": _counters["processed"],
                    "queue_depth": _record_queue.qsize(),
                    "queue_depth_peak": _counters["queue_depth_peak"],
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


def _run_heartbeat() -> None:
    """Periodic counter snapshot to stdout so fly logs surface quote flow
    without needing an SSH into the machine. Every 15s, prints:
      heartbeat defs=N quotes=N trades=N processed=N queue_depth=N peak=N
    """
    while True:
        time.sleep(15)
        with _lock:
            log.info(
                "heartbeat defs=%d quotes=%d trades=%d processed=%d queue_depth=%d peak=%d last_err=%s",
                _counters["definitions"],
                _counters["quotes"],
                _counters["trades"],
                _counters["processed"],
                _record_queue.qsize(),
                _counters["queue_depth_peak"],
                (_counters["last_error"] or "none")[:120],
            )


def main() -> int:
    http_thread = threading.Thread(target=run_http_server, name="http", daemon=True)
    http_thread.start()
    worker_thread = threading.Thread(target=_run_worker, name="record-worker", daemon=True)
    worker_thread.start()
    heartbeat_thread = threading.Thread(target=_run_heartbeat, name="heartbeat", daemon=True)
    heartbeat_thread.start()
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
