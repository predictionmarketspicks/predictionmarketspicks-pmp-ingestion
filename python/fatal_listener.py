"""supervisord event listener: a FATAL program takes the whole machine down.

ENGINE_OUTAGE_ALARMS_AND_OPEN_FIXES_2026-11-03 P0-D (site repo handoff). On Nov 1
2026 the Databento sidecar exhausted startretries, went FATAL, and supervisord sat
there with Node still up — /alive green, so Fly never restarted anything and the
metals/oil/bitcoin boards priced nothing for 49 hours.

On PROCESS_STATE_FATAL for any program, this listener SIGKILLs supervisord. The
machine's main process then exits non-zero, and Fly's restart policy
("on-failure", max_retries 10) boots a fresh machine — the same thing the manual
`fly apps restart pmp-ingestion` did. SIGKILL, not SIGTERM: a clean supervisord
shutdown exits 0, which "on-failure" treats as success and does NOT restart.

Stdlib only (the venv does not carry the `supervisor` package). Protocol:
http://supervisord.org/events.html#event-listener-notification-protocol
"""
import os
import signal
import sys


def log(msg):
    sys.stderr.write(f"[fatal-listener] {msg}\n")
    sys.stderr.flush()


def parse(line):
    return dict(tok.split(":", 1) for tok in line.strip().split() if ":" in tok)


def main():
    while True:
        sys.stdout.write("READY\n")
        sys.stdout.flush()
        header = parse(sys.stdin.readline())
        payload = sys.stdin.read(int(header.get("len", "0")))
        if header.get("eventname") == "PROCESS_STATE_FATAL":
            body = parse(payload.split("\n", 1)[0])
            log(f"program {body.get('processname', '?')} is FATAL — killing supervisord so Fly restarts the machine")
            os.kill(os.getppid(), signal.SIGKILL)
        sys.stdout.write("RESULT 2\nOK")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
