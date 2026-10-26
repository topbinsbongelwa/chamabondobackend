const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate, requireRole } = require("../middleware/auth");
const {
  ATTENDANCE_STATUSES,
  ATTENDED_STATUSES,
  TEACHER_ROLES,
  addDaysKey,
  dateKeyInHarare,
  isWeekdayKey,
  monthKeysBetween,
  normalizeStatus,
  parseDateKey,
  resolveStatsRange,
  totalWeeks,
} = require("../utils/attendance");

const router = express.Router();

/*
  Attendance document shape (collection: "attendance")
  {
    _id: ObjectId,
    teacherId: ObjectId,
    date: "YYYY-MM-DD",         // Africa/Harare calendar day
    shift: "morning" | "afternoon",
    checkIn: Date | null,
    checkOut: Date | null,
    status: "Present" | "Late" | "Sick Leave" | "Leave" | "Holiday" |
            "School Duty" | "Sports/Activities Duty" | "Absent",
    notes: String,
    createdAt: Date,
    updatedAt: Date
  }

  Unique index: { teacherId: 1, date: 1 }
*/

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const SHIFT_ALIASES = {
  morning: "morning",
  am: "morning",
  "morning shift": "morning",
  afternoon: "afternoon",
  pm: "afternoon",
  "pm shift": "afternoon",
};
const DEFAULT_LATE_CUTOFFS = {
  morning: { hour: 8, minute: 0 },
  afternoon: { hour: 13, minute: 0 },
};

const toDateKey = dateKeyInHarare;

function attendance(req) {
  return req.app.locals.db.collection("attendance");
}

function users(req) {
  return req.app.locals.db.collection("users");
}

function parseCutoff(value, fallback) {
  const [hour, minute] = String(value || "")
    .split(":")
    .map(Number);

  return {
    hour: Number.isInteger(hour) ? hour : fallback.hour,
    minute: Number.isInteger(minute) ? minute : fallback.minute,
  };
}

const LATE_CUTOFFS = {
  morning: parseCutoff(
    process.env.MORNING_LATE_AFTER,
    DEFAULT_LATE_CUTOFFS.morning
  ),
  afternoon: parseCutoff(
    process.env.AFTERNOON_LATE_AFTER,
    DEFAULT_LATE_CUTOFFS.afternoon
  ),
};

function normalizeShift(value) {
  if (typeof value !== "string") {
    return null;
  }

  return SHIFT_ALIASES[value.trim().toLowerCase()] || null;
}

function inferShift(date = new Date()) {
  return date.getHours() < 12 ? "morning" : "afternoon";
}

function isLate(date = new Date(), shift = "morning") {
  const cutoff = LATE_CUTOFFS[shift] || LATE_CUTOFFS.morning;

  return (
    date.getHours() > cutoff.hour ||
    (date.getHours() === cutoff.hour && date.getMinutes() > cutoff.minute)
  );
}

function parseObjectId(value) {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value)) {
    return null;
  }

  return new ObjectId(value);
}

function parseDateTime(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildDateFilter(query) {
  const dateFilter = {};

  if (query.from !== undefined && query.from !== "") {
    const from = parseDateKey(query.from);

    if (!from) {
      return { error: "from must be a valid YYYY-MM-DD date" };
    }

    dateFilter.$gte = from;
  }

  if (query.to !== undefined && query.to !== "") {
    const to = parseDateKey(query.to);

    if (!to) {
      return { error: "to must be a valid YYYY-MM-DD date" };
    }

    dateFilter.$lte = to;
  }

  return Object.keys(dateFilter).length ? { dateFilter } : {};
}

function buildPagination(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || 50, 1),
    200
  );

  return { page, limit, skip: (page - 1) * limit };
}

function emptyCounts() {
  return Object.fromEntries(
    ATTENDANCE_STATUSES.map((status) => [status, 0])
  );
}

