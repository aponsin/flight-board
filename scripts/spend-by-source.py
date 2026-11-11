#!/usr/bin/env python3 -I
"""Token spend by source, from Claude Code transcripts. Director's seed for #C595 (usage tile).

Reads ~/.claude/projects/*/*.jsonl and the subagent transcripts under */<session>/subagents/, sums each assistant
call's usage once (#C842) since a start time, and groups by session title (from the app's session files). Prints a table;
--json prints machine-readable rows. Weighted = input + cache_creation + 5*output (times a per-model weight, and plus a
cache_read weight, both set below, 1 and 0 until a panel reading says otherwise); cache_read is always listed apart (cheap per
token, but it is how a 400k-context session gets expensive).

Usage: python3 -I spend-by-source.py [--since 2026-11-02T06:00] [--json]
Reads only. Never prints message text, only numbers and session titles.
"""
import json, glob, os, sys, collections, datetime, re

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

# #C640: an untitled transcript is named by who it is, so "other" is only what cannot be told. First by the role in its first
# "/pickup <Role>" user line (a session picked up as that role is that role); else by the folder it ran in. The sender of a
# cross-session message is not used: it names who wrote to the session, not who the session is.
PICKUP = re.compile(r"(?:/pickup\s+|<command-name>/pickup</command-name>.{0,200}?<command-args>\s*)([A-Z][A-Za-z]{1,30})\b", re.S)
# (the app names a project folder after the working folder, "/" and "." both as "-", so ".flight-board/<board>" is "--flight-board-<board>")
FOLDERS = [(r"--flight-board-", "Collector"), (r"flight-board(-|$)", "Boardsmith")]
# Any other folder named for a role ("...-<team>-manager"): its last word, capitalised, when a titled session of that name exists.
KNOWN_ROLES = set(titles.values())
MAX_USER_LINES = 400


def role_from_pickup(path):
    seen = 0
    try:
        for line in open(path, errors="ignore"):
            if '"user"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "user":
                continue
            seen += 1
            c = (d.get("message") or {}).get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            m = PICKUP.search(c) if isinstance(c, str) else None
            if m:
                return m.group(1)
            if seen >= MAX_USER_LINES:
                break
    except Exception:
        pass
    return None


def role_from_folder(path):
    folder = os.path.basename(os.path.dirname(path))
    for part, role in FOLDERS:
        if re.search(part, folder):
            return role
    word = folder.split("-")[-1].capitalize()
    return word if word in KNOWN_ROLES else None


# #C842: three counting gaps. (1) One assistant message is written as one transcript line per content block, each repeating its usage:
# a call is counted once, by (message id, request id), keeping the line with the most output. (2) Subagent transcripts
# (<project>/<session>/subagents/*.jsonl) belong to their parent session. (3) cache_read and the model are weighed by the two tables
# below. The real rates are not known here, so they start at "cache_read not counted, every model 1": a weight is set only from a
# panel reading, never guessed (see #C842's thread). Tokens are always listed apart in cache_read.
CACHE_READ_WEIGHT = 0.0
MODEL_WEIGHT = {}  # model id substring -> weight, e.g. {"fable": 2.0}; a model matching none weighs 1


def model_weight(model):
    for part, w in MODEL_WEIGHT.items():
        if part in (model or ""):
            return w
    return 1


agg =collections.defaultdict(lambda: {"weighted": 0, "cache_read": 0, "calls": 0})
since_ts = datetime.datetime.fromisoformat(since).replace(tzinfo=datetime.timezone.utc).timestamp()
best = {}
home = os.path.expanduser("~/.claude/projects")
for f in glob.glob(home + "/*/*.jsonl") + glob.glob(home + "/*/*/subagents/*.jsonl"):
    if os.path.getmtime(f) < since_ts:
        continue
    sid, named = os.path.basename(f)[:-6], f
    if os.path.basename(os.path.dirname(f)) == "subagents":
        sid = os.path.basename(os.path.dirname(os.path.dirname(f)))
        named = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(f))), sid + ".jsonl")
    t = titles.get(sid, "(untitled)")
    if t == "(untitled)":
        t = role_from_pickup(named) or role_from_folder(named) or t
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
        m = d.get("message") or {}
        u = m.get("usage")
        if not u:
            continue
        out = u.get("output_tokens", 0)
        key = (m.get("id"), d.get("requestId")) if m.get("id") else (f, id(d))
        if key in best and best[key][4] >= out:
            continue
        best[key] = (t, m.get("model"), u.get("input_tokens", 0), u.get("cache_creation_input_tokens", 0), out, u.get("cache_read_input_tokens", 0))

for t, model, inp, cc, out, cr in best.values():
    a = agg[t]
    a["weighted"] += round(model_weight(model) * (inp + cc + 5 * out + CACHE_READ_WEIGHT * cr))
    a["cache_read"] += cr
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
