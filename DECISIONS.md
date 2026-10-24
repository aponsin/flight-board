# Decisions

## The session's role is an integrity check, not access control
Chose: the gate takes a session's role from its title in the app (the transcript's latest custom title), then `FLIGHT_BOARD_ROLE`, and refuses when they disagree.   Because: a mistaken "/pickup <Role>" once made one role write as another; the title is what the owner sees.   Rejected: the conversation's last "/pickup" because that is exactly what went wrong.   Note: any session can rename itself or change its environment, so this guards against mistakes only. Nothing security-relevant may depend on it.

## The gate fails open on its own errors, closed on its rules
Chose: a config it can't read or a call it can't parse lets the write through with a note; a rule hit refuses (exit 2).   Because: the gate is a process guard; a broken gate must not stop the team's work.   Revisit if: a rule ever protects something that matters more than the team's pace.

## Rules that need the board's state wait for the collector
Chose: ids, phase order, one item per role and phase, and done-only-when-closed are checked by the collector against the mirror it keeps, not by the gate.   Because: a mirror kept by hand brings back the "lead remembers" dependency this project removes.