function statsAggregation(match, from) {
  return [
    { $match: match },
    {
      $facet: {
        statusCounts: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ],
        holidayDates: [
          { $match: { status: "Holiday" } },
          { $group: { _id: "$date" } },
        ],
        weekly: [
          {
            $addFields: {
              weekIndex: {
                $add: [
                  {
                    $floor: {
                      $divide: [
                        {
                          $dateDiff: {
                            startDate: {
                              $dateFromString: { dateString: from },
                            },
                            endDate: {
                              $dateFromString: { dateString: "$date" },
                            },
                            unit: "day",
                          },
                        },
                        7,
                      ],
                    },
                  },
                  1,
                ],
              },
            },
          },
          {
            $group: {
              _id: { week: "$weekIndex", status: "$status" },
              count: { $sum: 1 },
            },
          },
        ],
        monthly: [
          {
            $group: {
              _id: {
                month: { $substrBytes: ["$date", 0, 7] },
                status: "$status",
              },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ];
}

function countsFromRows(rows = []) {
  const counts = emptyCounts();

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
      counts[row._id] = row.count;
    }
  }

  return counts;
}

function attendedDaysFor(counts) {
  return ATTENDED_STATUSES.reduce(
    (total, status) => total + (counts[status] || 0),
    0
  );
}

function percentage(attendedDays, possibleDays) {
  if (!possibleDays) {
    return 0;
  }

  return Math.round((attendedDays / possibleDays) * 1000) / 10;
}

function workingDaysFor(range, holidayDates = []) {
  const holidays = new Set(holidayDates.filter(isWeekdayKey));
  let workingDays = 0;

  for (
    let date = range.from;
    date <= range.to;
    date = addDaysKey(date, 1)
  ) {
    if (isWeekdayKey(date) && !holidays.has(date)) {
      workingDays += 1;
    }
  }

  return workingDays;
}

function buildWeekly(range, rows = []) {
  const buckets = Array.from(
    { length: totalWeeks(range.from, range.to) },
    (_, index) => ({ week: `Week ${index + 1}`, ...emptyCounts() })
  );

  for (const row of rows) {
    const bucket = buckets[(row._id.week || 0) - 1];

    if (
      bucket &&
      Object.prototype.hasOwnProperty.call(bucket, row._id.status)
    ) {
      bucket[row._id.status] += row.count;
    }
  }

  return buckets;
}

function buildMonthly(range, rows = []) {
  const buckets = new Map(
    monthKeysBetween(range.from, range.to).map((month) => [
      month,
      { month, ...emptyCounts() },
    ])
  );

  for (const row of rows) {
    const bucket = buckets.get(row._id.month);

    if (
      bucket &&
      Object.prototype.hasOwnProperty.call(bucket, row._id.status)
    ) {
      bucket[row._id.status] += row.count;
    }
  }

  return [...buckets.values()];
}

function buildStats(range, facet = {}, teacherCount = 1) {
  const counts = countsFromRows(facet.statusCounts);
  const holidayDates = (facet.holidayDates || []).map((row) => row._id);
  const workingDays = workingDaysFor(range, holidayDates);
  const attendedDays = attendedDaysFor(counts);

  return {
    range: { from: range.from, to: range.to },
    workingDays,
    counts,
    attendedDays,
    attendanceRate: percentage(attendedDays, workingDays * teacherCount),
    weekly: buildWeekly(range, facet.weekly),
    monthly: buildMonthly(range, facet.monthly),
  };
}

function displayName(user) {
  return (
    [user.firstName, user.surname].filter(Boolean).join(" ") ||
    user.name ||
    user.ecNumber ||
    "Teacher"
  );
}

function buildByTeacher(teachers, rows, workingDays) {
  const entries = new Map(
    teachers.map((teacher) => [
      String(teacher._id),
      {
        teacherId: String(teacher._id),
        teacherName: displayName(teacher),
        department: teacher.department || null,
        counts: emptyCounts(),
      },
    ])
  );

  for (const row of rows) {
    const entry = entries.get(String(row._id.teacherId));

    if (
      entry &&
      Object.prototype.hasOwnProperty.call(entry.counts, row._id.status)
    ) {
      entry.counts[row._id.status] += row.count;
    }
  }

  return [...entries.values()]
    .map((entry) => {
      const attendedDays = attendedDaysFor(entry.counts);

      return {
        ...entry,
        attendedDays,
        attendanceRate: percentage(attendedDays, workingDays),
      };
    })
    .sort(
      (a, b) =>
        a.attendanceRate - b.attendanceRate ||
        a.teacherName.localeCompare(b.teacherName)
    );
}

function buildByDepartment(byTeacher, workingDays) {
  const entries = new Map();

  for (const teacher of byTeacher) {
    const department = teacher.department || "Unassigned";

    if (!entries.has(department)) {
      entries.set(department, {
        department,
        teacherCount: 0,
        counts: emptyCounts(),
      });
    }

    const entry = entries.get(department);
    entry.teacherCount += 1;

    for (const status of ATTENDANCE_STATUSES) {
      entry.counts[status] += teacher.counts[status];
    }
  }

  return [...entries.values()]
    .map((entry) => {
      const attendedDays = attendedDaysFor(entry.counts);

      return {
        ...entry,
        attendedDays,
        attendanceRate: percentage(
          attendedDays,
          workingDays * entry.teacherCount
        ),
      };
    })
    .sort((a, b) => a.department.localeCompare(b.department));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactInsensitive(value) {
  return { $regex: `^${escapeRegex(value)}$`, $options: "i" };
}

function normalizeDepartment(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

router.post("/check-in", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const body = req.body || {};
    const requestedShift = normalizeShift(body.shift);

    if (
      body.shift !== undefined &&
      body.shift !== null &&
      body.shift !== "" &&
      !requestedShift
    ) {
      return res.status(400).json({
        message: "shift must be morning or afternoon",
      });
    }

    const now = new Date();
    const date = toDateKey(now);
    const collection = attendance(req);
    const existing = await collection.findOne({ teacherId, date });

    if (existing && existing.checkIn) {
      return res.status(409).json({
        message: "You have already checked in today",
        attendance: existing,
      });
    }

    const shift = requestedShift || existing?.shift || inferShift(now);
    const status = isLate(now, shift) ? "Late" : "Present";

    const record = await collection.findOneAndUpdate(
      { teacherId, date },
      {
        $set: {
          shift,
          checkIn: now,
          status,
          updatedAt: now,
        },
        $setOnInsert: {
          teacherId,
          date,
          checkOut: null,
          notes: "",
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    return res.status(existing ? 200 : 201).json({ attendance: record });
  } catch (error) {
    if (error.code === 11000) {
      const teacherId = parseObjectId(req.user.id);
      const date = toDateKey();
      const record = await attendance(req).findOne({ teacherId, date });

      return res.status(409).json({
        message: "You have already checked in today",
        attendance: record,
      });
    }

    return next(error);
  }
});

router.patch("/check-out", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const now = new Date();
    const date = toDateKey(now);
    const collection = attendance(req);
    const existing = await collection.findOne({ teacherId, date });

    if (!existing || !existing.checkIn) {
      return res.status(404).json({
        message: "You have not checked in today",
      });
    }

    if (existing.checkOut) {
      return res.status(409).json({
        message: "You have already checked out today",
        attendance: existing,
      });
    }

    const record = await collection.findOneAndUpdate(
      { _id: existing._id, checkOut: null },
      { $set: { checkOut: now, updatedAt: now } },
      { returnDocument: "after" }
    );

    if (!record) {
      return res.status(409).json({
        message: "You have already checked out today",
      });
    }

    return res.json({ attendance: record });
  } catch (error) {
    return next(error);
  }
});

router.get("/today", authenticate, async (req, res, next) => {
  try {
    let teacherId;

    if (req.user.role === "admin" && req.query.teacherId) {
      teacherId = parseObjectId(req.query.teacherId);

      if (!teacherId) {
        return res.status(400).json({ message: "Invalid teacherId" });
      }
    } else {
      teacherId = parseObjectId(req.user.id);

      if (!teacherId) {
        return res.status(401).json({ message: "Invalid token" });
      }
    }

    const date = toDateKey();
    const record = await attendance(req).findOne({ teacherId, date });

    if (!record) {
      return res.status(404).json({ message: "No attendance recorded today" });
    }

    return res.json({ date, attendance: record });
  } catch (error) {
    return next(error);
  }
});

router.post("/mark", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const body = req.body || {};
    const status = normalizeStatus(body.status);

    if (!status) {
      return res.status(400).json({
        message: `status must be one of: ${ATTENDANCE_STATUSES.join(", ")}`,
      });
    }

    const now = new Date();
    const date = toDateKey(now);
    const collection = attendance(req);
    const existing = await collection.findOne({ teacherId, date });

    if (existing && existing.checkIn) {
      return res.status(409).json({
        message: "You have already checked in today",
        attendance: existing,
      });
    }

    const record = await collection.findOneAndUpdate(
      { teacherId, date },
      {
        $set: {
          status,
          notes: typeof body.note === "string" ? body.note.trim() : "",
          updatedAt: now,
        },
        $setOnInsert: {
          teacherId,
          date,
          checkIn: null,
          checkOut: null,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    return res.status(existing ? 200 : 201).json({ attendance: record });
  } catch (error) {
    if (error.code === 11000) {
      const teacherId = parseObjectId(req.user.id);
      const date = toDateKey();
      const record = await attendance(req).findOne({ teacherId, date });

      return res.status(409).json({
        message: "You have already marked attendance today",
        attendance: record,
      });
    }

    return next(error);
  }
});

router.get("/summary", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const range = resolveStatsRange({});
    const records = await attendance(req)
      .find({
        teacherId,
        date: { $gte: range.from, $lte: range.to },
      })
      .toArray();

    const summary = {
      present: 0,
      late: 0,
      sickLeave: 0,
      leave: 0,
      absent: 0,
    };

    for (const record of records) {
      switch (record.status) {
        case "Present":
        case "Holiday":
        case "School Duty":
        case "Sports/Activities Duty":
          summary.present += 1;
          break;
        case "Late":
          summary.late += 1;
          break;
        case "Sick Leave":
          summary.sickLeave += 1;
          break;
        case "Leave":
          summary.leave += 1;
          break;
        case "Absent":
          summary.absent += 1;
          break;
        default:
          break;
      }
    }

    return res.json({ month: range.from.slice(0, 7), summary });
  } catch (error) {
    return next(error);
  }
});

router.get("/stats", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const range = resolveStatsRange(req.query);

    if (range.error) {
      return res.status(400).json({ message: range.error });
    }

    const [facet] = await attendance(req)
      .aggregate(
        statsAggregation(
          {
            teacherId,
            date: { $gte: range.from, $lte: range.to },
          },
          range.from
        )
      )
      .toArray();

    return res.json(buildStats(range, facet || {}));
  } catch (error) {
    return next(error);
  }
});

