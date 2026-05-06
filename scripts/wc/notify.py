"""
Discord alert for the WC sim. Posts to #bot-logs (channel 1487857846111567952)
on validation failure.

Uses bot-token + REST (POST /channels/{id}/messages with Authorization: Bot ...)
rather than an incoming webhook — matches the rest of the prod stack and keeps
the secret surface to one DISCORD_BOT_TOKEN env var.

If DISCORD_BOT_TOKEN is unset, we log to stderr but don't raise. The GH Action
exit code (sys.exit(1) in run-wc-sim.py) is what actually fails the build; the
Discord post is best-effort signal.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from typing import List, Optional

# #bot-logs in The 7 Oracles guild — see CLAUDE.md "Discord — The 7 Oracles".
BOT_LOGS_CHANNEL_ID = "1487857846111567952"
DISCORD_API = "https://discord.com/api/v10"


def _post_message(channel_id: str, token: str, payload: dict, timeout: int = 10) -> bool:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{DISCORD_API}/channels/{channel_id}/messages",
        data=body,
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type":  "application/json",
            "User-Agent":    "pmp-ingestion-wc-sim/1.0 (https://predictionmarketspicks.com)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        print(f"[wc-sim] discord HTTP {e.code}: {e.read().decode('utf-8', 'ignore')}",
              file=sys.stderr)
        return False
    except Exception as e:
        print(f"[wc-sim] discord error: {e!s}", file=sys.stderr)
        return False


def discord_alert(message: str, sim_run_id: str = "", failures: Optional[List[str]] = None) -> bool:
    """Post a validation-failure embed to #bot-logs.

    Returns True on success, False otherwise. Never raises — the calling sim
    has already decided to exit(1), Discord is best-effort signal.
    """
    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not token:
        print("[wc-sim] DISCORD_BOT_TOKEN unset — skipping discord alert", file=sys.stderr)
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
        if len(text) > 1024:
            text = text[:1020] + "…"
        fields.append({"name": f"Failures ({len(failures)})", "value": text, "inline": False})

    payload = {
        "embeds": [{
            "title":       "WC sim validation FAILED",
            "description": message[:2000],
            "color":       15158332,  # red
            "fields":      fields,
        }],
    }
    return _post_message(BOT_LOGS_CHANNEL_ID, token, payload)
