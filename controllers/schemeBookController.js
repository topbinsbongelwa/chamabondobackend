const { ObjectId } = require("mongodb");
const {
  storeFile,
  removeStoredFile,
  discardUploadedFile,
} = require("../middleware/upload");

const COLLECTION = "schemebooks";
const GLOBAL_REVIEWER_ROLES = new Set(["deputy_head", "head"]);
const STATUSES = ["Pending", "Approved", "Rejected"];
const STATUS_BY_LOWER = new Map(
  STATUSES.map((status) => [status.toLowerCase(), status])
);
const TEXT_FIELDS = {
  subject: { label: "subject", maxLength: 120 },
  grade: { label: "grade", maxLength: 80 },
  title: { label: "title", maxLength: 180 },
};
const DUPLICATE_MESSAGE =
  "You have already submitted a scheme book for this subject, grade, term, year and week range.";

function schemeBooks(req) {
  return req.app.locals.db.collection(COLLECTION);
}

function users(req) {
  return req.app.locals.db.collection("users");
}

function parseId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

function publicSchemeBook(item) {
  const { _id, ...rest } = item;

  if (rest.file) {
    rest.file = {
      url: rest.file.url,
      originalName: rest.file.originalName,
      mimeType: rest.file.mimeType,
      size: rest.file.size,
    };
  }

  return { id: _id.toString(), ...rest };
}

function displayName(user) {
  return (
    [user.firstName, user.surname].filter(Boolean).join(" ") ||
    user.name ||
    user.ecNumber ||
    "Teacher"
  );
}

function normalizeStatus(value) {
  return typeof value === "string"
    ? STATUS_BY_LOWER.get(value.trim().toLowerCase()) || null
    : null;
}

function normalizeDepartment(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function sameTeacher(recordTeacherId, userId) {
  return String(recordTeacherId || "") === String(userId || "");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactInsensitive(value) {
  return { $regex: `^${escapeRegex(value)}$`, $options: "i" };
}

function parseInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (
    typeof value === "string" &&
    /^\d+$/.test(value.trim()) &&
    value.trim().length <= 6
  ) {
    return Number(value.trim());
  }

  return null;
}

function parseSchemeFields(body, base = null) {
  const values = {};
  const has = (name) => Object.prototype.hasOwnProperty.call(body, name);

  for (const [field, { label, maxLength }] of Object.entries(TEXT_FIELDS)) {
    let value;

    if (has(field)) {
      value = typeof body[field] === "string" ? body[field].trim() : "";
    } else if (base) {
      value = typeof base[field] === "string" ? base[field].trim() : "";
    } else {
      value = "";
    }

    if (!value) {
      return { error: `${label} is required.` };
    }

    if (value.length > maxLength) {
      return {
        error: `${label} must be at most ${maxLength} characters.`,
      };
    }

    values[field] = value;
  }

  if (has("notes")) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return { error: "notes must be a string." };
    }

    const notes =
      typeof body.notes === "string" ? body.notes.trim() : "";

    if (notes.length > 2000) {
      return { error: "notes must be at most 2,000 characters." };
    }

    values.notes = notes || null;
  } else {
    values.notes = base?.notes || null;
  }

  const term = parseInteger(has("term") ? body.term : base?.term);
  if (![1, 2, 3].includes(term)) {
    return { error: "term must be 1, 2 or 3." };
  }
  values.term = term;

  const year = parseInteger(has("year") ? body.year : base?.year);
  if (!year || year < 2000 || year > 2100) {
    return {
      error: "year must be a four-digit year between 2000 and 2100.",
    };
  }
  values.year = year;

  const weekFrom = parseInteger(
    has("weekFrom") ? body.weekFrom : base?.weekFrom
  );
  const weekTo = parseInteger(has("weekTo") ? body.weekTo : base?.weekTo);

  if (!weekFrom || weekFrom < 1 || weekFrom > 52) {
    return { error: "weekFrom must be a week number from 1 to 52." };
  }

  if (!weekTo || weekTo < 1 || weekTo > 52) {
    return { error: "weekTo must be a week number from 1 to 52." };
  }

  if (weekFrom > weekTo) {
    return { error: "weekFrom cannot be greater than weekTo." };
  }

  values.weekFrom = weekFrom;
  values.weekTo = weekTo;

  return { values };
}

function duplicateFilter(teacherId, values) {
  return {
    teacherId,
    subject: values.subject,
    grade: values.grade,
    term: values.term,
    year: values.year,
    weekFrom: values.weekFrom,
    weekTo: values.weekTo,
  };
}

