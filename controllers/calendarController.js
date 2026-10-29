const { ObjectId } = require("mongodb");
const { parseDateKey, todayDateKey } = require("../utils/attendance");
const {
  CALENDAR_CATEGORIES,
  CALENDAR_TYPES,
  currentMonthRange,
  getHolidayDates,
  isValidTime,
  normalizeCalendarAudience,
  normalizeCalendarCategory,
  normalizeCalendarPriority,
  normalizeCalendarType,
} = require("../utils/calendar");

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const LEADERSHIP_ROLES = new Set(["head", "deputy_head"]);
const CREATE_ROLES = new Set(["teacher_in_charge", "deputy_head", "head"]);
const TIC_MANAGEABLE_TYPES = new Set(["Event", "Activity", "Update"]);

function calendar(req) {
  return req.app.locals.db.collection("calendar");
}

function parseObjectId(value) {
  if (
    typeof value !== "string" ||
    !OBJECT_ID_PATTERN.test(value.trim())
  ) {
    return null;
  }

  return new ObjectId(value.trim());
}

function displayName(user) {
  if (!user) {
    return "Teacher";
  }

  return (
    [user.firstName, user.surname].filter(Boolean).join(" ") ||
    user.name ||
    user.ecNumber ||
    "Teacher"
  );
}

function normalizeDepartment(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactInsensitive(value) {
  return { $regex: `^${escapeRegex(value)}$`, $options: "i" };
}

async function getActor(req) {
  const rawId = req.user?.id;
  const id = typeof rawId === "string" ? rawId : rawId ? String(rawId) : "";
  const objectId = parseObjectId(id);
  let role = String(req.user?.role || "").trim().toLowerCase();
  let name = typeof req.user?.name === "string" ? req.user.name.trim() : "";
  let department =
    typeof req.user?.department === "string" ? req.user.department.trim() : "";

  if (objectId && (!name || !department)) {
    const user = await req.app.locals.db.collection("users").findOne(
      { _id: objectId },
      {
        projection: {
          firstName: 1,
          surname: 1,
          name: 1,
          ecNumber: 1,
          department: 1,
          role: 1,
        },
      }
    );

    if (user) {
      if (!name) {
        name = displayName(user);
      }
      if (!department && typeof user.department === "string") {
        department = user.department.trim();
      }
      if (!role && user.role) {
        role = String(user.role).trim().toLowerCase();
      }
    }
  }

  return {
    id,
    objectId,
    role,
    name: name || "Unknown",
    department: department || null,
  };
}

function visibilityFilter(actor) {
  const clauses = [{ audience: "all" }];

  if (actor.department) {
    clauses.push({
      audience: "department",
      department: exactInsensitive(actor.department),
    });
  }

  if (actor.id) {
    clauses.push({ "assignedTeachers.teacherId": actor.id });
    clauses.push({ "createdBy.id": actor.id });

    if (actor.objectId) {
      clauses.push({ "assignedTeachers.teacherId": actor.objectId });
      clauses.push({ "createdBy.id": actor.objectId });
    }
  }

  return {
    $and: [
      { $or: clauses },
      {
        $or: [
          { isCommunication: { $ne: true } },
          { published: true },
        ],
      },
    ],
  };
}

function isVisible(item, actor) {
  if (item.isCommunication === true && item.published !== true) {
    return false;
  }

  if (item.audience === "all") {
    return true;
  }

  if (
    item.audience === "department" &&
    actor.department &&
    normalizeDepartment(item.department) ===
      normalizeDepartment(actor.department)
  ) {
    return true;
  }

  if (
    item.createdBy?.id &&
    String(item.createdBy.id) === actor.id
  ) {
    return true;
  }

  return (
    Array.isArray(item.assignedTeachers) &&
    item.assignedTeachers.some(
      (teacher) =>
        teacher.teacherId &&
        String(teacher.teacherId) === actor.id
    )
  );
}

function resolveRange(query = {}) {
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

  return { from, to };
}

function overlapFilter(from, to) {
  return {
    startDate: { $lte: to },
    endDate: { $gte: from },
  };
}

function buildPagination(query = {}, defaultLimit = 20) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1),
    100
  );

  return { page, limit, skip: (page - 1) * limit };
}

