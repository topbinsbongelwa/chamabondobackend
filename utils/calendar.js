const {
  addDaysKey,
  currentMonthRange,
  dateKeyInHarare,
  parseDateKey,
} = require("./attendance");

const CALENDAR_TYPES = ["Event", "Activity", "Update", "Holiday", "Deadline"];
const CALENDAR_AUDIENCES = ["all", "department"];
const CALENDAR_PRIORITIES = ["Normal", "Important"];
const CALENDAR_CATEGORIES = [
  "Sports",
  "Academic",
  "Meeting",
  "Cultural",
  "Other",
];

const TYPE_BY_KEY = new Map(
  CALENDAR_TYPES.map((type) => [type.toLowerCase(), type])
);
const AUDIENCE_BY_KEY = new Map(
  CALENDAR_AUDIENCES.map((audience) => [audience.toLowerCase(), audience])
);
const PRIORITY_BY_KEY = new Map(
  CALENDAR_PRIORITIES.map((priority) => [priority.toLowerCase(), priority])
);
const CATEGORY_BY_KEY = new Map(
  CALENDAR_CATEGORIES.map((category) => [category.toLowerCase(), category])
);

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function lookup(map, value) {
  if (typeof value !== "string") {
    return null;
  }

  return map.get(value.trim().toLowerCase()) || null;
}

function normalizeCalendarType(value) {
  return lookup(TYPE_BY_KEY, value);
}

function normalizeCalendarAudience(value) {
  return lookup(AUDIENCE_BY_KEY, value);
}

function normalizeCalendarPriority(value) {
  return lookup(PRIORITY_BY_KEY, value);
}

function normalizeCalendarCategory(value) {
  return lookup(CATEGORY_BY_KEY, value);
}

function isValidTime(value) {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

function toCalendarDateKey(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : dateKeyInHarare(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return parseDateKey(trimmed);
    }

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : dateKeyInHarare(date);
  }

  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : dateKeyInHarare(date);
  }

  return null;
}

/*
  Returns every calendar day covered by a Holiday item inside [from, to].
  Holiday items are school-wide, so audience is intentionally ignored.
*/
async function getHolidayDates(db, from, to) {
  const fromKey = parseDateKey(from);
  const toKey = parseDateKey(to);

  if (!fromKey || !toKey || fromKey > toKey) {
    return [];
  }

  const holidays = await db
    .collection("calendar")
    .find(
      {
        type: "Holiday",
        startDate: { $lte: toKey },
        endDate: { $gte: fromKey },
      },
      { projection: { startDate: 1, endDate: 1 } }
    )
    .toArray();

  const dates = new Set();

  for (const holiday of holidays) {
    let start = toCalendarDateKey(holiday.startDate);
    let end = toCalendarDateKey(holiday.endDate) || start;

    if (!start) {
      continue;
    }

    if (end < start) {
      end = start;
    }

    if (start < fromKey) {
      start = fromKey;
    }

    if (end > toKey) {
      end = toKey;
    }

    for (let date = start; date <= end; date = addDaysKey(date, 1)) {
      dates.add(date);
    }
  }

  return [...dates].sort();
}

module.exports = {
  CALENDAR_AUDIENCES,
  CALENDAR_CATEGORIES,
  CALENDAR_PRIORITIES,
  CALENDAR_TYPES,
  TIME_PATTERN,
  currentMonthRange,
  getHolidayDates,
  isValidTime,
  normalizeCalendarAudience,
  normalizeCalendarCategory,
  normalizeCalendarPriority,
  normalizeCalendarType,
  toCalendarDateKey,
};