function parseStatusQuery(value) {
  if (value === undefined || value === "") {
    return {};
  }

  const status = normalizeStatus(value);

  if (!status) {
    return { error: "status must be Pending, Approved or Rejected." };
  }

  return { status };
}

function parseTermQuery(value) {
  if (value === undefined || value === "") {
    return {};
  }

  const term = parseInteger(value);

  if (![1, 2, 3].includes(term)) {
    return { error: "term must be 1, 2 or 3." };
  }

  return { term };
}

function parseYearQuery(value) {
  if (value === undefined || value === "") {
    return {};
  }

  const year = parseInteger(value);

  if (!year || year < 2000 || year > 2100) {
    return {
      error: "year must be a four-digit year between 2000 and 2100.",
    };
  }

  return { year };
}

function parseTextQuery(value, label, maxLength) {
  if (value === undefined || value === "") {
    return {};
  }

  if (typeof value !== "string") {
    return { error: `Invalid ${label}.` };
  }

  const text = value.trim();

  if (!text) {
    return {};
  }

  if (text.length > maxLength) {
    return { error: `${label} is too long.` };
  }

  return { value: text };
}

function addListFilters(filter, query) {
  const status = parseStatusQuery(query.status);
  if (status.error) return { error: status.error };
  if (status.status) filter.status = status.status;

  const term = parseTermQuery(query.term);
  if (term.error) return { error: term.error };
  if (term.term) filter.term = term.term;

  const year = parseYearQuery(query.year);
  if (year.error) return { error: year.error };
  if (year.year) filter.year = year.year;

  const subject = parseTextQuery(query.subject, "subject", 120);
  if (subject.error) return { error: subject.error };
  if (subject.value) filter.subject = exactInsensitive(subject.value);

  return {};
}

async function getReviewerDepartment(req) {
  const userId = parseId(req.user.id);

  if (!userId) {
    return null;
  }

  const user = await users(req).findOne(
    { _id: userId },
    { projection: { department: 1 } }
  );

  return user?.department || null;
}

