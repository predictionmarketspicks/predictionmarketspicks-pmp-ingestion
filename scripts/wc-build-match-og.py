#!/usr/bin/env python3
"""Slim brand-indigo per-match social OG images (1200x630) — Step D.

Hand-crafted SVG (NOT Pillow, per CLAUDE.md) rasterized with rsvg-convert. Each
PNG re-uploads to the Supabase `match-graphics` bucket under the EXACT legacy
filename `Match_{group}{md}_{home}_vs_{away}.png` so the site's matchGraphicUrl()
(OG/Twitter + schema ImageObject) keeps resolving — now on-brand instead of the
old black card.

Data: ../prediction-marketspicks/data/wc2026-matches.json (home/away/group/md/
hw/d/aw/pick). Deterministic, no DB reads for the render.

Usage:
  python3 scripts/wc-build-match-og.py --only south-africa-vs-korea-republic
  python3 scripts/wc-build-match-og.py                 # render all 72 to OUT_DIR
  python3 scripts/wc-build-match-og.py --upload        # render all + upsert to bucket
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from urllib import request as urlrequest

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_DATA = os.path.normpath(os.path.join(HERE, "..", "..", "prediction-marketspicks", "data"))
SITE_ENV = os.path.normpath(os.path.join(HERE, "..", "..", "prediction-marketspicks", ".env.local"))
MATCHES_PATH = os.path.join(SITE_DATA, "wc2026-matches.json")
OUT_DIR = os.path.join(tempfile.gettempdir(), "wc-og")
BUCKET = "match-graphics"

# ── Sanctum Warm tokens ───────────────────────────────────────────────────────
INDIGO = "#1B1340"
GOLD = "#C9A243"
GOLD_LIGHT = "#F5D88E"
GOLD_WARM = "#E4C870"
PARCHMENT = "#F5F0E8"
MUTED = "#C9B7A0"
GAIN = "#1F7A3F"
GAIN_LIGHT = "#7CDB97"
KHAKI = "#6F6450"


def team_to_filename(name: str) -> str:
    """Mirror app/.../[matchSlug]/page.tsx teamToFilename EXACTLY (overwrite target)."""
    name = re.sub(r"\s*\(TBD\)", "", name)
    name = re.sub(r"^IC(\d+)$", r"Intercontinental_\1", name)
    name = re.sub(r"^Playoff ([A-D])$", r"Playoff_\1", name)
    name = "".join(c for c in __import__("unicodedata").normalize("NFD", name)
                    if __import__("unicodedata").category(c) != "Mn")
    name = name.replace("'", "")
    name = re.sub(r"&\s*", "and_", name)
    name = re.sub(r"\s+", "_", name)
    return name


def format_odds(pct: float) -> str:
    """American odds from a win probability (percent). Mirrors lib formatOdds."""
    if pct <= 0:
        return "N/A"
    implied = pct / 100.0
    if implied >= 0.5:
        return f"-{round((implied / (1 - implied)) * 100)}"
    return f"+{round(((1 - implied) / implied) * 100)}"


def xml_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def team_font_size(home: str, away: str) -> int:
    longest = max(len(home), len(away))
    if longest <= 12:
        return 66
    if longest <= 16:
        return 56
    if longest <= 20:
        return 46
    return 40


def date_label(iso: str) -> str:
    import datetime
    try:
        dt = datetime.datetime.strptime(iso, "%Y-%m-%d")
        return dt.strftime("%a · %b %-d").upper()
    except ValueError:
        return iso


def build_svg(m: dict) -> str:
    home, away = m["home"], m["away"]
    hw, d, aw = m["hw"], m["d"], m["aw"]
    total = (hw + d + aw) or 1
    home_fav = hw >= aw

    W = 1200
    H = 630
    pad = 64
    bar_w = W - 2 * pad  # 1072
    bar_x = pad
    bar_y = 372
    bar_h = 58

    # Segment widths (proportional, sum to bar_w).
    w_home = bar_w * hw / total
    w_draw = bar_w * d / total
    w_away = bar_w - w_home - w_draw
    seg = [
        (bar_x, w_home, f"{hw}%", GAIN if home_fav else GOLD, "#EAF7EE" if home_fav else "#2A1D08"),
        (bar_x + w_home, w_draw, f"{d}%", KHAKI, PARCHMENT),
        (bar_x + w_home + w_draw, w_away, f"{aw}%", GOLD if home_fav else GAIN, "#2A1D08" if home_fav else "#EAF7EE"),
    ]
    seg_rects = ""
    seg_labels = ""
    for x, w, label, fill, txt in seg:
        seg_rects += f'<rect x="{x:.1f}" y="{bar_y}" width="{w:.1f}" height="{bar_h}" fill="{fill}"/>'
        if w > 60:
            seg_labels += (
                f'<text x="{x + w / 2:.1f}" y="{bar_y + bar_h / 2 + 9:.1f}" font-family="Menlo" '
                f'font-size="26" font-weight="700" fill="{txt}" text-anchor="middle">{label}</text>'
            )

    # Odds row (three thirds).
    third = bar_w / 3
    cols = [
        (home.upper()[:3], format_odds(hw), GAIN_LIGHT if home_fav else GOLD_LIGHT),
        ("DRAW", format_odds(d), PARCHMENT),
        (away.upper()[:3], format_odds(aw), GOLD_LIGHT if home_fav else GAIN_LIGHT),
    ]
    odds_y = 472
    odds = ""
    for i, (lbl, val, color) in enumerate(cols):
        cx = bar_x + third * (i + 0.5)
        odds += (
            f'<text x="{cx:.1f}" y="{odds_y}" font-family="Menlo" font-size="15" fill="{MUTED}" '
            f'letter-spacing="1" text-anchor="middle">{xml_escape(lbl)}</text>'
            f'<text x="{cx:.1f}" y="{odds_y + 32}" font-family="Menlo" font-size="30" font-weight="700" '
            f'fill="{color}" text-anchor="middle">{val}</text>'
        )

    fs = team_font_size(home, away)
    pick = xml_escape(m.get("pick", ""))
    play_y = 528
    play_h = 64

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <defs>
    <radialGradient id="bg" cx="18%" cy="-10%" r="120%">
      <stop offset="0%" stop-color="#2A1D5F"/>
      <stop offset="55%" stop-color="{INDIGO}"/>
      <stop offset="100%" stop-color="#120D2B"/>
    </radialGradient>
    <clipPath id="barclip"><rect x="{bar_x}" y="{bar_y}" width="{bar_w}" height="{bar_h}" rx="12"/></clipPath>
  </defs>
  <rect width="{W}" height="{H}" fill="{INDIGO}"/>
  <rect width="{W}" height="{H}" fill="url(#bg)"/>
  <rect x="20" y="20" width="{W - 40}" height="{H - 40}" rx="18" fill="none" stroke="rgba(201,162,67,0.28)" stroke-width="2"/>

  <!-- header -->
  <rect x="{pad}" y="54" width="282" height="34" rx="6" fill="{GOLD_WARM}"/>
  <text x="{pad + 16}" y="77" font-family="Menlo" font-size="16" font-weight="700" fill="{INDIGO}" letter-spacing="2">GROUP {m["group"]} · MATCHDAY {m["md"]}</text>
  <text x="{W - pad}" y="77" font-family="Menlo" font-size="16" fill="{MUTED}" letter-spacing="1.5" text-anchor="end">{date_label(m["date"])}</text>

  <!-- teams -->
  <text x="{W/2}" y="188" font-family="Lora" font-size="{fs}" font-weight="700" fill="{PARCHMENT}" text-anchor="middle">{xml_escape(home.upper())}</text>
  <text x="{W/2}" y="232" font-family="Menlo" font-size="20" fill="{GOLD}" letter-spacing="8" text-anchor="middle">VS</text>
  <text x="{W/2}" y="300" font-family="Lora" font-size="{fs}" font-weight="700" fill="{PARCHMENT}" text-anchor="middle">{xml_escape(away.upper())}</text>

  <!-- W/D/L bar -->
  <g clip-path="url(#barclip)">{seg_rects}</g>
  {seg_labels}

  <!-- odds -->
  {odds}

  <!-- top value play -->
  <rect x="{pad}" y="{play_y}" width="{bar_w}" height="{play_h}" rx="10" fill="rgba(201,162,67,0.10)" stroke="rgba(201,162,67,0.32)" stroke-width="1.5"/>
  <text x="{pad + 20}" y="{play_y + 25}" font-family="Menlo" font-size="13" font-weight="700" fill="{GOLD}" letter-spacing="2">TOP VALUE PLAY</text>
  <text x="{pad + 20}" y="{play_y + 50}" font-family="Lora" font-size="24" font-weight="700" fill="{GOLD_LIGHT}">{pick}</text>

  <!-- footer -->
  <text x="{pad}" y="{H - 26}" font-family="Menlo" font-size="14" fill="{MUTED}" letter-spacing="1">10K SIM · KALSHI REFERENCE</text>
  <text x="{W - pad}" y="{H - 26}" font-family="Menlo" font-size="14" fill="{MUTED}" letter-spacing="1" text-anchor="end">predictionmarketspicks.com</text>
</svg>'''


def render(m: dict, out_dir: str) -> str:
    fn = f"Match_{m['group']}{m['md']}_{team_to_filename(m['home'])}_vs_{team_to_filename(m['away'])}.png"
    svg_path = os.path.join(out_dir, fn.replace(".png", ".svg"))
    png_path = os.path.join(out_dir, fn)
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(build_svg(m))
    subprocess.run(
        ["rsvg-convert", "-w", "1200", "-h", "630", svg_path, "-o", png_path],
        check=True,
    )
    return png_path


def load_env(path: str) -> dict:
    env = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def upload(png_path: str, env: dict, retries: int = 4) -> int:
    import time
    url = f"{env['SUPABASE_URL']}/storage/v1/object/{BUCKET}/{os.path.basename(png_path)}"
    with open(png_path, "rb") as f:
        body = f.read()
    last = None
    for attempt in range(retries):
        try:
            req = urlrequest.Request(url, data=body, method="POST")
            req.add_header("Authorization", f"Bearer {env['SUPABASE_SERVICE_KEY']}")
            req.add_header("Content-Type", "image/png")
            req.add_header("x-upsert", "true")
            resp = urlrequest.urlopen(req, timeout=30)
            return resp.status
        except Exception as e:  # transient TLS/network hiccups over a long batch
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise last


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="render a single match slug")
    ap.add_argument("--upload", action="store_true", help="upsert PNGs to the bucket")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(MATCHES_PATH, encoding="utf-8") as f:
        matches = json.load(f)["matches"]

    if args.only:
        matches = [m for m in matches if m["slug"] == args.only]
        if not matches:
            print(f"no match with slug {args.only!r}")
            return 1

    env = load_env(SITE_ENV) if args.upload else {}
    if args.upload and (not env.get("SUPABASE_URL") or not env.get("SUPABASE_SERVICE_KEY")):
        print("missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.local")
        return 1

    done = 0
    for m in matches:
        png = render(m, OUT_DIR)
        if args.upload:
            status = upload(png, env)
            print(f"  upload {os.path.basename(png)} -> HTTP {status}")
        done += 1
    print(f"rendered {done} -> {OUT_DIR}" + (" (uploaded)" if args.upload else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