router.get(
  "/stats/school",
  authenticate,
  requireRole("teacher_in_charge", "deputy_head", "head"),
  async (req, res, next) => {
    try {
      const range = resolveStatsRange(req.query);

      if (range.error) {
        return res.status(400).json({ message: range.error });
      }

      const isTeacherInCharge = req.user.role === "teacher_in_charge";
      let department = null;

      if (isTeacherInCharge) {
        const userId = parseObjectId(req.user.id);

        if (!userId) {
          return res.status(401).json({ message: "Invalid token" });
        }

        const currentUser = await users(req).findOne(
          { _id: userId },
          { projection: { department: 1 } }
        );

        if (!currentUser?.department) {
          return res.status(403).json({
            message: "Your account has no department assigned.",
          });
        }

        department = currentUser.department;

        if (
          req.query.department !== undefined &&
          req.query.department !== "" &&
          normalizeDepartment(req.query.department) !==
            normalizeDepartment(department)
        ) {
          return res.status(403).json({
            message:
              "You can only view attendance from your own department.",
          });
        }
      } else if (
        req.query.department !== undefined &&
        req.query.department !== ""
      ) {
        if (
          typeof req.query.department !== "string" ||
          !req.query.department.trim()
        ) {
          return res.status(400).json({ message: "Invalid department" });
        }

        department = req.query.department.trim();
      }

      const teacherFilter = { role: { $in: TEACHER_ROLES } };

      if (department) {
        teacherFilter.department = exactInsensitive(department);
      }

      if (
        req.query.teacherId !== undefined &&
        req.query.teacherId !== ""
      ) {
        const teacherId = parseObjectId(req.query.teacherId);

        if (!teacherId) {
          return res.status(400).json({ message: "Invalid teacherId" });
        }

        teacherFilter._id = teacherId;
      }

      const teachers = await users(req)
        .find(teacherFilter, {
          projection: {
            firstName: 1,
            surname: 1,
            name: 1,
            ecNumber: 1,
            department: 1,
          },
        })
        .toArray();

      const teacherCount = teachers.length;

      if (!teacherCount) {
        const stats = buildStats(range, {}, 1);
        stats.teacherCount = 0;
        stats.byTeacher = [];

        if (!isTeacherInCharge) {
          stats.byDepartment = [];
        }

        return res.json(stats);
      }

      const match = {
        teacherId: { $in: teachers.map((teacher) => teacher._id) },
        date: { $gte: range.from, $lte: range.to },
      };

      const [[facet], teacherRows] = await Promise.all([
        attendance(req)
          .aggregate(statsAggregation(match, range.from))
          .toArray(),
        attendance(req)
          .aggregate([
            { $match: match },
            {
              $group: {
                _id: {
                  teacherId: "$teacherId",
                  status: "$status",
                },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
      ]);

      const stats = buildStats(range, facet || {}, teacherCount);
      const byTeacher = buildByTeacher(
        teachers,
        teacherRows,
        stats.workingDays
      );

      stats.teacherCount = teacherCount;
      stats.byTeacher = byTeacher;

      if (!isTeacherInCharge) {
        stats.byDepartment = buildByDepartment(
          byTeacher,
          stats.workingDays
        );
      }

      return res.json(stats);
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/me", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseObjectId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const { dateFilter, error: dateError } = buildDateFilter(req.query);

    if (dateError) {
      return res.status(400).json({ message: dateError });
    }

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 100, 1),
      365
    );

    const filter = { teacherId };

    if (dateFilter) {
      filter.date = dateFilter;
    }

    const records = await attendance(req)
      .find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(limit)
      .toArray();

    return res.json({ attendance: records });
  } catch (error) {
    return next(error);
  }
});

router.get("/", authenticate, async (req, res, next) => {
  try {
    const filter = {};

    if (req.user.role === "admin") {
      if (req.query.teacherId) {
        const teacherId = parseObjectId(req.query.teacherId);

        if (!teacherId) {
          return res.status(400).json({ message: "Invalid teacherId" });
        }

        filter.teacherId = teacherId;
      }
    } else {
      const teacherId = parseObjectId(req.user.id);

      if (!teacherId) {
        return res.status(401).json({ message: "Invalid token" });
      }

      filter.teacherId = teacherId;
    }

    const { dateFilter, error: dateError } = buildDateFilter(req.query);

    if (dateError) {
      return res.status(400).json({ message: dateError });
    }

    if (dateFilter) {
      filter.date = dateFilter;
    }

    if (req.query.status) {
      const status = normalizeStatus(req.query.status);

      if (!status) {
        return res.status(400).json({ message: "Invalid status" });
      }

      filter.status = status;
    }

    if (req.query.shift) {
      const shift = normalizeShift(req.query.shift);

      if (!shift) {
        return res.status(400).json({ message: "Invalid shift" });
      }

      filter.shift = shift;
    }

    const { page, limit, skip } = buildPagination(req.query);
    const collection = attendance(req);

    const [records, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return res.json({ attendance: records, total, page, limit });
  } catch (error) {
    return next(error);
  }
});

router.post("/", authenticate, requireRole("admin"), async (req, res, next) => {
  try {
    const body = req.body || {};
    const teacherId = parseObjectId(body.teacherId);

    if (!teacherId) {
      return res.status(400).json({ message: "A valid teacherId is required" });
    }

    const teacher = await users(req).findOne(
      { _id: teacherId },
      { projection: { _id: 1 } }
    );

    if (!teacher) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    const date = body.date ? parseDateKey(body.date) : toDateKey();

    if (!date) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const checkIn = parseDateTime(body.checkIn);

    if (checkIn === undefined) {
      return res.status(400).json({ message: "Invalid checkIn date" });
    }

    const checkOut = parseDateTime(body.checkOut);

    if (checkOut === undefined) {
      return res.status(400).json({ message: "Invalid checkOut date" });
    }

    const requestedShift = normalizeShift(body.shift);

    if (
      body.shift !== undefined &&
      body.shift !== null &&
      body.shift !== "" &&
      !requestedShift
    ) {
      return res.status(400).json({
        message: "shift must be morning or afternoon",
      });
    }

    const shift = requestedShift || (checkIn ? inferShift(checkIn) : "morning");

    let status = normalizeStatus(body.status);

    if (
      body.status !== undefined &&
      body.status !== "" &&
      !status
    ) {
      return res.status(400).json({
        message: `status must be one of: ${ATTENDANCE_STATUSES.join(", ")}`,
      });
    }

    if (!status) {
      status = checkIn ? (isLate(checkIn, shift) ? "Late" : "Present") : "Absent";
    }

    const now = new Date();
    const document = {
      teacherId,
      date,
      shift,
      checkIn,
      checkOut,
      status,
      notes: typeof body.notes === "string" ? body.notes : "",
      createdAt: now,
      updatedAt: now,
    };

    const result = await attendance(req).insertOne(document);
    const record = { ...document, _id: result.insertedId };

    return res.status(201).json({ attendance: record });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Attendance already exists for this teacher and date",
      });
    }

    return next(error);
  }
});