function publicCalendar(item) {
  const { _id, ...rest } = item;
  delete rest.recipientIds;
  delete rest.readBy;
  delete rest.rsvps;

  return {
    ...rest,
    id: _id ? _id.toString() : rest.id,
    createdBy: rest.createdBy
      ? {
          ...rest.createdBy,
          id: rest.createdBy.id ? String(rest.createdBy.id) : null,
        }
      : null,
    assignedTeachers: Array.isArray(rest.assignedTeachers)
      ? rest.assignedTeachers.map((teacher) => ({
          ...teacher,
          teacherId: teacher.teacherId ? String(teacher.teacherId) : null,
        }))
      : [],
  };
}

async function normalizeAssignedTeachers(db, value) {
  if (value === undefined || value === null) {
    return { value: [] };
  }

  if (!Array.isArray(value)) {
    return { error: "assignedTeachers must be an array." };
  }

  if (value.length > 100) {
    return {
      error: "assignedTeachers cannot contain more than 100 teachers.",
    };
  }

  const seen = new Set();
  const teachers = [];

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      return {
        error: `assignedTeachers[${index}] must be an object.`,
      };
    }

    const teacherId = parseObjectId(entry.teacherId);

    if (!teacherId) {
      return {
        error: `assignedTeachers[${index}].teacherId must be a valid id.`,
      };
    }

    const key = teacherId.toString();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    let teacherName =
      typeof entry.teacherName === "string"
        ? entry.teacherName.trim()
        : "";

    if (teacherName.length > 120) {
      return {
        error: `assignedTeachers[${index}].teacherName must be at most 120 characters.`,
      };
    }

    if (!teacherName) {
      const user = await db.collection("users").findOne(
        { _id: teacherId },
        { projection: { firstName: 1, surname: 1, name: 1, ecNumber: 1 } }
      );

      teacherName = displayName(user);
    }

    teachers.push({ teacherId, teacherName });
  }

  return { value: teachers };
}

