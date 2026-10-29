const PDFDocument = require("pdfkit");
const {
  ATTENDANCE_STATUSES,
  ATTENDED_STATUSES,
  TEACHER_ROLES,
  currentMonthRange,
  normalizeStatus: normalizeAttendanceStatus,
  parseDateKey,
  resolveStatsRange,
  todayDateKey,
} = require("../utils/attendance");
const {
  exactInsensitive,
  getScopeFilter,
  getScopedStaff,
  idsForRecords,
  ownsDepartment,
  parseObjectId,
} = require("../utils/adminScope");

const ADMIN_ROLES = ["teacher_in_charge", "deputy_head", "head"];
const USER_ROLES = ["teacher", ...ADMIN_ROLES];
const HEAD_COUNT_FILTER = { role: "head", active: { $ne: false } };

function collection(req, name) {
  return req.app.locals.db.collection(name);
}

function displayName(user) {
  return (
    [user.firstName, user.surname].filter(Boolean).join(" ") ||
    user.name ||
    user.ecNumber ||
    "Teacher"
  );
}

function normalizeState(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parsePeriod(fromValue, toValue) {
  const defaultRange = currentMonthRange();
  const from = fromValue ? parseDateKey(fromValue) : defaultRange.from;
  const to = toValue ? parseDateKey(toValue) : defaultRange.to;
  if (!from || !to) return { error: "from and to must be valid YYYY-MM-DD dates" };
  if (from > to) return { error: "from must be on or before to" };
  const range = resolveStatsRange({ from, to });
  return range.error ? { error: range.error } : { from, to };
}

function currentTermRange() {
  const today = todayDateKey();
  const year = today.slice(0, 4);
  const month = Number(today.slice(5, 7));
  if (month <= 4) return { from: `${year}-01-01`, to: `${year}-04-30` };
  if (month <= 8) return { from: `${year}-05-01`, to: `${year}-08-31` };
  return { from: `${year}-09-01`, to: `${year}-12-31` };
}

function mergeScope(scope, filter = {}) {
  return Object.keys(scope).length
    ? { $and: [scope, filter] }
    : filter;
}

function validateDepartment(req, value) {
  if (value === undefined || value === "") return { department: null };
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    return { error: "department must be a non-empty string of at most 120 characters" };
  }
  const department = value.trim();
  if (
    req.user.role === "teacher_in_charge" &&
    department.toLowerCase() !== String(req.user.department || "").trim().toLowerCase()
  ) {
    return { error: "You cannot access another department", status: 403 };
  }
  return { department };
}

async function getScopedRecords(req, name, ids, session) {
  const scope = getScopeFilter(req.user);
  const records = await collection(req, name)
    .find({ _id: { $in: ids } }, { session })
    .toArray();
  if (records.length !== ids.length) {
    return { error: "One or more records were not found", status: 404 };
  }
  for (const record of records) {
    if (!(await ownsDepartment(req.app.locals.db, req.user, record))) {
      return { error: "You cannot access records outside your department", status: 403 };
    }
    if (Object.keys(scope).length && record.department === undefined && !record.teacherId) {
      return { error: "You cannot access records outside your department", status: 403 };
    }
  }
  return { records };
}

async function logAction(req, action, target, details = {}, session) {
  const permittedDetails = {};
  for (const key of ["status", "previousStatus", "role", "previousRole", "department", "previousDepartment", "active"]) {
    if (Object.prototype.hasOwnProperty.call(details, key)) {
      permittedDetails[key] = details[key];
    }
  }
  await collection(req, "audit_log").insertOne(
    {
      action,
      actorId: parseObjectId(String(req.user.id || "")),
      actorName: String(req.user.name || "").slice(0, 120),
      targetId: target ? String(target) : null,
      details: permittedDetails,
      createdAt: new Date(),
    },
    session ? { session } : undefined
  );
}

