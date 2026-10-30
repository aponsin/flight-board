# The context keeper's task

The scheduled task that measures every agent's context, cues resets and picks the reset sessions back up. The lead saves
the prompt below into the task (`update_scheduled_task`) after a release that changes it, with the team's values in
place of `{{TEAM}}` (the team's name), `{{FOLDERS}}` (#C456: the words the agents' folders contain, each in double quotes, comma-separated, e.g. `"team", "flight-board"`, so an agent working in the board's own repository is measured too) and `{{ROLES}}` (the
agents' titles, the lead's included, comma-separated), `{{RESET_AT}}` (board.config.json's `resetAt`, written with commas: 600,000; #C399, so a new limit is a config change and a re-save, never a re-sign) and `{{BOARD}}` (the board's link, board.config.json's `artifactUrl`; #C401), and `{{WATCHDOG}}` (#C411: with board.config.json's `collector.keeper.watchdog` {script, state, alert}, the sentence (`watchdogStep` in collector/keeper.mjs) `run exactly (one Bash call, nothing around it) "node <script> <state> <alert>". If it prints a line, send that exact line as ONE PushNotification (status proactive) and, as its own message, to the session titled "Manager"; if it prints nothing, go on.`; without it, `none.`). Hourly (cron `0 * * * *`).

The watchdog check (#C411, the stuck-agent watchdog stopped for 18 h unnoticed): the script prints one line when the
watchdog's state file says its last run is over 90 minutes old (or there is none), once per stop, and nothing otherwise.
The task's permissions allow Bash for exactly that command (Security, an exact rule beside `sleep 120`), so the keeper
must run it as written, one bare call.

The task's permissions allow Bash for exactly the command `sleep 120` (an exact rule), never Bash in general
(Security on a307d81): the keeper reads every session's title, so a broad grant would let a crafted title run commands.

A reset is told by the Messages category of get_usage's context, not its total (Checker on a307d81): the total carries
some 88k of tools, prompt, memory and skills even in a cleared session. Messages under 5,000 is a session cleared and
not yet picked up, within the run that reset it (step 6). Across runs it isn't enough (#C401): "/pickup Reviewer" went
out three runs in a row to a session already picked up (idle, 91k, Messages still under 5,000). So the lead records
agents.<Title>.pickedAt on the board's meta/context for each pickup the report lists, and a pickup from an earlier run
(step 4) skips a session picked up since its last reset: pickedAt set, and the session not active for more than 30
minutes after it (list_sessions' lastActivityAt; no tool tells a reset's time, and a reset after a pickup means working
up to the limit, far longer). A missing pickedAt still gets the pickup, so an agent that resets itself on its own cue,
with no saved entry, isn't left idle with Remote Control off (Checker on c70dfb1; Manager's pick B). The task reads
meta/context and nothing else on the board, and never writes it. An allow rule can't be limited to a get (an
"ArtifactData" rule covers writes too), so the task has no ArtifactData allow rule (Security on c70dfb1); if the get
then asks for approval in the unattended run, tell Security before anyone widens anything.

Why the pickups are the keeper's (#C379, Director for the owner): the 05:12Z wave of 2026-10-28 reset the lead along
with everyone else, so nobody sent the pickups, and every reset session sat idle with Remote Control off until the
owner saw the laptop go blank. Now the run that cues a reset waits for it and sends `/pickup <Role>` itself (a message
in also brings Remote Control back). Others first, the lead last, Director never in a wave with the lead.

## Prompt