async function parseCalendarBody(req, { partial, existing = null, actor }) {
  const body = req.body || {};
  const db = req.app.locals.db;
  const values = {};
  const provided = new Set();
  const has = (field) =>
    Object.prototype.hasOwnProperty.call(body, field) &&
    body[field] !== undefined;

  if (!partial) {
    Object.assign(values, {
      description: "",
      startTime: null,
      endTime: null,
      allDay: false,
      venue: null,
      assignedTeachers: [],
      priority: "Normal",
      pinned: false,
      category: null,
      expiresAt: null,
      audience: "all",
      department: null,
    });
  }

  if (!partial || has("type")) {
    const type = normalizeCalendarType(body.type);

    if (!type) {
      return {
        error: `type must be one of: ${CALENDAR_TYPES.join(", ")}.`,
      };
    }

    values.type = type;
    provided.add("type");
  }

  if (!partial || has("title")) {
    const title =
      typeof body.title === "string" ? body.title.trim() : "";

    if (!title || title.length > 160) {
      return {
        error: "title is required and must be at most 160 characters.",
      };
    }

    values.title = title;
    provided.add("title");
  }

  if (!partial || has("description")) {
    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      return { error: "description must be a string." };
    }

    const description =
      typeof body.description === "string"
        ? body.description.trim()
        : "";

    if (description.length > 4000) {
      return {
        error: "description must be at most 4,000 characters.",
      };
    }

    values.description = description;
    provided.add("description");
  }

  if (!partial || has("startDate")) {
    const startDate = parseDateKey(body.startDate);

    if (!startDate) {
      return {
        error: "startDate must be a valid YYYY-MM-DD date.",
      };
    }

    values.startDate = startDate;
    provided.add("startDate");
  }

  if (!partial || has("endDate")) {
    const raw = body.endDate;

    if (raw === undefined || raw === null || raw === "") {
      values.endDate = undefined;
    } else {
      const endDate = parseDateKey(raw);

      if (!endDate) {
        return {
          error: "endDate must be a valid YYYY-MM-DD date.",
        };
      }

      values.endDate = endDate;
    }

    provided.add("endDate");
  }

  if (!partial || has("startTime")) {
    const raw = body.startTime;

    if (raw === undefined || raw === null || raw === "") {
      values.startTime = null;
    } else if (!isValidTime(raw)) {
      return {
        error: "startTime must be a valid HH:mm time.",
      };
    } else {
      values.startTime = raw.trim();
    }

    provided.add("startTime");
  }

  if (!partial || has("endTime")) {
    const raw = body.endTime;

    if (raw === undefined || raw === null || raw === "") {
      values.endTime = null;
    } else if (!isValidTime(raw)) {
      return {
        error: "endTime must be a valid HH:mm time.",
      };
    } else {
      values.endTime = raw.trim();
    }

    provided.add("endTime");
  }

  if (!partial || has("allDay")) {
    if (
      body.allDay !== undefined &&
      typeof body.allDay !== "boolean"
    ) {
      return { error: "allDay must be true or false." };
    }

    values.allDay = body.allDay === true;
    provided.add("allDay");
  }

  if (!partial || has("venue")) {
    if (
      body.venue !== undefined &&
      body.venue !== null &&
      typeof body.venue !== "string"
    ) {
      return { error: "venue must be a string." };
    }

    const venue =
      typeof body.venue === "string" ? body.venue.trim() : "";

    if (venue.length > 200) {
      return {
        error: "venue must be at most 200 characters.",
      };
    }

    values.venue = venue || null;
    provided.add("venue");
  }

  if (!partial || has("audience")) {
    const audience = normalizeCalendarAudience(
      body.audience === undefined ? "all" : body.audience
    );

    if (!audience) {
      return {
        error: "audience must be all or department.",
      };
    }

    values.audience = audience;
    provided.add("audience");
  }

  if (!partial || has("department")) {
    if (
      body.department !== undefined &&
      body.department !== null &&
      typeof body.department !== "string"
    ) {
      return { error: "department must be a string." };
    }

    const department =
      typeof body.department === "string"
        ? body.department.trim()
        : "";

    if (department.length > 120) {
      return {
        error: "department must be at most 120 characters.",
      };
    }

    values.department = department || null;
    provided.add("department");
  }

  if (!partial || has("assignedTeachers")) {
    const normalized = await normalizeAssignedTeachers(
      db,
      body.assignedTeachers
    );

    if (normalized.error) {
      return { error: normalized.error };
    }

    values.assignedTeachers = normalized.value;
    provided.add("assignedTeachers");
  }

  if (!partial || has("priority")) {
    const priority = normalizeCalendarPriority(
      body.priority === undefined ? "Normal" : body.priority
    );

    if (!priority) {
      return {
        error: "priority must be Normal or Important.",
      };
    }

    values.priority = priority;
    provided.add("priority");
  }

  if (!partial || has("pinned")) {
    const pinned = body.pinned === undefined ? false : body.pinned;

    if (typeof pinned !== "boolean") {
      return { error: "pinned must be true or false." };
    }

    values.pinned = pinned;
    provided.add("pinned");
  }

  if (!partial || has("category")) {
    if (
      body.category === undefined ||
      body.category === null ||
      body.category === ""
    ) {
      values.category = null;
    } else {
      const category = normalizeCalendarCategory(body.category);

      if (!category) {
        return {
          error: `category must be one of: ${CALENDAR_CATEGORIES.join(", ")}.`,
        };
      }

      values.category = category;
    }

    provided.add("category");
  }

  if (!partial || has("expiresAt")) {
    const raw = body.expiresAt;

    if (raw === undefined || raw === null || raw === "") {
      values.expiresAt = null;
    } else {
      const expiresAt = parseDateKey(raw);

      if (!expiresAt) {
        return {
          error: "expiresAt must be a valid YYYY-MM-DD date.",
        };
      }

      values.expiresAt = expiresAt;
    }

    provided.add("expiresAt");
  }

  const effectiveStart = values.startDate ?? existing?.startDate;

  if (!effectiveStart) {
    return { error: "startDate is required." };
  }

  const endDateCleared =
    has("endDate") && (body.endDate === null || body.endDate === "");

  let effectiveEnd;

  if (values.endDate !== undefined) {
    effectiveEnd = values.endDate;
  } else if (endDateCleared) {
    effectiveEnd = effectiveStart;
  } else if (existing?.endDate) {
    effectiveEnd = existing.endDate;
  } else {
    effectiveEnd = effectiveStart;
  }

  if (effectiveEnd < effectiveStart) {
    return { error: "endDate cannot be before startDate." };
  }

  if (!partial) {
    values.endDate = effectiveEnd;
  } else if (endDateCleared) {
    values.endDate = effectiveStart;
  }

  const effectiveStartTime =
    values.startTime !== undefined
      ? values.startTime
      : existing?.startTime ?? null;
  const effectiveEndTime =
    values.endTime !== undefined
      ? values.endTime
      : existing?.endTime ?? null;
  const effectiveAllDay =
    values.allDay !== undefined
      ? values.allDay
      : Boolean(existing?.allDay);

  if (
    !effectiveAllDay &&
    effectiveStart === effectiveEnd &&
    effectiveStartTime &&
    effectiveEndTime &&
    effectiveEndTime < effectiveStartTime
  ) {
    return {
      error: "endTime cannot be before startTime on the same day.",
    };
  }

  const effectiveAudience =
    values.audience ?? existing?.audience ?? "all";
  let effectiveDepartment =
    values.department !== undefined
      ? values.department
      : existing?.department ?? null;

  if (actor.role === "teacher_in_charge") {
    if (!actor.department) {
      return {
        status: 403,
        error: "Your account has no department assigned.",
      };
    }

    values.audience = "department";
    values.department = actor.department;
    effectiveDepartment = actor.department;
  } else if (effectiveAudience === "department") {
    if (!effectiveDepartment) {
      return {
        error: "department is required when audience is department.",
      };
    }
  } else {
    effectiveDepartment = null;

    if (
      !partial ||
      values.department !== undefined ||
      values.audience !== undefined
    ) {
      values.department = null;
    }
  }

  return { values, provided, effectiveAudience, effectiveDepartment };
}