async function overview(req, res, next) {
  try {
    const db = req.app.locals.db;
    const scope = getScopeFilter(req.user);
    if (req.user.role === "teacher_in_charge" && !req.user.department) {
      return res.status(403).json({ message: "Your account has no department assigned" });
    }
    const staff = await getScopedStaff(db, req.user, { active: { $ne: false } });
    const teacherIds = idsForRecords(staff);
    const today = todayDateKey();
    const [todayRows, pendingKras, pendingSchemes, upcoming, attendanceUpdates, kraUpdates, schemeUpdates] =
      await Promise.all([
        collection(req, "attendance")
          .aggregate([
            { $match: { teacherId: { $in: teacherIds }, date: today } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ])
          .toArray(),
        collection(req, "kras").countDocuments(
          mergeScope(scope, { teacherId: { $in: teacherIds }, status: "pending" })
        ),
        collection(req, "schemebooks").countDocuments(
          mergeScope(scope, { teacherId: { $in: teacherIds }, status: "Pending" })
        ),
        collection(req, "calendar")
          .find({
            ...scope,
            type: { $in: ["Event", "Activity", "Meeting", "Deadline"] },
            endDate: { $gte: today },
            isCommunication: { $ne: true },
          })
          .sort({ startDate: 1 })
          .limit(10)
          .toArray(),
        collection(req, "attendance")
          .find({ teacherId: { $in: teacherIds } })
          .sort({ updatedAt: -1 })
          .limit(10)
          .toArray(),
        collection(req, "kras")
          .find(mergeScope(scope, { teacherId: { $in: teacherIds } }))
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(10)
          .toArray(),
        collection(req, "schemebooks")
          .find(mergeScope(scope, { teacherId: { $in: teacherIds } }))
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(10)
          .toArray(),
      ]);
    const attendanceByStatus = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
    for (const row of todayRows) {
      if (Object.prototype.hasOwnProperty.call(attendanceByStatus, row._id)) {
        attendanceByStatus[row._id] = row.count;
      }
    }
    const usersById = new Map(staff.map((person) => [String(person._id), displayName(person)]));
    const absentList = await collection(req, "attendance")
      .find({ teacherId: { $in: teacherIds }, date: today, status: "Absent" })
      .toArray();
    const recentUpdates = [
      ...attendanceUpdates.map((item) => ({
        type: "attendance",
        id: String(item._id),
        teacherId: String(item.teacherId),
        teacherName: usersById.get(String(item.teacherId)) || item.teacherName || null,
        status: item.status,
        updatedAt: item.updatedAt || item.createdAt,
      })),
      ...kraUpdates.map((item) => ({
        type: "kra",
        id: String(item._id),
        teacherId: String(item.teacherId),
        status: item.status,
        updatedAt: item.updatedAt || item.createdAt,
      })),
      ...schemeUpdates.map((item) => ({
        type: "schemebook",
        id: String(item._id),
        teacherId: String(item.teacherId),
        status: item.status,
        updatedAt: item.updatedAt || item.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 10);
    return res.json({
      staffCount: staff.length,
      today: { date: today, counts: attendanceByStatus },
      absent: absentList.map((item) => ({
        id: String(item._id),
        teacherId: String(item.teacherId),
        name: usersById.get(String(item.teacherId)) || null,
      })),
      pendingKraCount: pendingKras,
      pendingSchemeBookCount: pendingSchemes,
      upcoming: upcoming.map((item) => ({ ...item, id: String(item._id), _id: undefined })),
      recentUpdates,
    });
  } catch (error) {
    return next(error);
  }
}

async function staffList(req, res, next) {
  try {
    const scope = getScopeFilter(req.user);
    if (req.user.role === "teacher_in_charge" && !req.user.department) {
      return res.status(403).json({ message: "Your account has no department assigned" });
    }
    const extra = {};
    if (req.query.search !== undefined && req.query.search !== "") {
      if (typeof req.query.search !== "string" || req.query.search.trim().length > 120) {
        return res.status(400).json({ message: "search must be at most 120 characters" });
      }
      const regex = new RegExp(
        req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      extra.$or = [{ firstName: regex }, { surname: regex }, { name: regex }, { ecNumber: regex }];
    }
    if (req.query.department !== undefined && req.query.department !== "") {
      const parsed = validateDepartment(req, req.query.department);
      if (parsed.error) return res.status(parsed.status || 400).json({ message: parsed.error });
      extra.department = exactInsensitive(parsed.department);
    }
    if (req.query.active !== undefined && req.query.active !== "") {
      if (!["true", "false"].includes(req.query.active)) {
        return res.status(400).json({ message: "active must be true or false" });
      }
      extra.active = req.query.active === "true" ? { $ne: false } : false;
    } else {
      extra.active = { $ne: false };
    }
    const allowedSort = ["name", "department", "role", "createdAt", "attendanceRate"];
    const sortField = req.query.sort || "name";
    const normalizedSort = sortField.startsWith("-") ? sortField.slice(1) : sortField;
    if (!allowedSort.includes(normalizedSort)) {
      return res.status(400).json({ message: "sort must be name, department, role, createdAt or attendanceRate, optionally prefixed with -" });
    }
    const sort = normalizedSort === "attendanceRate"
      ? { name: 1 }
      : { [normalizedSort]: sortField.startsWith("-") ? -1 : 1 };
    const people = await collection(req, "users")
      .find({ ...scope, ...extra, role: { $in: TEACHER_ROLES } })
      .sort(sort)
      .limit(1000)
      .toArray();
    const ids = idsForRecords(people);
    const term = currentTermRange();
    const [attendance, kras, schemes] = await Promise.all([
      collection(req, "attendance")
        .find({ teacherId: { $in: ids }, date: { $gte: term.from, $lte: term.to } })
        .toArray(),
      collection(req, "kras").find(mergeScope(scope, { teacherId: { $in: ids } })).toArray(),
      collection(req, "schemebooks").find(mergeScope(scope, { teacherId: { $in: ids } })).toArray(),
    ]);
    const mapByTeacher = (rows) => {
      const result = new Map();
      for (const row of rows) {
        const key = String(row.teacherId);
        result.set(key, [...(result.get(key) || []), row]);
      }
      return result;
    };
    const attendanceMap = mapByTeacher(attendance);
    const kraMap = mapByTeacher(kras);
    const schemeMap = mapByTeacher(schemes);
    const staff = people.map((person) => {
      const personAttendance = attendanceMap.get(String(person._id)) || [];
      const applicable = personAttendance.filter(
        (row) => !["holiday", "sick leave", "leave"].includes(normalizeState(row.status))
      );
      const attended = applicable.filter((row) =>
        ATTENDED_STATUSES.some((status) => normalizeState(status) === normalizeState(row.status))
      ).length;
      const personKras = kraMap.get(String(person._id)) || [];
      const personSchemes = schemeMap.get(String(person._id)) || [];
      return {
        id: String(person._id),
        name: displayName(person),
        ecNumber: person.ecNumber || null,
        role: person.role || "teacher",
        department: person.department || null,
        active: person.active !== false,
        attendanceRate: applicable.length ? Math.round((attended / applicable.length) * 10000) / 100 : null,
        attendance: { attended, applicable: applicable.length },
        kras: {
          approved: personKras.filter((row) => normalizeState(row.status) === "approved").length,
          total: personKras.length,
        },
        schemeBooks: {
          approved: personSchemes.filter((row) => normalizeState(row.status) === "approved").length,
          total: personSchemes.length,
        },
      };
    });
    if (normalizedSort === "attendanceRate") {
      staff.sort((a, b) => {
        const diff = (a.attendanceRate ?? -1) - (b.attendanceRate ?? -1);
        return sortField.startsWith("-") ? -diff : diff;
      });
    }
    return res.json({ staff, total: staff.length, term });
  } catch (error) {
    return next(error);
  }
}

async function staffProfile(req, res, next) {
  try {
    if (req.user.role === "teacher_in_charge" && !req.user.department) {
      return res.status(403).json({ message: "Your account has no department assigned" });
    }
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid staff id" });
    const scope = getScopeFilter(req.user);
    const person = await collection(req, "users").findOne({
      _id: id,
      ...scope,
      role: { $in: TEACHER_ROLES },
    });
    if (!person) return res.status(404).json({ message: "Staff member not found" });
    const ids = idsForRecords([person]);
    const [attendance, kras, schemes] = await Promise.all([
      collection(req, "attendance").find({ teacherId: { $in: ids } }).sort({ date: -1 }).limit(1000).toArray(),
      collection(req, "kras").find(mergeScope(scope, { teacherId: { $in: ids } })).sort({ updatedAt: -1 }).toArray(),
      collection(req, "schemebooks").find(mergeScope(scope, { teacherId: { $in: ids } })).sort({ updatedAt: -1 }).toArray(),
    ]);
    const counts = {};
    for (const item of attendance) counts[item.status] = (counts[item.status] || 0) + 1;
    return res.json({
      staff: {
        id: String(person._id),
        name: displayName(person),
        ecNumber: person.ecNumber || null,
        department: person.department || null,
        role: person.role,
        active: person.active !== false,
        createdAt: person.createdAt || null,
      },
      attendance: { counts, records: attendance },
      kras,
      schemeBooks: schemes,
    });
  } catch (error) {
    return next(error);
  }
}

async function attendanceDay(req, res, next) {
  try {
    const date = req.query.date ? parseDateKey(req.query.date) : todayDateKey();
    if (!date) return res.status(400).json({ message: "date must be a valid YYYY-MM-DD date" });
    const parsedDepartment = validateDepartment(req, req.query.department);
    if (parsedDepartment.error) {
      return res.status(parsedDepartment.status || 400).json({ message: parsedDepartment.error });
    }
    const people = await getScopedStaff(req.app.locals.db, req.user, {
      active: { $ne: false },
      ...(parsedDepartment.department
        ? { department: exactInsensitive(parsedDepartment.department) }
        : {}),
    });
    const ids = idsForRecords(people);
    const records = await collection(req, "attendance")
      .find({ teacherId: { $in: ids }, date })
      .toArray();
    const recordMap = new Map(records.map((record) => [String(record.teacherId), record]));
    return res.json({
      date,
      attendance: people.map((person) => {
        const record = recordMap.get(String(person._id));
        return {
          teacherId: String(person._id),
          name: displayName(person),
          department: person.department || null,
          status: record?.status || "Not recorded",
          attendanceId: record ? String(record._id) : null,
          checkIn: record?.checkIn || null,
          checkOut: record?.checkOut || null,
        };
      }),
    });
  } catch (error) {
    return next(error);
  }
}

async function correctAttendance(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid attendance id" });
    const status = normalizeAttendanceStatus(req.body?.status);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!status || !ATTENDANCE_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${ATTENDANCE_STATUSES.join(", ")}` });
    }
    if (!reason || reason.length > 1000) {
      return res.status(400).json({ message: "reason is required and must be at most 1,000 characters" });
    }
    const record = await collection(req, "attendance").findOne({ _id: id });
    if (!record) return res.status(404).json({ message: "Attendance record not found" });
    if (!(await ownsDepartment(req.app.locals.db, req.user, record))) {
      return res.status(403).json({ message: "You cannot edit attendance outside your department" });
    }
    const previousStatus = record.status;
    const updated = await collection(req, "attendance").findOneAndUpdate(
      { _id: id, status: previousStatus },
      {
        $set: {
          status,
          correctionReason: reason,
          editedBy: { id: req.user.id, name: String(req.user.name || "").slice(0, 120) },
          editedAt: new Date(),
          previousStatus,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(409).json({ message: "Attendance record changed; reload and try again" });
    await logAction(req, "attendance.corrected", id, { status, previousStatus });
    return res.json({ attendance: updated });
  } catch (error) {
    return next(error);
  }
}

async function bulkReview(req, res, next, name) {
  const db = req.app.locals.db;
  const body = req.body || {};
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100) {
    return res.status(400).json({ message: "ids must contain between 1 and 100 record ids" });
  }
  const ids = body.ids.map(parseObjectId);
  if (ids.some((id) => !id) || new Set(ids.map(String)).size !== ids.length) {
    return res.status(400).json({ message: "ids must be unique valid ObjectIds" });
  }
  const statusText = typeof body.status === "string" ? body.status.trim() : "";
  const status = name === "kras"
    ? ({ approved: "approved", rejected: "rejected" })[normalizeState(statusText)]
    : ({ approved: "Approved", rejected: "Rejected" })[normalizeState(statusText)];
  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!status) return res.status(400).json({ message: "status must be Approved or Rejected" });
  if (body.comment !== undefined && typeof body.comment !== "string") {
    return res.status(400).json({ message: "comment must be a string" });
  }
  if (comment.length > 2000 || (normalizeState(status) === "rejected" && !comment)) {
    return res.status(400).json({ message: "A comment of at most 2,000 characters is required when rejecting" });
  }
  const session = req.app.locals.mongoClient?.startSession();
  if (!session) return res.status(500).json({ message: "Database transaction support is unavailable" });
  try {
    let response;
    await session.withTransaction(async () => {
      const scoped = await getScopedRecords(req, name, ids, session);
      if (scoped.error) {
        const error = new Error(scoped.error);
        error.status = scoped.status;
        throw error;
      }
      const pending = name === "kras" ? "pending" : "Pending";
      if (scoped.records.some((record) => normalizeState(record.status) !== normalizeState(pending))) {
        const error = new Error("All records must still be pending");
        error.status = 409;
        throw error;
      }
      const now = new Date();
      const update = {
        status,
        reviewerComment: comment || null,
        reviewedBy: String(req.user.name || req.user.id).slice(0, 120),
        reviewedAt: now,
        updatedAt: now,
      };
      const result = await collection(req, name).updateMany(
        { _id: { $in: ids }, status: pending },
        { $set: update },
        { session }
      );
      if (result.modifiedCount !== ids.length) {
        const error = new Error("One or more records changed during review");
        error.status = 409;
        throw error;
      }
      for (const id of ids) await logAction(req, `${name}.reviewed`, id, { status }, session);
      response = { updatedCount: result.modifiedCount, status };
    });
    return res.json(response);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  } finally {
    await session.endSession();
  }
}

async function updateUser(req, res, next, field) {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid user id" });
    const users = collection(req, "users");
    const target = await users.findOne({ _id: id });
    if (!target) return res.status(404).json({ message: "User not found" });
    const self = String(id) === String(req.user.id);
    let value;
    if (field === "role") {
      value = req.body?.role;
      if (!USER_ROLES.includes(value)) return res.status(400).json({ message: "Invalid role" });
      if (self && value !== "head") return res.status(403).json({ message: "You cannot demote yourself" });
    } else if (field === "department") {
      value = req.body?.department;
      if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
        return res.status(400).json({ message: "department is required and must be at most 120 characters" });
      }
      value = value.trim();
    } else {
      value = req.body?.active;
      if (typeof value !== "boolean") return res.status(400).json({ message: "active must be true or false" });
      if (self && !value) return res.status(403).json({ message: "You cannot deactivate yourself" });
    }
    if (field !== "role" && field !== "department" && field !== "active") {
      return res.status(400).json({ message: "Invalid user field" });
    }
    const session = req.app.locals.mongoClient?.startSession();
    if (!session) return res.status(500).json({ message: "Database transaction support is unavailable" });
    let updatedUser;
    try {
      await session.withTransaction(async () => {
        if (
          ((field === "role" && target.role === "head" && value !== "head") ||
            (field === "active" && target.role === "head" && value === false)) &&
          target.active !== false
        ) {
          const activeHeads = await users.countDocuments(HEAD_COUNT_FILTER, { session });
          if (activeHeads <= 1) {
            const error = new Error("At least one active head must remain");
            error.status = 409;
            throw error;
          }
        }
        const previousValue = target[field] ?? (field === "active" ? true : null);
        const result = await users.findOneAndUpdate(
          { _id: id },
          { $set: { [field]: value, updatedAt: new Date() } },
          { returnDocument: "after", session }
        );
        if (!result) {
          const error = new Error("User record changed; reload and try again");
          error.status = 409;
          throw error;
        }
        const details = field === "role"
          ? { role: value, previousRole: previousValue }
          : field === "department"
            ? { department: value, previousDepartment: previousValue }
            : { active: value };
        await logAction(req, `user.${field}Changed`, id, details, session);
        updatedUser = result;
      });
    } finally {
      await session.endSession();
    }
    return res.json({
      user: {
        id: String(updatedUser._id),
        name: displayName(updatedUser),
        role: updatedUser.role,
        department: updatedUser.department || null,
        active: updatedUser.active !== false,
      },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  }
}

async function audit(req, res, next) {
  try {
    const period = parsePeriod(req.query.from, req.query.to);
    if (period.error) return res.status(400).json({ message: period.error });
    const filter = {
      createdAt: {
        $gte: new Date(`${period.from}T00:00:00.000Z`),
        $lte: new Date(`${period.to}T23:59:59.999Z`),
      },
    };
    if (req.query.action !== undefined && req.query.action !== "") {
      if (typeof req.query.action !== "string" || req.query.action.length > 120) {
        return res.status(400).json({ message: "action is invalid" });
      }
      filter.action = req.query.action;
    }
    if (req.query.actorId !== undefined && req.query.actorId !== "") {
      const actorId = parseObjectId(req.query.actorId);
      if (!actorId) return res.status(400).json({ message: "Invalid actorId" });
      filter.actorId = actorId;
    }
    const entries = await collection(req, "audit_log")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    return res.json({ audit: entries });
  } catch (error) {
    return next(error);
  }
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function sendCsv(res, filename, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const body = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((key) => csvEscape(row[key])).join(",")),
  ].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
  return res.send(body);
}

function sendPdf(res, filename, title, rows) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
  const document = new PDFDocument({ margin: 40, size: "A4" });
  document.on("error", (error) => res.destroy(error));
  document.pipe(res);
  document.fontSize(18).text(title, { continued: false });
  document.moveDown(0.5).fontSize(9).text(`Generated: ${new Date().toISOString()}`);
  document.moveDown();
  if (!rows.length) {
    document.fontSize(11).text("No records found for this report.");
  }
  for (const [index, row] of rows.entries()) {
    const line = Object.entries(row)
      .map(([key, value]) => `${key}: ${value === null || value === undefined ? "" : value}`)
      .join("  |  ");
    document.fontSize(8).text(line, { width: 510 });
    document.moveDown(0.35);
    if (document.y > 740 && index < rows.length - 1) document.addPage();
  }
  document.end();
}

async function report(req, res, next) {
  try {
    const supported = ["attendance-monthly", "kra-status", "schemebook-submission", "staff-summary"];
    if (!supported.includes(req.params.type)) {
      return res.status(400).json({ message: `type must be one of: ${supported.join(", ")}` });
    }
    const format = req.query.format || "json";
    if (!["json", "csv", "pdf"].includes(format)) {
      return res.status(400).json({ message: "format must be json, csv or pdf" });
    }
    const period = parsePeriod(req.query.from, req.query.to);
    if (period.error) return res.status(400).json({ message: period.error });
    const parsedDepartment = validateDepartment(req, req.query.department);
    if (parsedDepartment.error) {
      return res.status(parsedDepartment.status || 400).json({ message: parsedDepartment.error });
    }
    const scope = getScopeFilter(req.user);
    const staffFilter = parsedDepartment.department
      ? { department: exactInsensitive(parsedDepartment.department) }
      : {};
    const people = await getScopedStaff(req.app.locals.db, req.user, staffFilter);
    const ids = idsForRecords(people);
    const names = new Map(people.map((person) => [
      String(person._id),
      { name: displayName(person), department: person.department || null },
    ]));
    const teacherFilter = { teacherId: { $in: ids } };
    const rangeFilter = (dateField) => ({
      [dateField]: dateField === "date"
        ? { $gte: period.from, $lte: period.to }
        : {
            $gte: new Date(`${period.from}T00:00:00.000Z`),
            $lte: new Date(`${period.to}T23:59:59.999Z`),
          },
    });
    let rows = [];

    if (req.params.type === "attendance-monthly") {
      const records = await collection(req, "attendance")
        .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("date") }))
        .sort({ date: 1 })
        .limit(50000)
        .toArray();
      const groups = new Map();
      for (const record of records) {
        const owner = names.get(String(record.teacherId));
        if (!owner) continue;
        const month = String(record.date).slice(0, 7);
        const key = `${month}:${record.teacherId}:${record.status}`;
        const row = groups.get(key) || {
          month,
          teacherId: String(record.teacherId),
          name: owner.name,
          department: owner.department,
          status: record.status,
          count: 0,
        };
        row.count += 1;
        groups.set(key, row);
      }
      rows = [...groups.values()];
    } else if (req.params.type === "kra-status") {
      const records = await collection(req, "kras")
        .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("createdAt") }))
        .limit(50000)
        .toArray();
      rows = records.map((record) => ({
        id: String(record._id),
        teacherId: String(record.teacherId),
        name: names.get(String(record.teacherId))?.name || record.teacherName || null,
        department: names.get(String(record.teacherId))?.department || null,
        title: record.title || null,
        status: record.status,
        submittedAt: record.createdAt || null,
        reviewedAt: record.reviewedAt || null,
      }));
    } else if (req.params.type === "schemebook-submission") {
      const records = await collection(req, "schemebooks")
        .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("createdAt") }))
        .limit(50000)
        .toArray();
      rows = records.map((record) => ({
        id: String(record._id),
        teacherId: String(record.teacherId),
        name: names.get(String(record.teacherId))?.name || record.teacherName || null,
        department: names.get(String(record.teacherId))?.department || null,
        subject: record.subject || null,
        grade: record.grade || null,
        term: record.term || null,
        status: record.status,
        submittedAt: record.createdAt || null,
        reviewedAt: record.reviewedAt || null,
      }));
    } else {
      const [attendance, kras, schemes] = await Promise.all([
        collection(req, "attendance")
          .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("date") }))
          .limit(50000)
          .toArray(),
        collection(req, "kras")
          .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("createdAt") }))
          .limit(50000)
          .toArray(),
        collection(req, "schemebooks")
          .find(mergeScope(scope, { ...teacherFilter, ...rangeFilter("createdAt") }))
          .limit(50000)
          .toArray(),
      ]);
      rows = people.map((person) => {
        const teacherAttendance = attendance.filter((record) => String(record.teacherId) === String(person._id));
        const teacherKras = kras.filter((record) => String(record.teacherId) === String(person._id));
        const teacherSchemes = schemes.filter((record) => String(record.teacherId) === String(person._id));
        return {
          teacherId: String(person._id),
          name: displayName(person),
          department: person.department || null,
          attendanceDays: teacherAttendance.length,
          presentDays: teacherAttendance.filter((record) =>
            ATTENDED_STATUSES.some((status) => normalizeState(status) === normalizeState(record.status))
          ).length,
          krasTotal: teacherKras.length,
          krasApproved: teacherKras.filter((record) => normalizeState(record.status) === "approved").length,
          schemeBooksTotal: teacherSchemes.length,
          schemeBooksApproved: teacherSchemes.filter((record) => normalizeState(record.status) === "approved").length,
        };
      });
    }
    const filename = `chamabondo-${req.params.type}-${period.from}-${period.to}`;
    if (format === "csv") return sendCsv(res, filename, rows);
    if (format === "pdf") return sendPdf(res, filename, `Chamabondo ${req.params.type} report`, rows);
    return res.json({ type: req.params.type, from: period.from, to: period.to, rows });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  ADMIN_ROLES,
  audit,
  attendanceDay,
  bulkReview,
  correctAttendance,
  currentTermRange,
  getScopeFilter,
  logAction,
  overview,
  report,
  staffList,
  staffProfile,
  updateUser,
};
