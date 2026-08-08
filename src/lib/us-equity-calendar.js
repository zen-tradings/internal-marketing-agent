// Small, dependency-free NYSE session guard.  It covers regular recurring
// closures; extraordinary exchange closures still require the operator to
// disable the digest for that date.
export function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

export function easternDateKey(date = new Date()) {
  const { year, month, day } = easternParts(date);
  return `${year}-${month}-${day}`;
}

export function isSameEasternDay(left, right = new Date()) {
  return easternDateKey(left) === easternDateKey(right);
}

export function isUsEquitySession(date = new Date()) {
  const { year, month, day } = easternParts(date);
  const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const holidays = nyseHolidayKeys(Number(year));
  return !holidays.has(`${year}-${month}-${day}`);
}

export function nyseHolidayKeys(year) {
  const keys = new Set([
    observedFixed(year, 0, 1),
    nthWeekday(year, 0, 1, 3), // MLK Day
    nthWeekday(year, 1, 1, 3), // Presidents Day
    goodFriday(year),
    lastWeekday(year, 4, 1), // Memorial Day
    observedFixed(year, 5, 19), // Juneteenth
    observedFixed(year, 6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving
    observedFixed(year, 11, 25),
  ]);
  // NYSE closes for the National Day of Mourning after a sitting president
  // dies. Those extraordinary dates are intentionally not guessed here.
  return keys;
}

function formatUtc(date) { return date.toISOString().slice(0, 10); }
function observedFixed(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return formatUtc(date);
}
function nthWeekday(year, month, weekday, ordinal) {
  const date = new Date(Date.UTC(year, month, 1));
  const delta = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + delta + 7 * (ordinal - 1));
  return formatUtc(date);
}
function lastWeekday(year, month, weekday) {
  const date = new Date(Date.UTC(year, month + 1, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
  return formatUtc(date);
}
function goodFriday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(Date.UTC(year, month, day));
  easter.setUTCDate(easter.getUTCDate() - 2);
  return formatUtc(easter);
}
