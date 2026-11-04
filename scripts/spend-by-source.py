#!/usr/bin/env python3 -I
"""Token spend by source, from Claude Code transcripts. Director's seed for #C595 (usage tile).

Reads ~/.claude/projects/*/*.jsonl, sums each assistant call's usage since a start time,
and groups by session title (from the app's session files). Prints a table; --json prints
machine-readable rows. Weighted = input + cache_creation + 5*output; cache_read is listed
apart (cheap per token, but it is how a 400k-context session gets expensive).

Usage: python3 -I spend-by-source.py [--since 2026-11-02T06:00] [--json]
Reads only. Never prints message text, only numbers and session titles.
"""
import json, glob, os, sys, collections, datetime

args = sys.argv[1:]
since = None
if "--since" in args:
    since = args[args.index("--since") + 1]
else:
    # default: today 00:00 local, as UTC ISO prefix
    d = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    since = d.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M")
as_json = "--json" in args

titles = {}
for f in glob.glob(os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    cid = d.get("cliSessionId")
    if cid:
        titles[cid] = d.get("title") or "(untitled)"

SCHED = ["context keeper", "watchdog", "Collector", "Steward", "Ops daily", "miss-to-guard"]
agg = collections.defaultdict(lambda: {"weighted": 0, "cache_read": 0, "calls": 0})
since_ts = datetime.datetime.fromisoformat(since).replace(tzinfo=datetime.timezone.utc).timestamp()
for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
    if os.path.getmtime(f) < since_ts:
        continue
    sid = os.path.basename(f)[:-6]
    t = titles.get(sid, "(untitled)")
    for k in SCHED:
        if k.lower() in t.lower():
            t = "scheduled: " + k
            break
    for line in open(f, errors="ignore"):
        if '"usage"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("timestamp", "") < since:
            continue
        u = (d.get("message") or {}).get("usage")
        if not u:
            continue
        a = agg[t]
        a["weighted"] += u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + 5 * u.get("output_tokens", 0)
        a["cache_read"] += u.get("cache_read_input_tokens", 0)
        a["calls"] += 1

total = sum(v["weighted"] for v in agg.values()) or 1
rows = sorted(agg.items(), key=lambda x: -x[1]["weighted"])
if as_json:
    print(json.dumps({"since": since, "total_weighted": total,
                      "rows": [{"source": t, **v, "share": round(v["weighted"] / total, 3)} for t, v in rows]}))
else:
    print(f"since {since}Z   total {total/1e6:.1f}M weighted")
    for t, v in rows:
        if v["calls"] == 0:
            continue
        print(f"{v['weighted']/1e6:6.2f}M {100*v['weighted']/total:4.0f}%  {v['calls']:5d} calls  cache_read {v['cache_read']/1e6:6.0f}M  {t}")
    sched = sum(v["weighted"] for t, v in agg.items() if t.startswith("scheduled"))
    print(f"scheduled runs: {100*sched/total:.0f}%")
