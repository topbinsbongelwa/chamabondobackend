const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

/*
  Attendance document shape (collection: "attendance")
  {
    _id: ObjectId,
    teacherId: ObjectId,        // users._id
    date: "YYYY-MM-DD",         // calendar day used by the unique index
    shift: "morning" | "afternoon",
    checkIn: Date | null,
    checkOut: Date | null,
    status: "present" | "late" | "absent" | "half-day" | "leave",
    notes: String,
    createdAt: Date,
    updatedAt: Date
  }

  Morning shift is late after 08:00; afternoon shift is late after 13:00.

  Unique index: { teacherId: 1, date: 1 }
*/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const STATUSES = [
  "present",
  "late",
  "absent",
  "half-day",
  "leave",
  "sick-leave",
  "holiday",
  "official-duty",
];
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

function attendance(req) {
  return req.app.locals.db.collection("attendance");
}

function users(req) {
  return req.app.locals.db.collection("users");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
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

function parseDateKey(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10) === value ? value : null;
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
    const status = isLate(now, shift) ? "late" : "present";

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
    const status =
      typeof body.status === "string"
        ? body.status.trim().toLowerCase().replace(/_/g, "-")
        : "";

    if (!STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
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

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const from = `${year}-${pad(month + 1)}-01`;
    const nextMonth = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
    const to = `${nextMonth.year}-${pad(nextMonth.month + 1)}-01`;

    const records = await attendance(req)
      .find({ teacherId, date: { $gte: from, $lt: to } })
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
        case "present":
        case "holiday":
        case "official-duty":
          summary.present += 1;
          break;
        case "late":
          summary.late += 1;
          break;
        case "sick-leave":
          summary.sickLeave += 1;
          break;
        case "leave":
        case "half-day":
          summary.leave += 1;
          break;
        case "absent":
          summary.absent += 1;
          break;
        default:
          break;
      }
    }

    return res.json({ month: `${year}-${pad(month + 1)}`, summary });
  } catch (error) {
    return next(error);
  }
});

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
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      filter.status = req.query.status;
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

    let status = body.status;

    if (status !== undefined && status !== "") {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
    } else {
      status = checkIn ? (isLate(checkIn, shift) ? "late" : "present") : "absent";
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
        if (!STATUSES.includes(body.status)) {
          return res.status(400).json({ message: "Invalid status" });
        }

        updates.status = body.status;
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
            ? "late"
            : "present"
          : "absent";
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
