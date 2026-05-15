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

Scope: multi-underlying (DATABENTO_SYMBOLS, default SLV.OPT). Subscribes
to OPRA.PILLAR for four schemas:
  - definition  → strike / expiry / contract type (one per instrument)
  - cmbp-1      → consolidated NBBO across all 18 options venues (the
                  workhorse — every quote update)
  - trades      → trade prints (last price + 24h rolling volume)
  - statistics  → daily EOD (open_interest for dealer-gamma weighting)
Holds the book in memory, exposes it as JSON on GET /chain/<underlying>.
Pre-filters far-dated instruments at the SDK callback (>DATABENTO_MAX_-
EXPIRY_DAYS, default 60) to keep GIL pressure off the reader thread on
peak-volume sessions.

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
from collections import Counter, defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import databento as db


# --- config ------------------------------------------------------------

DATASET = "OPRA.PILLAR"
SYMBOLS = (os.environ.get("DATABENTO_SYMBOLS") or "SLV.OPT").split(",")
LISTEN_HOST = os.environ.get("DATABENTO_SIDECAR_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DATABENTO_SIDECAR_PORT", "9090"))

# Cap how far out an option's expiry must be to stay subscribed. OPRA's firehose
# is dominated by LEAPS and quarter-out contracts that the engine never trades
# (commodity-base.js filters to weekly/monthly near-term events). Dropping these
# at the SDK callback — before the queue, before the lock — keeps GIL pressure
# off the SDK reader thread on peak-volume days (OPEX, FOMC). Tunable via
# DATABENTO_MAX_EXPIRY_DAYS; 60 days covers every event ticker the Kalshi
# series currently lists, with a comfortable buffer.
MAX_EXPIRY_DAYS = int(os.environ.get("DATABENTO_MAX_EXPIRY_DAYS", "60"))

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
# Pre-filter passlist. Written by the worker when it classifies an instrument
# from its SymbolMappingMsg/InstrumentDefMsg (expiry beyond MAX_EXPIRY_DAYS).
# Read lock-free by the SDK callback so it can drop matching records before
# they enter the queue. set.__contains__ is a single C-level hash lookup —
# atomic w.r.t. concurrent .add() in CPython, so no lock is needed.
_drop_instrument: set[int] = set()
# rtype name → count. Tracks every distinct record class name the SDK
# delivers so we can see when (e.g.) Cmbp1Msg gets renamed by an SDK
# upgrade or when we're getting unexpected message types.
_type_counts: Counter = Counter()
# One-shot guard: log the first SymbolMappingMsg's full shape so we can
# pin down which attribute carries the raw OPRA symbol.
_logged_symmap_shape: bool = False
_counters = {
    "definitions": 0,
    "quotes": 0,
    "trades": 0,
    "stats": 0,
    "oi_updates": 0,
    "enqueued": 0,
    "processed": 0,
    "queue_depth_peak": 0,
    "callback_dropped": 0,
    "last_tick_at_ns": 0,
    "last_error": None,
    "connected_at_ns": 0,
}