router.get("/:id", authenticate, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);

    if (!id) {
      return res.status(400).json({ message: "Invalid attendance id" });
    }

    const record = await attendance(req).findOne({ _id: id });

    if (!record) {
      return res.status(404).json({ message: "Attendance record not found" });
    }

    if (
      req.user.role !== "admin" &&
      record.teacherId.toString() !== req.user.id
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return res.json({ attendance: record });
  } catch (error) {
    return next(error);
  }
});

router.patch(
  "/:id",
  authenticate,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const id = parseObjectId(req.params.id);

      if (!id) {
        return res.status(400).json({ message: "Invalid attendance id" });
      }

      const body = req.body || {};
      const collection = attendance(req);
      const existing = await collection.findOne({ _id: id });

      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found" });
      }

      const updates = {};

      if (body.date !== undefined) {
        const date = parseDateKey(body.date);

        if (!date) {
          return res.status(400).json({ message: "date must be YYYY-MM-DD" });
        }

        updates.date = date;
      }

      if (body.checkIn !== undefined) {
        const checkIn = parseDateTime(body.checkIn);

        if (checkIn === undefined) {
          return res.status(400).json({ message: "Invalid checkIn date" });
        }

        updates.checkIn = checkIn;
      }

      if (body.checkOut !== undefined) {
        const checkOut = parseDateTime(body.checkOut);

        if (checkOut === undefined) {
          return res.status(400).json({ message: "Invalid checkOut date" });
        }

        updates.checkOut = checkOut;
      }

      if (
        body.shift !== undefined &&
        body.shift !== null &&
        body.shift !== ""
      ) {
        const shift = normalizeShift(body.shift);

        if (!shift) {
          return res.status(400).json({
            message: "shift must be morning or afternoon",
          });
        }

        updates.shift = shift;
      }

      if (body.status !== undefined) {
        const status = normalizeStatus(body.status);

        if (!status) {
          return res.status(400).json({
            message: `status must be one of: ${ATTENDANCE_STATUSES.join(", ")}`,
          });
        }

        updates.status = status;
      }

      if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== "string") {
          return res.status(400).json({ message: "notes must be a string" });
        }

        updates.notes = body.notes || "";
      }

      if (
        updates.status === undefined &&
        (updates.checkIn !== undefined || updates.shift !== undefined)
      ) {
        const checkIn =
          updates.checkIn !== undefined ? updates.checkIn : existing.checkIn;
        const shift =
          updates.shift !== undefined
            ? updates.shift
            : existing.shift || (checkIn ? inferShift(checkIn) : "morning");

        updates.status = checkIn
          ? isLate(checkIn, shift)
            ? "Late"
            : "Present"
          : "Absent";
      }

      if (!Object.keys(updates).length) {
        return res
          .status(400)
          .json({ message: "No valid fields to update" });
      }

      updates.updatedAt = new Date();

      const record = await collection.findOneAndUpdate(
        { _id: id },
        { $set: updates },
        { returnDocument: "after" }
      );

      if (!record) {
        return res.status(404).json({ message: "Attendance record not found" });
      }

      return res.json({ attendance: record });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({
          message: "Attendance already exists for this teacher and date",
        });
      }

      return next(error);
    }
  }
);

router.delete(
  "/:id",
  authenticate,
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const id = parseObjectId(req.params.id);

      if (!id) {
        return res.status(400).json({ message: "Invalid attendance id" });
      }

      const result = await attendance(req).deleteOne({ _id: id });

      if (!result.deletedCount) {
        return res.status(404).json({ message: "Attendance record not found" });
      }

      return res.json({ message: "Attendance record deleted" });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
