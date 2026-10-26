const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate } = require("../middleware/auth");

const router = express.Router();
const PUBLISHER_ROLES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "schooladmin",
  "head",
  "headmaster",
  "headmistress",
  "deputy",
  "deputyhead",
  "deputyheadmaster",
  "deputyheadmistress",
  "teacherincharge",
  "tic",
]);
const CATEGORIES = new Set(["general", "meeting", "sports", "event"]);

function canPublish(user) {
  const role = String(user.role || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return PUBLISHER_ROLES.has(role);
}

function requirePublisher(req, res, next) {
  if (!canPublish(req.user)) {
    return res.status(403).json({ message: "School leader access required" });
  }

  return next();
}

function announcements(req) {
  return req.app.locals.db.collection("announcements");
}

function parseId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

function publicAnnouncement(item) {
  return {
    id: item._id.toString(),
    title: item.title,
    body: item.body,
    category: item.category,
    eventDate: item.eventDate || null,
    authorName: item.authorName,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function parseFields(body, partial = false) {
  const values = {};

  if (!partial || Object.hasOwn(body, "title")) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 160) {
      return { error: "Title is required and must be at most 160 characters." };
    }
    values.title = title;
  }

  if (!partial || Object.hasOwn(body, "body")) {
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text || text.length > 4000) {
      return { error: "Update details are required and must be at most 4,000 characters." };
    }
    values.body = text;
  }

  if (!partial || Object.hasOwn(body, "category")) {
    const category =
      typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
    if (!CATEGORIES.has(category)) {
      return { error: "Choose General, Meeting, Sports, or Event." };
    }
    values.category = category;
  }

  if (!partial || Object.hasOwn(body, "eventDate")) {
    const eventDate =
      typeof body.eventDate === "string" ? body.eventDate.trim() : "";
    if (
      eventDate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) ||
        Number.isNaN(new Date(`${eventDate}T00:00:00.000Z`).getTime()))
    ) {
      return { error: "Enter a valid event date." };
    }
    values.eventDate = eventDate || null;
  }

  return { values };
}

router.get("/", authenticate, async (req, res, next) => {
  try {
    const items = await announcements(req)
      .find({})
      .sort({ eventDate: 1, createdAt: -1 })
      .limit(100)
      .toArray();

    return res.json({ announcements: items.map(publicAnnouncement) });
  } catch (error) {
    return next(error);
  }
});

router.post("/", authenticate, requirePublisher, async (req, res, next) => {
  try {
    const { values, error } = parseFields(req.body || {});
    if (error) return res.status(400).json({ message: error });

    const now = new Date();
    const item = {
      ...values,
      authorId: parseId(req.user.id),
      authorName: req.user.name || "School administrator",
      createdAt: now,
      updatedAt: now,
    };
    const result = await announcements(req).insertOne(item);

    return res
      .status(201)
      .json({ announcement: publicAnnouncement({ ...item, _id: result.insertedId }) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", authenticate, requirePublisher, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid update id" });

    const { values, error } = parseFields(req.body || {}, true);
    if (error) return res.status(400).json({ message: error });
    if (Object.keys(values).length === 0) {
      return res.status(400).json({ message: "Provide details to update." });
    }
    values.updatedAt = new Date();

    const result = await announcements(req).findOneAndUpdate(
      { _id: id },
      { $set: values },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Update not found" });

    return res.json({ announcement: publicAnnouncement(result) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", authenticate, requirePublisher, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid update id" });

    const result = await announcements(req).deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Update not found" });
    }

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
