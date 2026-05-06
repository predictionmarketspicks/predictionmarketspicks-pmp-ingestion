"""
Discord webhook for the WC sim. Posts to #bot-logs on validation failure.

Webhook URL is read from env DISCORD_BOT_LOGS_WEBHOOK. If unset, we log to
stderr but don't raise — the GH Action exit code (sys.exit(1) in run-wc-sim.py)
is what actually fails the build, the Discord post is just extra signal.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from typing import List, Optional


def _post_webhook(url: str, payload: dict, timeout: int = 10) -> bool:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        print(f"[wc-sim] discord webhook HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}",
              file=sys.stderr)
        return False
    except Exception as e:
        print(f"[wc-sim] discord webhook error: {e!s}", file=sys.stderr)
        return False


def discord_alert(message: str, sim_run_id: str = "", failures: Optional[List[str]] = None) -> bool:
    """Post a validation-failure embed to #bot-logs.

    Returns True on success, False otherwise. Never raises — the calling sim
    has already decided to exit(1), Discord is best-effort signal.
    """
    url = os.environ.get("DISCORD_BOT_LOGS_WEBHOOK")
    if not url:
        print(f"[wc-sim] DISCORD_BOT_LOGS_WEBHOOK unset — skipping discord alert",
              file=sys.stderr)
        print(f"[wc-sim] would have posted: {message}", file=sys.stderr)
        return False

    fields = []
    if sim_run_id:
        fields.append({"name": "sim_run_id", "value": sim_run_id, "inline": True})
    if failures:
        # Discord field value max 1024 chars; cap at 6 failures shown.
        shown = failures[:6]
        text = "\n".join(f"• {f}" for f in shown)
        if len(failures) > 6:
            text += f"\n• …and {len(failures) - 6} more"
        # Hard truncate on length too
        if len(text) > 1024:
            text = text[:1020] + "…"
        fields.append({"name": f"Failures ({len(failures)})", "value": text, "inline": False})

    payload = {
        "username": "WC Sim",
        "embeds": [{
            "title":       "WC sim validation FAILED",
            "description": message[:2000],
            "color":       15158332,  # red
            "fields":      fields,
        }],
    }
    return _post_webhook(url, payload)
