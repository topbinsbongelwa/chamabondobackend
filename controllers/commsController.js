const { dateKeyInHarare, parseDateKey, TEACHER_ROLES } = require("../utils/attendance");
const { getScopeFilter, ownsDepartment, parseObjectId } = require("../utils/adminScope");
const { logAction } = require("./adminController");
const { publishCommsItem } = require("../jobs/publishComms");

const COMM_TYPES = ["Update", "Event", "Activity", "Meeting"];
const LEADERSHIP = new Set(["deputy_head", "head"]);
const dbCollection = (req, name) => req.app.locals.db.collection(name);

function actorId(req) {
  return parseObjectId(String(req.user.id || ""));
}

function publicItem(item) {
  const { _id, ...rest } = item;
  return { ...rest, id: String(_id), _id: undefined };
}

function normalizeAudience(value) {
  return value === "department" || value === "all" ? value : null;
}

async function buildCommunication(req, existing = null) {
  const body = req.body || {};
  const actor = req.user;
  const id = actorId(req);
  if (!id) return { error: "Invalid user id", status: 401 };
  const type = body.type ?? existing?.type;
  if (!COMM_TYPES.includes(type)) return { error: `type must be one of: ${COMM_TYPES.join(", ")}` };
  const title = body.title ?? existing?.title;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
    return { error: "title is required and must be at most 160 characters" };
  }
  const description = body.description ?? body.body ?? existing?.description ?? "";
  if (typeof description !== "string" || description.length > 4000) {
    return { error: "description must be a string of at most 4,000 characters" };
  }
  const audience = actor.role === "teacher_in_charge"
    ? "department"
    : normalizeAudience(body.audience ?? existing?.audience ?? "all");
  if (!audience) return { error: "audience must be all or department" };
  let department = null;
  if (actor.role === "teacher_in_charge") {
    department = actor.department;
    if (!department) return { error: "Your account has no department assigned", status: 403 };
  } else if (audience === "department") {
    department = body.department ?? existing?.department;
    if (typeof department !== "string" || !department.trim() || department.trim().length > 120) {
      return { error: "department is required for a department audience" };
    }
    department = department.trim();
  }
  const rawRecipients = body.recipientIds ?? existing?.recipientIds;
  if (rawRecipients !== undefined && (!Array.isArray(rawRecipients) || rawRecipients.length > 500)) {
    return { error: "recipientIds must be an array of at most 500 user ids" };
  }
  const recipientsRequested = rawRecipients || [];
  const recipientIds = recipientsRequested.map(parseObjectId);
  if (recipientIds.some((recipient) => !recipient) || new Set(recipientIds.map(String)).size !== recipientIds.length) {
    return { error: "recipientIds must contain unique valid ObjectIds" };
  }
  const audienceFilter = {
    ...getScopeFilter(actor),
    role: { $in: TEACHER_ROLES },
    active: { $ne: false },
  };
  if (audience === "department") {
    audienceFilter.department = department;
  } else if (actor.role === "teacher_in_charge") {
    audienceFilter.department = actor.department;
  }
  let people;
  if (recipientIds.length) {
    people = await dbCollection(req, "users")
      .find({ ...audienceFilter, _id: { $in: recipientIds } })
      .toArray();
    if (people.length !== recipientIds.length) {
      return { error: "One or more recipients are outside the allowed audience", status: 403 };
    }
  } else {
    people = await dbCollection(req, "users").find(audienceFilter).toArray();
  }
  const now = new Date();
  const scheduledAtRaw = body.scheduledAt ?? existing?.scheduledAt ?? now.toISOString();
  if (!(scheduledAtRaw instanceof Date) && typeof scheduledAtRaw !== "string") {
    return { error: "scheduledAt must be a valid ISO date-time" };
  }
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) return { error: "scheduledAt must be a valid ISO date-time" };
  if (scheduledAt.getTime() > now.getTime() + 366 * 86400000) {
    return { error: "scheduledAt cannot be more than one year in the future" };
  }
  const startDate = body.startDate ?? existing?.startDate ?? dateKeyInHarare(scheduledAt);
  if (!parseDateKey(startDate)) return { error: "startDate must be a valid YYYY-MM-DD date" };
  const endDate = body.endDate ?? existing?.endDate ?? startDate;
  if (!parseDateKey(endDate) || endDate < startDate) {
    return { error: "endDate must be a valid date on or after startDate" };
  }
  let expiresAt = body.expiresAt ?? existing?.expiresAt ?? null;
  if (expiresAt !== null && expiresAt !== "") {
    expiresAt = parseDateKey(expiresAt);
    if (!expiresAt) return { error: "expiresAt must be a valid YYYY-MM-DD date" };
  } else {
    expiresAt = null;
  }
  const rsvpEnabled = body.rsvpEnabled ?? existing?.rsvpEnabled ?? false;
  const pinned = body.pinned ?? existing?.pinned ?? false;
  const priority = body.priority ?? existing?.priority ?? "Normal";
  if (typeof rsvpEnabled !== "boolean") return { error: "rsvpEnabled must be true or false" };
  if (typeof pinned !== "boolean") return { error: "pinned must be true or false" };
  if (!["Normal", "Important"].includes(priority)) return { error: "priority must be Normal or Important" };
  if (pinned && !LEADERSHIP.has(actor.role)) {
    return { error: "Only a deputy head or head can pin communications", status: 403 };
  }
  let attachment = body.attachment ?? existing?.attachment ?? null;
  if (attachment !== null) {
    if (typeof attachment === "string") attachment = { url: attachment };
    if (!attachment || typeof attachment !== "object" || typeof attachment.url !== "string" || attachment.url.length > 1000) {
      return { error: "attachment must contain a valid URL" };
    }
    try {
      const url = new URL(attachment.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch {
      return { error: "attachment URL must use http or https" };
    }
    const name = typeof attachment.name === "string" ? attachment.name.trim().slice(0, 180) : null;
    attachment = { url: attachment.url, name };
  }
  const creator = existing?.createdBy || {
    id,
    name: String(actor.name || "").slice(0, 120),
    role: actor.role,
  };
  return {
    values: {
      type,
      title: title.trim(),
      description: description.trim(),
      startDate,
      endDate,
      audience,
      department,
      assignedTeachers: people.map((person) => ({
        teacherId: person._id,
        teacherName: [person.firstName, person.surname].filter(Boolean).join(" ") || person.name || person.ecNumber || "Teacher",
      })),
      recipientIds: people.map((person) => person._id),
      attachment,
      scheduledAt,
      rsvpEnabled,
      priority,
      pinned,
      expiresAt,
      isCommunication: true,
      published: existing?.published === true,
      publishedAt: existing?.publishedAt || null,
      readBy: existing?.readBy || [],
      rsvps: existing?.rsvps || {},
      createdBy: creator,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    },
    isDue: scheduledAt <= now,
  };
}

function canManage(req, item) {
  if (LEADERSHIP.has(req.user.role)) return true;
  const ownerId = String(item.createdBy?.id || "");
  return ownerId === String(req.user.id);
}

async function create(req, res, next) {
  try {
    const parsed = await buildCommunication(req);
    if (parsed.error) return res.status(parsed.status || 400).json({ message: parsed.error });
    const result = await dbCollection(req, "calendar").insertOne(parsed.values);
    const item = { ...parsed.values, _id: result.insertedId };
    if (parsed.isDue) {
      await publishCommsItem(req.app.locals.db, result.insertedId);
      item.published = true;
      item.publishedAt = new Date();
    }
    return res.status(201).json({ item: publicItem(item) });
  } catch (error) {
    return next(error);
  }
}

async function sent(req, res, next) {
  try {
    const scope = getScopeFilter(req.user);
    if (req.user.role === "teacher_in_charge" && !req.user.department) {
      return res.status(403).json({ message: "Your account has no department assigned" });
    }
    const items = await dbCollection(req, "calendar")
      .find({ ...scope, isCommunication: true, "createdBy.id": actorId(req) })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    return res.json({
      items: items.map((item) => ({
        ...publicItem(item),
        readCount: Array.isArray(item.readBy)
          ? item.readBy.length
          : Object.keys(item.readBy || {}).length,
        totalRecipients: Array.isArray(item.recipientIds) ? item.recipientIds.length : 0,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function update(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid communication id" });
    const item = await dbCollection(req, "calendar").findOne({ _id: id, isCommunication: true });
    if (!item) return res.status(404).json({ message: "Communication not found" });
    if (!(await ownsDepartment(req.app.locals.db, req.user, item))) {
      return res.status(403).json({ message: "You cannot manage communications outside your department" });
    }
    if (!canManage(req, item)) {
      return res.status(403).json({ message: "Only the creator, deputy head or head can manage this communication" });
    }
    const parsed = await buildCommunication(req, item);
    if (parsed.error) return res.status(parsed.status || 400).json({ message: parsed.error });
    const updated = await dbCollection(req, "calendar").findOneAndUpdate(
      { _id: id, isCommunication: true },
      { $set: parsed.values },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(404).json({ message: "Communication not found" });
    return res.json({ item: publicItem(updated) });
  } catch (error) {
    return next(error);
  }
}

async function remove(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid communication id" });
    const item = await dbCollection(req, "calendar").findOne({ _id: id, isCommunication: true });
    if (!item) return res.status(404).json({ message: "Communication not found" });
    if (!(await ownsDepartment(req.app.locals.db, req.user, item))) {
      return res.status(403).json({ message: "You cannot delete communications outside your department" });
    }
    if (!canManage(req, item)) {
      return res.status(403).json({ message: "Only the creator, deputy head or head can delete this communication" });
    }
    await dbCollection(req, "calendar").deleteOne({ _id: id, isCommunication: true });
    await logAction(req, "communication.deleted", id);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

async function markSeen(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    const userId = actorId(req);
    if (!id) return res.status(400).json({ message: "Invalid communication id" });
    if (!userId) return res.status(401).json({ message: "Invalid user id" });
    const item = await dbCollection(req, "calendar").findOne({
      _id: id,
      isCommunication: true,
      published: true,
      recipientIds: userId,
    }, { projection: { _id: 1 } });
    if (!item) return res.status(404).json({ message: "Communication not found" });
    await dbCollection(req, "calendar").updateOne(
      { _id: id, isCommunication: true, published: true, recipientIds: userId },
      { $set: { [`readBy.${userId}`]: { readAt: new Date() } } }
    );
    return res.json({ message: "Communication marked as read" });
  } catch (error) {
    return next(error);
  }
}

async function rsvp(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    const userId = actorId(req);
    const response = req.body?.response;
    if (!id) return res.status(400).json({ message: "Invalid communication id" });
    if (!["accepted", "declined", "tentative"].includes(response)) {
      return res.status(400).json({ message: "response must be accepted, declined or tentative" });
    }
    const result = await dbCollection(req, "calendar").updateOne(
      {
        _id: id,
        isCommunication: true,
        published: true,
        rsvpEnabled: true,
        recipientIds: userId,
      },
      { $set: { [`rsvps.${userId}`]: { response, respondedAt: new Date() } } }
    );
    if (!result.matchedCount) return res.status(404).json({ message: "Communication not found or RSVP is unavailable" });
    return res.json({ message: "RSVP recorded", response });
  } catch (error) {
    return next(error);
  }
}

async function rsvps(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid communication id" });
    const item = await dbCollection(req, "calendar").findOne({ _id: id, isCommunication: true });
    if (!item) return res.status(404).json({ message: "Communication not found" });
    if (!(await ownsDepartment(req.app.locals.db, req.user, item))) {
      return res.status(403).json({ message: "You cannot access communications outside your department" });
    }
    if (String(item.createdBy?.id || "") !== String(req.user.id)) {
      return res.status(403).json({ message: "Only the sender can view RSVP responses" });
    }
    const responses = [];
    for (const [userId, response] of Object.entries(item.rsvps || {})) {
      const rsvpUserId = parseObjectId(userId);
      if (!rsvpUserId) continue;
      const person = await dbCollection(req, "users").findOne(
        { _id: rsvpUserId, ...getScopeFilter(req.user) },
        { projection: { firstName: 1, surname: 1, name: 1, ecNumber: 1 } }
      );
      if (person) {
        responses.push({
          userId,
          name: [person.firstName, person.surname].filter(Boolean).join(" ") || person.name || person.ecNumber || "Teacher",
          response: response.response,
          respondedAt: response.respondedAt,
        });
      }
    }
    return res.json({ rsvps: responses });
  } catch (error) {
    return next(error);
  }
}

async function notificationList(req, res, next) {
  try {
    const userId = actorId(req);
    if (!userId) return res.status(401).json({ message: "Invalid user id" });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
    const notifications = await dbCollection(req, "notifications")
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return res.json({ notifications });
  } catch (error) {
    return next(error);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const id = parseObjectId(req.params.id);
    const userId = actorId(req);
    if (!id) return res.status(400).json({ message: "Invalid notification id" });
    const result = await dbCollection(req, "notifications").updateOne(
      { _id: id, userId },
      { $set: { readAt: new Date() } }
    );
    if (!result.matchedCount) return res.status(404).json({ message: "Notification not found" });
    return res.json({ message: "Notification marked as read" });
  } catch (error) {
    return next(error);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    const userId = actorId(req);
    const result = await dbCollection(req, "notifications").updateMany(
      { userId, readAt: null },
      { $set: { readAt: new Date() } }
    );
    return res.json({ updatedCount: result.modifiedCount });
  } catch (error) {
    return next(error);
  }
}

async function subscribePush(req, res, next) {
  try {
    const subscription = req.body || {};
    if (
      typeof subscription.endpoint !== "string" ||
      subscription.endpoint.length > 2000 ||
      !subscription.keys ||
      typeof subscription.keys.p256dh !== "string" ||
      typeof subscription.keys.auth !== "string"
    ) {
      return res.status(400).json({ message: "A valid push subscription is required" });
    }
    try {
      const endpoint = new URL(subscription.endpoint);
      const allowedPushHosts = [
        "fcm.googleapis.com",
        "push.services.mozilla.com",
        "web.push.apple.com",
      ];
      if (
        endpoint.protocol !== "https:" ||
        !allowedPushHosts.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`))
      ) {
        throw new Error("invalid push endpoint");
      }
    } catch {
      return res.status(400).json({ message: "Push endpoint must use a supported HTTPS push service" });
    }
    const userId = actorId(req);
    await dbCollection(req, "push_subscriptions").updateOne(
      { userId, endpoint: subscription.endpoint },
      {
        $set: {
          userId,
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    return res.status(201).json({ message: "Push subscription saved" });
  } catch (error) {
    return next(error);
  }
}

async function unsubscribePush(req, res, next) {
  try {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 2000) {
      return res.status(400).json({ message: "endpoint is required" });
    }
    const result = await dbCollection(req, "push_subscriptions").deleteOne({
      userId: actorId(req),
      endpoint,
    });
    return res.json({ deleted: Boolean(result.deletedCount) });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  create,
  markAllNotificationsRead,
  markNotificationRead,
  markSeen,
  notificationList,
  remove,
  rsvp,
  rsvps,
  sent,
  subscribePush,
  unsubscribePush,
  update,
};