function managementError(actor, item) {
  if (LEADERSHIP_ROLES.has(actor.role)) {
    return null;
  }

  const creatorId = item.createdBy?.id
    ? String(item.createdBy.id)
    : null;

  if (!creatorId || creatorId !== actor.id) {
    return {
      status: 403,
      message: "Only the creator, head or deputy head can manage this item.",
    };
  }

  if (actor.role === "teacher_in_charge") {
    if (!TIC_MANAGEABLE_TYPES.has(item.type)) {
      return {
        status: 403,
        message:
          "Teachers in charge can only manage Event, Activity and Update items.",
      };
    }

    if (
      !actor.department ||
      normalizeDepartment(actor.department) !==
        normalizeDepartment(item.department)
    ) {
      return {
        status: 403,
        message:
          "You can only manage calendar items for your own department.",
      };
    }
  }

  return null;
}

async function list(req, res, next) {
  try {
    const actor = await getActor(req);
    const range = resolveRange(req.query);

    if (range.error) {
      return res.status(400).json({ message: range.error });
    }

    const filter = {
      ...overlapFilter(range.from, range.to),
      ...visibilityFilter(actor),
    };

    if (req.query.type !== undefined && req.query.type !== "") {
      const type = normalizeCalendarType(req.query.type);

      if (!type) {
        return res.status(400).json({
          message: `type must be one of: ${CALENDAR_TYPES.join(", ")}`,
        });
      }

      filter.type = type;
    }

    if (
      req.query.category !== undefined &&
      req.query.category !== ""
    ) {
      const category = normalizeCalendarCategory(req.query.category);

      if (!category) {
        return res.status(400).json({
          message: `category must be one of: ${CALENDAR_CATEGORIES.join(", ")}`,
        });
      }

      filter.category = category;
    }

    if (
      req.query.department !== undefined &&
      req.query.department !== ""
    ) {
      if (
        typeof req.query.department !== "string" ||
        !req.query.department.trim()
      ) {
        return res
          .status(400)
          .json({ message: "Invalid department" });
      }

      filter.department = exactInsensitive(
        req.query.department.trim()
      );
    }

    const items = await calendar(req)
      .find(filter)
      .sort({ startDate: 1, startTime: 1, createdAt: 1 })
      .toArray();

    return res.json({
      items: items.map(publicCalendar),
      total: items.length,
      from: range.from,
      to: range.to,
    });
  } catch (error) {
    return next(error);
  }
}

