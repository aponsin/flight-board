// #C983: the board's own text gives times in the team's zone (Mountain Time), never UTC "Z" (#C979 refuses "Z" in what agents
// write; this is the same rule for what the board writes). Stored times stay ms since the epoch (UTC); logs and evidence files may
// keep ISO "Z". Pure: the time comes in, the zone's rules come from Intl (summer time included).
// America/Boise: the same offsets and summer-time dates as the Mountain zone the team keeps, as the Collector's schedule uses
// (collector/state.mjs SCHEDULE); the push scan keeps the city name out of this repository.
export const TEAM_TZ = "America/Boise";
export const TEAM_TZ_LABEL = "MT";
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TZ, hour: "numeric", minute: "2-digit", hour12: true });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: TEAM_TZ, month: "short", day: "numeric" });
const clock = (ms) => TIME.format(ms).replace(/\s+/g, " ").replace(/ ([AP])M$/, (_, x) => ` ${x.toLowerCase()}m`);
// "8:45 pm MT"; a value no Date can hold gives "?".
export const mtTime = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? `${clock(ms)} ${TEAM_TZ_LABEL}` : "?");
// "Nov 12 8:45 pm MT": the day as well, for an end or a start that may not be today.
export const mtDayTime = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? `${DAY.format(ms)} ${clock(ms)} ${TEAM_TZ_LABEL}` : "?");
