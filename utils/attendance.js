const HARARE_TIME_ZONE = "Africa/Harare";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const ATTENDANCE_STATUSES = [
  "Present",
  "Late",
  "Sick Leave",
  "Leave",
  "Holiday",
  "School Duty",
  "Sports/Activities Duty",
  "Absent",
];

const ATTENDED_STATUSES = [
  "Present",
  "Late",
  "School Duty",
  "Sports/Activities Duty",
];

const TEACHER_ROLES = [
  "teacher",
  "teacher_in_charge",
  "deputy_head",
  "head",
];

function statusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STATUS_BY_KEY = new Map(
  ATTENDANCE_STATUSES.map((status) => [statusKey(status), status])
);

function normalizeStatus(value) {
  if (typeof value !== "string") {
    return null;
  }

  return STATUS_BY_KEY.get(statusKey(value)) || null;
}

const harareFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HARARE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKeyInHarare(date = new Date()) {
  const parts = harareFormatter.formatToParts(date);
  const values = {};

  for (const { type, value } of parts) {
    if (type !== "literal") {
      values[type] = value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function todayDateKey() {
  return dateKeyInHarare(new Date());
}

function parseDateKey(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

function utcValue(key) {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDaysKey(key, days) {
  return new Date(utcValue(key) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((utcValue(to) - utcValue(from)) / DAY_MS);
}

function isWeekdayKey(key) {
  const day = new Date(utcValue(key)).getUTCDay();
  return day >= 1 && day <= 5;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function currentMonthRange() {
  const today = todayDateKey();
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}

function resolveStatsRange(query = {}) {
  const defaults = currentMonthRange();
  let from = defaults.from;
  let to = defaults.to;

  if (query.from !== undefined && query.from !== "") {
    const parsed = parseDateKey(query.from);

    if (!parsed) {
      return { error: "from must be a valid YYYY-MM-DD date" };
    }

    from = parsed;
  }

  if (query.to !== undefined && query.to !== "") {
    const parsed = parseDateKey(query.to);

    if (!parsed) {
      return { error: "to must be a valid YYYY-MM-DD date" };
    }

    to = parsed;
  }

  if (from > to) {
    return { error: "from must be on or before to" };
  }

  if (daysBetween(from, to) + 1 > 366) {
    return { error: "Date range cannot exceed 366 days" };
  }

  return { from, to };
}

function monthKeysBetween(from, to) {
  const toMonth = to.slice(0, 7);
  const months = [];
  let [year, month] = from.slice(0, 7).split("-").map(Number);

  while (true) {
    const key = `${year}-${pad(month)}`;
    months.push(key);

    if (key >= toMonth) {
      break;
    }

    month += 1;

    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

function totalWeeks(from, to) {
  return Math.floor(daysBetween(from, to) / 7) + 1;
}

module.exports = {
  ATTENDANCE_STATUSES,
  ATTENDED_STATUSES,
  HARARE_TIME_ZONE,
  TEACHER_ROLES,
  addDaysKey,
  currentMonthRange,
  dateKeyInHarare,
  daysBetween,
  isWeekdayKey,
  monthKeysBetween,
  normalizeStatus,
  parseDateKey,
  resolveStatsRange,
  todayDateKey,
  totalWeeks,
};