async function upcoming(req, res, next) {
  try {
    const actor = await getActor(req);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(
      Math.max(Number.isNaN(parsedLimit) ? 5 : parsedLimit, 1),
      50
    );
    const today = todayDateKey();

    const items = await calendar(req)
      .find({
        type: { $in: ["Event", "Activity", "Deadline"] },
        endDate: { $gte: today },
        ...visibilityFilter(actor),
      })
      .sort({ startDate: 1, startTime: 1, createdAt: 1 })
      .limit(limit)
      .toArray();

    return res.json({ upcoming: items.map(publicCalendar) });
  } catch (error) {
    return next(error);
  }
}

async function updates(req, res, next) {
  try {
    const actor = await getActor(req);
    const { page, limit, skip } = buildPagination(req.query);
    const today = todayDateKey();
    const filter = {
      type: "Update",
      $and: [
        visibilityFilter(actor),
        {
          $or: [
            { expiresAt: null },
            { expiresAt: { $exists: false } },
            { expiresAt: { $gte: today } },
          ],
        },
      ],
    };

    if (
      req.query.priority !== undefined &&
      req.query.priority !== ""
    ) {
      const priority = normalizeCalendarPriority(
        req.query.priority
      );

      if (!priority) {
        return res.status(400).json({
          message: "priority must be Normal or Important",
        });
      }

      filter.priority = priority;
    }

    const collection = calendar(req);
    const [items, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ pinned: -1, createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return res.json({
      updates: items.map(publicCalendar),
      total,
      page,
      limit,
    });
  } catch (error) {
    return next(error);
  }
}

async function holidays(req, res, next) {
  try {
    const range = resolveRange(req.query);

    if (range.error) {
      return res.status(400).json({ message: range.error });
    }

    const dates = await getHolidayDates(
      req.app.locals.db,
      range.from,
      range.to
    );
    const items = await calendar(req)
      .find({
        type: "Holiday",
        ...overlapFilter(range.from, range.to),
      })
      .sort({ startDate: 1, createdAt: 1 })
      .toArray();

    return res.json({
      holidays: dates,
      items: items.map(publicCalendar),
      from: range.from,
      to: range.to,
    });
  } catch (error) {
    return next(error);
  }
}

async function summary(req, res, next) {
  try {
    const actor = await getActor(req);
    const { from, to } = currentMonthRange();
    const rows = await calendar(req)
      .aggregate([
        {
          $match: {
            ...overlapFilter(from, to),
            ...visibilityFilter(actor),
          },
        },
        { $group: { _id: "$type", count: { $sum: 1 } } },
      ])
      .toArray();

    const counts = Object.fromEntries(
      CALENDAR_TYPES.map((type) => [type, 0])
    );

    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(counts, row._id)) {
        counts[row._id] = row.count;
      }
    }

    return res.json({
      month: from.slice(0, 7),
      from,
      to,
      counts,
      total: Object.values(counts).reduce(
        (total, count) => total + count,
        0
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function getById(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);

    if (!id) {
      return res
        .status(400)
        .json({ message: "Invalid calendar item id" });
    }

    const actor = await getActor(req);
    const item = await calendar(req).findOne({ _id: id });

    if (!item) {
      return res
        .status(404)
        .json({ message: "Calendar item not found" });
    }

    if (!isVisible(item, actor)) {
      return res.status(403).json({
        message: "You cannot view this calendar item",
      });
    }

    return res.json({ item: publicCalendar(item) });
  } catch (error) {
    return next(error);
  }
}

async function create(req, res, next) {
  try {
    const actor = await getActor(req);

    if (!CREATE_ROLES.has(actor.role)) {
      return res.status(403).json({
        message:
          "You do not have permission to create calendar items.",
      });
    }

    if (!actor.objectId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    if (actor.role === "teacher_in_charge" && !actor.department) {
      return res.status(403).json({
        message: "Your account has no department assigned.",
      });
    }

    const parsed = await parseCalendarBody(req, {
      partial: false,
      actor,
    });

    if (parsed.error) {
      return res
        .status(parsed.status || 400)
        .json({ message: parsed.error });
    }

    const { values } = parsed;

    if (
      actor.role === "teacher_in_charge" &&
      !TIC_MANAGEABLE_TYPES.has(values.type)
    ) {
      return res.status(403).json({
        message:
          "Teachers in charge can only create Event, Activity and Update items.",
      });
    }

    if (values.pinned && !LEADERSHIP_ROLES.has(actor.role)) {
      return res.status(403).json({
        message:
          "Only the head or deputy head can pin calendar items.",
      });
    }

    if (!LEADERSHIP_ROLES.has(actor.role)) {
      values.pinned = false;
    }

    const now = new Date();
    const item = {
      ...values,
      createdBy: {
        id: actor.objectId,
        name: actor.name,
        role: actor.role,
      },
      createdAt: now,
      updatedAt: now,
    };
    const result = await calendar(req).insertOne(item);

    return res.status(201).json({
      item: publicCalendar({ ...item, _id: result.insertedId }),
    });
  } catch (error) {
    return next(error);
  }
}

async function update(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);

    if (!id) {
      return res
        .status(400)
        .json({ message: "Invalid calendar item id" });
    }

    const actor = await getActor(req);
    const collection = calendar(req);
    const existing = await collection.findOne({ _id: id });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Calendar item not found" });
    }

    const denied = managementError(actor, existing);

    if (denied) {
      return res
        .status(denied.status)
        .json({ message: denied.message });
    }

    const body = req.body || {};

    if (
      Object.prototype.hasOwnProperty.call(body, "pinned") &&
      !LEADERSHIP_ROLES.has(actor.role)
    ) {
      return res.status(403).json({
        message:
          "Only the head or deputy head can pin calendar items.",
      });
    }

    const parsed = await parseCalendarBody(req, {
      partial: true,
      existing,
      actor,
    });

    if (parsed.error) {
      return res
        .status(parsed.status || 400)
        .json({ message: parsed.error });
    }

    if (parsed.provided.size === 0) {
      return res
        .status(400)
        .json({ message: "No valid fields to update" });
    }

    const effectiveType = parsed.values.type ?? existing.type;

    if (
      actor.role === "teacher_in_charge" &&
      !TIC_MANAGEABLE_TYPES.has(effectiveType)
    ) {
      return res.status(403).json({
        message:
          "Teachers in charge can only manage Event, Activity and Update items.",
      });
    }

    parsed.values.updatedAt = new Date();

    const item = await collection.findOneAndUpdate(
      { _id: id },
      { $set: parsed.values },
      { returnDocument: "after" }
    );

    if (!item) {
      return res
        .status(404)
        .json({ message: "Calendar item not found" });
    }

    return res.json({ item: publicCalendar(item) });
  } catch (error) {
    return next(error);
  }
}