# DBN StatType code for daily open interest, per
# https://databento.com/docs/standards-and-conventions/common-fields-enums-types.
# Compare against the int rather than databento.StatType.OPEN_INTEREST so an
# SDK rename or import-path shuffle doesn't silently drop OI updates.
STAT_TYPE_OPEN_INTEREST = 9


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

    Pre-filter: instruments classified for drop by the worker (far-dated
    expiries) short-circuit here. set.__contains__ is atomic in CPython —
    safe to read concurrent with worker .add(). Counter increment is also
    a single bytecode hot enough to skip the lock; a few lost increments
    under contention is acceptable for an observability counter.
    """
    iid = getattr(record, "instrument_id", None)
    if iid is not None and iid in _drop_instrument:
        _counters["callback_dropped"] += 1
        return
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
    _type_counts[rtype] += 1
    # Normalize to handle SDK class-name variants between releases (e.g.
    # databento-python ≥0.40 ships CMBP1Msg with an upper-cased acronym
    # while older releases used Cmbp1Msg). Compare against the lowercased
    # name so a future rename of, say, "ErrorMsg" → "ERRORMsg" doesn't
    # silently swallow records again.
    rtype_norm = rtype.lower()

    if rtype_norm == "instrumentdefmsg":
        expiration = _format_expiration(record)
        _instruments[record.instrument_id] = {
            "raw_symbol": getattr(record, "raw_symbol", None),
            "strike": float(getattr(record, "pretty_strike_price", 0.0) or 0.0),
            "expiration": expiration,
            "contract_type": _format_contract_type(record),
            "underlying": getattr(record, "underlying", None),
        }
        _classify_instrument_drop(record.instrument_id, expiration)
        _counters["definitions"] += 1
        _counters["last_tick_at_ns"] = time.time_ns()
        return

    if rtype_norm == "symbolmappingmsg":
        # databento-python ≥0.40 with `stype_in="parent"` delivers ALL the
        # contract metadata we need via SymbolMappingMsg + Cmbp1Msg and stops
        # emitting InstrumentDefMsg entirely. The raw OPRA symbol carries
        # strike/expiry/type in the OCC 21-char format:
        #   "GLD   260612C00416000"
        # Field name varies by SDK version — try the documented candidates in
        # order and log the actual record shape once on first arrival so we
        # can pin the right field name without another deploy.
        global _logged_symmap_shape
        if not _logged_symmap_shape:
            try:
                attrs = {k: getattr(record, k, None) for k in dir(record) if not k.startswith("_") and not callable(getattr(record, k, None))}
                log.info("first SymbolMappingMsg shape: %s", attrs)
            except Exception:  # noqa: BLE001
                log.exception("first SymbolMappingMsg introspection failed")
            _logged_symmap_shape = True

        # stype_out_symbol is the OPRA symbol (output of the symbology mapping).
        # stype_in_symbol is the parent we subscribed with ("SLV.OPT" / "GLD.OPT")
        # which is non-None and would short-circuit any `or` chain — must read
        # stype_out_symbol directly. Per Databento DBN SymbolMapping spec.
        raw = getattr(record, "stype_out_symbol", None)
        parsed = _parse_occ_symbol(raw) if raw else None
        if parsed:
            _instruments[record.instrument_id] = {
                "raw_symbol": raw,
                "strike": parsed["strike"],
                "expiration": parsed["expiration"],
                "contract_type": parsed["contract_type"],
                "underlying": parsed["underlying"],
            }
            _classify_instrument_drop(record.instrument_id, parsed["expiration"])
            _counters["definitions"] += 1
            _counters["last_tick_at_ns"] = time.time_ns()
        return

    if rtype_norm == "cmbp1msg":
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

    if rtype_norm == "trademsg":
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

    if rtype_norm == "statmsg":
        # OPRA.PILLAR statistics: daily EOD prints. OPEN_INTEREST is the only
        # field the dealer-gamma compute needs (settlement/high/low are nice
        # to have but the engine doesn't use them today). One update per
        # instrument per session — values persist between updates.
        _counters["stats"] += 1
        _counters["last_tick_at_ns"] = time.time_ns()
        stat_type = getattr(record, "stat_type", None)
        if stat_type == STAT_TYPE_OPEN_INTEREST:
            quantity = getattr(record, "quantity", None)
            if quantity is not None and quantity >= 0:
                slot = _book.setdefault(record.instrument_id, {})
                slot["open_interest"] = int(quantity)
                _counters["oi_updates"] += 1
        return

    if rtype_norm == "errormsg":
        msg = getattr(record, "err", str(record))
        log.warning("server error: %s", msg)
        _counters["last_error"] = str(msg)[:240]
        return

    if rtype_norm == "systemmsg":
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


def _days_to_expiry(expiry_iso: str | None, now_ns: int | None = None) -> int | None:
    """Days from now to YYYY-MM-DD expiry. Returns None on malformed input.
    Negative when already expired — caller should drop those instruments.
    """
    if not expiry_iso or len(expiry_iso) < 10:
        return None
    try:
        yy, mm, dd = int(expiry_iso[0:4]), int(expiry_iso[5:7]), int(expiry_iso[8:10])
    except ValueError:
        return None
    # struct_time month/day are 1-indexed; use a tuple → epoch conversion that
    # doesn't pull in datetime/timezone overhead at hot-path scale.
    try:
        exp_epoch = time.mktime((yy, mm, dd, 0, 0, 0, 0, 0, 0))
    except (OverflowError, ValueError):
        return None
    now_s = (now_ns or time.time_ns()) / 1_000_000_000
    return int((exp_epoch - now_s) / 86400)


def _classify_instrument_drop(instrument_id: int, expiry_iso: str | None) -> None:
    """Decide whether to drop quotes for this instrument. Called from the
    worker when an InstrumentDefMsg or SymbolMappingMsg lands.

    Anything more than MAX_EXPIRY_DAYS out (or already expired, or with
    unparseable expiry) is added to _drop_instrument. Subsequent Cmbp1Msg /
    TradeMsg records for that id are short-circuited at the SDK callback.
    """
    days = _days_to_expiry(expiry_iso)
    if days is None or days < 0 or days > MAX_EXPIRY_DAYS:
        _drop_instrument.add(instrument_id)


def _parse_occ_symbol(symbol: str) -> dict[str, Any] | None:
    """Parse an OPRA OCC 21-char option symbol like 'GLD   260612C00416000'
    into its components. Returns None on any malformed input — the caller is
    expected to skip the record rather than raise.

    Layout:
      [0..6)  underlying (right-padded with spaces, e.g. 'GLD   ' or 'SPY   ')
      [6..12) YYMMDD expiry (e.g. '260612' → 2026-06-12). 2-digit year is
              assumed 20YY (OCC standard; covers contracts out to 2099).
      [12]    'C' (call) or 'P' (put)
      [13..21) 8-digit strike × 1000 (e.g. '00416000' → $416.000)
    """
    if not symbol or len(symbol) < 21:
        return None
    s = symbol if len(symbol) == 21 else symbol.ljust(21)
    try:
        underlying = s[0:6].strip()
        yy = int(s[6:8])
        mm = int(s[8:10])
        dd = int(s[10:12])
        cp = s[12]
        strike_raw = int(s[13:21])
    except (ValueError, IndexError):
        return None
    if not underlying or cp not in ("C", "P") or mm < 1 or mm > 12 or dd < 1 or dd > 31:
        return None
    return {
        "underlying": underlying,
        "expiration": f"20{yy:02d}-{mm:02d}-{dd:02d}",
        "contract_type": "call" if cp == "C" else "put",
        "strike": strike_raw / 1000.0,
    }


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
                    "stats": _counters["stats"],
                    "oi_updates": _counters["oi_updates"],
                    "processed": _counters["processed"],
                    "queue_depth": _record_queue.qsize(),
                    "queue_depth_peak": _counters["queue_depth_peak"],
                    "callback_dropped": _counters["callback_dropped"],
                    "drop_filter_size": len(_drop_instrument),
                    "max_expiry_days": MAX_EXPIRY_DAYS,
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
                # OPRA OI flows in via the daily statistics schema (StatMsg
                # with stat_type=OPEN_INTEREST). Persists between updates;
                # None until the first session's EOD print lands.
                "open_interest": quote.get("open_interest"),
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
    #
    # statistics: daily EOD prints (open_interest, settlement, session high/low).
    # Required for dealer-gamma compute, which weights each strike's gamma by
    # OI. Without this the gamma engine reports strikesContributing=0 because
    # the cmbp-1 + trades schemas don't carry OI at all.
    for schema in ("definition", "cmbp-1", "trades", "statistics"):
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
            type_breakdown = ", ".join(f"{k}={v}" for k, v in _type_counts.most_common(10))
            log.info(
                "heartbeat defs=%d quotes=%d trades=%d stats=%d oi=%d processed=%d "
                "queue_depth=%d peak=%d callback_dropped=%d drop_filter=%d types=[%s] last_err=%s",
                _counters["definitions"],
                _counters["quotes"],
                _counters["trades"],
                _counters["stats"],
                _counters["oi_updates"],
                _counters["processed"],
                _record_queue.qsize(),
                _counters["queue_depth_peak"],
                _counters["callback_dropped"],
                len(_drop_instrument),
                type_breakdown,
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