```
You are the {{TEAM}} context keeper. You measure each agent, cue resets, and pick the reset sessions back up yourself. Never clear a session yourself, never touch Remote Control, and message only the sessions named here. Be brief and cheap.

Thresholds are in TOKENS, not percent (the owner, 2026-10-27): usage charges the context re-read on every call, so its absolute size matters, and windows differ between models (200k or 1M).

1. Load tools with ToolSearch: "select:mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__get_usage,PushNotification,mcp__ccd_session_mgmt__send_message,ArtifactData". Then the watchdog: {{WATCHDOG}}
2. list_sessions (limit 100; old scheduled-task runs crowd the list). Keep sessions that are not archived, whose cwd contains one of: {{FOLDERS}}, and whose title is one of: {{ROLES}}; note each one's lastActivityAt. A title in that list with no such session is missing: name it in the report (step 8). Never measure, cue or message Director or any scheduled-task session.
3. For each, call get_usage with its sessionId and read the context tokens used, plus the percent for the report, and the tokens of its "Messages" category (none listed counts as 0). Skip any whose context status isn't "ok"; note those as "n/a".
4. Pickups owed from an earlier run first. Read the board's memory record once (ArtifactData get, url {{BOARD}}, collection "meta", doc_id "context"; read it, never write it). For each session that is idle (not working) and whose Messages are under 5,000 tokens, send it exactly "/pickup <Title>" (for example "/pickup Checker"): it reset, on an earlier run or by itself, and can't resume itself. Except a session already picked up since its reset: agents.<Title>.pickedAt there is a time (milliseconds) and the session's lastActivityAt (from step 2) is no more than 30 minutes after it. Send that one nothing: a session just picked up can sit under 5,000 Messages tokens too, and a reset after a pickup takes far more than 30 minutes of work. A missing pickedAt still gets the pickup (an agent that reset itself on its own cue).
5. The wave: every session at {{RESET_AT}} tokens or more (or 80% of a 200k window), except Manager. Skip one that is working right now; it gets the cue on the next run. Send each exactly "CONTEXT RESET" and nothing else.
6. Pick the wave back up, in this run: wait with a background shell sleep of 120 seconds (Bash, run_in_background: true, "sleep 120"; never a foreground sleep), and when it ends call get_usage again for each session of the wave not yet picked up. A session that is idle and whose Messages are under 5,000 tokens has reset: send it exactly "/pickup <Title>" at once. Wait again for the rest, at most 8 waits (16 minutes) in all. A session still not reset after that is listed as "not reset" in the report; step 4 picks it up on a later run.
7. Manager last, and only after the wave: if Manager is at {{RESET_AT}} tokens or more and idle, send it the report (step 8) first, with Manager listed under "pickup sent" (it is picked up next), then exactly "CONTEXT RESET", then wait and pick it up exactly as in step 6 ("/pickup Manager"). If Manager is working, skip it; it gets the cue on the next run. Director is never cued by this task, so Director is never reset in the same wave as Manager.
8. Always send ONE report to the session titled "Manager" (find its sessionId in the list), exactly in this shape, once the wave is picked up (before Manager's own reset cue, if any):
   "Context keeper: all: <Title> <tokens>k (<pct>%), … | reset sent: <Title> <tokens>k, … (or none) | pickup sent: <Title>, … (or none) | not reset: <Title>, … (or none) | busy, retry next run: <Title>, … (or none) | missing: <Title>, … (or none). Update the board's Agents' memory tiles; for each reset sent that isn't picked up yet (not reset), set saved with savedTokens and savedPct at its count above; for each pickup sent, set pickedAt to now (milliseconds) and delete its saved, savedTokens and savedPct."
   "all" lists every session measured, by tokens descending, Manager included.
9. Reply with one line: the messages sent.
```

## Dry run (the acceptance)

Before saving the prompt into the live task, rehearse it on a test role so no real agent is reset:

1. Start a session in a folder that contains one of `{{FOLDERS}}`, titled "Rehearsal" with Remote Control on, and work it past a few thousand
   tokens. Make a copy of the prompt with "Rehearsal" as the only title in step 2, the reset threshold in steps 5 and 7
   lowered to that session's count, and "Manager" in step 8 replaced by the rehearsal's own lead (any idle session).
2. Run the copy once as a one-time scheduled task. Rehearsal gets "CONTEXT RESET", hands off and clears itself.
3. Pass when, without anyone else's help, the run's step 6 sends "/pickup Rehearsal" within its waits, Rehearsal
   picks up from its note, Remote Control is on again for it, and the report lists it under "pickup sent".
4. Delete the one-time task and archive Rehearsal.