async function remove(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);

    if (!id) {
      return res
        .status(400)
        .json({ message: "Invalid calendar item id" });
    }

    const actor = await getActor(req);
    const collection = calendar(req);
    const existing = await collection.findOne({ _id: id });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Calendar item not found" });
    }

    const denied = managementError(actor, existing);

    if (denied) {
      return res
        .status(denied.status)
        .json({ message: denied.message });
    }

    await collection.deleteOne({ _id: id });

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function pin(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);

    if (!id) {
      return res
        .status(400)
        .json({ message: "Invalid calendar item id" });
    }

    const body = req.body || {};
    const collection = calendar(req);
    const existing = await collection.findOne({ _id: id });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "Calendar item not found" });
    }

    let pinned;

    if (Object.prototype.hasOwnProperty.call(body, "pinned")) {
      if (typeof body.pinned !== "boolean") {
        return res.status(400).json({
          message: "pinned must be true or false",
        });
      }

      pinned = body.pinned;
    } else {
      pinned = !existing.pinned;
    }

    const item = await collection.findOneAndUpdate(
      { _id: id },
      { $set: { pinned, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    return res.json({ item: publicCalendar(item) });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  create,
  getById,
  holidays,
  list,
  pin,
  remove,
  summary,
  update,
  upcoming,
  updates,
};