async function getMySchemeBooks(req, res, next) {
  try {
    const teacherId = parseId(req.user.id);

    if (!teacherId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const filter = { teacherId: req.user.id };
    const { error } = addListFilters(filter, req.query);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const items = await schemeBooks(req)
      .find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return res.json({ schemeBooks: items.map(publicSchemeBook) });
  } catch (error) {
    return next(error);
  }
}

async function listSchemeBooks(req, res, next) {
  try {
    const isGlobalReviewer = GLOBAL_REVIEWER_ROLES.has(req.user.role);
    const filter = {};
    let reviewerDepartment = null;

    if (!isGlobalReviewer) {
      reviewerDepartment = await getReviewerDepartment(req);

      if (!reviewerDepartment) {
        return res.status(403).json({
          message: "Your account has no department assigned.",
        });
      }

      if (
        req.query.department &&
        normalizeDepartment(req.query.department) !==
          normalizeDepartment(reviewerDepartment)
      ) {
        return res.status(403).json({
          message: "You can only view scheme books from your department.",
        });
      }

      filter.department = exactInsensitive(reviewerDepartment);
    } else if (req.query.department !== undefined && req.query.department !== "") {
      const department = parseTextQuery(req.query.department, "department", 120);

      if (department.error) {
        return res.status(400).json({ message: department.error });
      }

      if (department.value) {
        filter.department = exactInsensitive(department.value);
      }
    }

    if (req.query.teacherId !== undefined && req.query.teacherId !== "") {
      if (!parseId(req.query.teacherId)) {
        return res.status(400).json({ message: "Invalid teacherId" });
      }

      filter.teacherId = req.query.teacherId;
    }

    const { error } = addListFilters(filter, req.query);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const items = await schemeBooks(req)
      .find(filter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return res.json({ schemeBooks: items.map(publicSchemeBook) });
  } catch (error) {
    return next(error);
  }
}

async function createSchemeBook(req, res, next) {
  let storedFile = null;

  try {
    const { values, error } = parseSchemeFields(req.body || {});

    if (error) {
      await discardUploadedFile(req.file);
      return res.status(400).json({ message: error });
    }

    if (!req.file) {
      return res.status(400).json({
        message: "Attach a PDF, DOC, DOCX, JPG or PNG file.",
      });
    }

    const userId = parseId(req.user.id);

    if (!userId) {
      await discardUploadedFile(req.file);
      return res.status(401).json({ message: "Invalid token" });
    }

    const teacher = await users(req).findOne({ _id: userId });

    if (!teacher) {
      await discardUploadedFile(req.file);
      return res.status(401).json({ message: "User no longer exists" });
    }

    const teacherId = req.user.id;
    const duplicate = await schemeBooks(req).findOne(
      duplicateFilter(teacherId, values)
    );

    if (duplicate) {
      await discardUploadedFile(req.file);
      return res.status(409).json({ message: DUPLICATE_MESSAGE });
    }

    storedFile = await storeFile(req.file);
    const now = new Date();
    const document = {
      teacherId,
      teacherName: displayName(teacher),
      department: teacher.department || null,
      ...values,
      file: storedFile,
      status: "Pending",
      reviewerComment: null,
      reviewedBy: null,
      reviewedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    const result = await schemeBooks(req).insertOne(document);

    return res.status(201).json({
      schemeBook: publicSchemeBook({
        ...document,
        _id: result.insertedId,
      }),
    });
  } catch (error) {
    if (storedFile) {
      await removeStoredFile(storedFile);
    } else {
      await discardUploadedFile(req.file);
    }

    if (error.code === 11000) {
      return res.status(409).json({ message: DUPLICATE_MESSAGE });
    }

    return next(error);
  }
}

async function updateSchemeBook(req, res, next) {
  let storedFile = null;

  try {
    const id = parseId(req.params.id);

    if (!id) {
      await discardUploadedFile(req.file);
      return res.status(400).json({ message: "Invalid scheme book id" });
    }

    const userId = parseId(req.user.id);

    if (!userId) {
      await discardUploadedFile(req.file);
      return res.status(401).json({ message: "Invalid token" });
    }

    const existing = await schemeBooks(req).findOne({ _id: id });

    if (!existing) {
      await discardUploadedFile(req.file);
      return res.status(404).json({ message: "Scheme book not found" });
    }

    if (!sameTeacher(existing.teacherId, req.user.id)) {
      await discardUploadedFile(req.file);
      return res.status(403).json({
        message: "You cannot update this scheme book.",
      });
    }

    if (existing.status !== "Rejected") {
      await discardUploadedFile(req.file);
      return res.status(409).json({
        message: "Only rejected scheme books can be resubmitted.",
      });
    }

    const { values, error } = parseSchemeFields(req.body || {}, existing);

    if (error) {
      await discardUploadedFile(req.file);
      return res.status(400).json({ message: error });
    }

    const duplicate = await schemeBooks(req).findOne({
      ...duplicateFilter(req.user.id, values),
      _id: { $ne: id },
    });

    if (duplicate) {
      await discardUploadedFile(req.file);
      return res.status(409).json({ message: DUPLICATE_MESSAGE });
    }

    if (req.file) {
      storedFile = await storeFile(req.file);
    }

    const now = new Date();
    const updates = {
      ...values,
      file: storedFile || existing.file,
      status: "Pending",
      reviewerComment: null,
      reviewedBy: null,
      reviewedAt: null,
      version: (Number(existing.version) || 1) + 1,
      updatedAt: now,
    };

    const updated = await schemeBooks(req).findOneAndUpdate(
      { _id: id, teacherId: existing.teacherId, status: "Rejected" },
      { $set: updates },
      { returnDocument: "after" }
    );

    if (!updated) {
      if (storedFile) {
        await removeStoredFile(storedFile);
      }
      return res.status(409).json({
        message: "Only rejected scheme books can be resubmitted.",
      });
    }

    if (storedFile && existing.file) {
      await removeStoredFile(existing.file);
    }

    return res.json({ schemeBook: publicSchemeBook(updated) });
  } catch (error) {
    if (storedFile) {
      await removeStoredFile(storedFile);
    } else {
      await discardUploadedFile(req.file);
    }

    if (error.code === 11000) {
      return res.status(409).json({ message: DUPLICATE_MESSAGE });
    }

    return next(error);
  }
}

async function deleteSchemeBook(req, res, next) {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      return res.status(400).json({ message: "Invalid scheme book id" });
    }

    const userId = parseId(req.user.id);

    if (!userId) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const existing = await schemeBooks(req).findOne({ _id: id });

    if (!existing) {
      return res.status(404).json({ message: "Scheme book not found" });
    }

    if (!sameTeacher(existing.teacherId, req.user.id)) {
      return res.status(403).json({
        message: "You cannot delete this scheme book.",
      });
    }

    if (!["Pending", "Rejected"].includes(existing.status)) {
      return res.status(409).json({
        message: "Approved scheme books cannot be deleted.",
      });
    }

    const result = await schemeBooks(req).deleteOne({
      _id: id,
      teacherId: existing.teacherId,
      status: { $in: ["Pending", "Rejected"] },
    });

    if (!result.deletedCount) {
      return res.status(409).json({
        message: "The scheme book can no longer be deleted.",
      });
    }

    await removeStoredFile(existing.file);

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function reviewSchemeBook(req, res, next) {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      return res.status(400).json({ message: "Invalid scheme book id" });
    }

    const body = req.body || {};
    const status = normalizeStatus(body.status);

    if (!status || !["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({
        message: "status must be Approved or Rejected.",
      });
    }

    if (body.comment !== undefined && typeof body.comment !== "string") {
      return res.status(400).json({ message: "comment must be a string." });
    }

    const comment =
      typeof body.comment === "string" ? body.comment.trim() : "";

    if (status === "Rejected" && !comment) {
      return res.status(400).json({
        message: "A comment is required when rejecting a scheme book.",
      });
    }

    if (comment.length > 2000) {
      return res.status(400).json({
        message: "comment must be at most 2,000 characters.",
      });
    }

    const existing = await schemeBooks(req).findOne({ _id: id });

    if (!existing) {
      return res.status(404).json({ message: "Scheme book not found" });
    }

    const isGlobalReviewer = GLOBAL_REVIEWER_ROLES.has(req.user.role);
    const reviewFilter = { _id: id, status: "Pending" };

    if (!isGlobalReviewer) {
      const department = await getReviewerDepartment(req);

      if (!department) {
        return res.status(403).json({
          message: "Your account has no department assigned.",
        });
      }

      if (
        !existing.department ||
        normalizeDepartment(existing.department) !==
          normalizeDepartment(department)
      ) {
        return res.status(403).json({
          message: "You cannot review scheme books outside your department.",
        });
      }

      reviewFilter.department = existing.department;
    }

    if (existing.status !== "Pending") {
      return res.status(409).json({
        message: "Only pending scheme books can be reviewed.",
      });
    }

    const now = new Date();
    const updated = await schemeBooks(req).findOneAndUpdate(
      reviewFilter,
      {
        $set: {
          status,
          reviewerComment: comment || null,
          reviewedBy: req.user.name || req.user.email || "Reviewer",
          reviewedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (!updated) {
      return res.status(409).json({
        message: "Only pending scheme books can be reviewed.",
      });
    }

    return res.json({ schemeBook: publicSchemeBook(updated) });
  } catch (error) {
    return next(error);
  }
}

async function getSummary(req, res, next) {
  try {
    const isGlobalReviewer = GLOBAL_REVIEWER_ROLES.has(req.user.role);
    const match = {};
    let department = null;

    if (!isGlobalReviewer) {
      department = await getReviewerDepartment(req);

      if (!department) {
        return res.status(403).json({
          message: "Your account has no department assigned.",
        });
      }

      match.department = exactInsensitive(department);
    }

    const statusRows = await schemeBooks(req)
      .aggregate([
        { $match: match },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray();

    const byStatus = { Pending: 0, Approved: 0, Rejected: 0 };
    let total = 0;

    for (const row of statusRows) {
      if (Object.prototype.hasOwnProperty.call(byStatus, row._id)) {
        byStatus[row._id] = row.count;
        total += row.count;
      }
    }

    const summary = { total, byStatus };

    if (isGlobalReviewer) {
      const departmentRows = await schemeBooks(req)
        .aggregate([
          {
            $group: {
              _id: {
                department: { $ifNull: ["$department", "Unassigned"] },
                status: "$status",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.department": 1 } },
        ])
        .toArray();

      const departments = new Map();

      for (const row of departmentRows) {
        const name = row._id.department || "Unassigned";

        if (!departments.has(name)) {
          departments.set(name, {
            department: name,
            total: 0,
            byStatus: { Pending: 0, Approved: 0, Rejected: 0 },
          });
        }

        const entry = departments.get(name);

        if (Object.prototype.hasOwnProperty.call(entry.byStatus, row._id.status)) {
          entry.byStatus[row._id.status] = row.count;
          entry.total += row.count;
        }
      }

      summary.byDepartment = [...departments.values()];
    } else {
      summary.department = department;
    }

    return res.json({ summary });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createSchemeBook,
  deleteSchemeBook,
  getMySchemeBooks,
  getSummary,
  listSchemeBooks,
  reviewSchemeBook,
  updateSchemeBook,
};
