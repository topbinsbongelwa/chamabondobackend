const cron = require("node-cron");
const { HARARE_TIME_ZONE } = require("../utils/attendance");
const { sendPush } = require("../services/pushNotifications");

async function publishCommsItem(db, itemId) {
  const now = new Date();
  const item = await db.collection("calendar").findOneAndUpdate(
    {
      _id: itemId,
      isCommunication: true,
      published: false,
      scheduledAt: { $lte: now },
    },
    { $set: { published: true, publishedAt: now, updatedAt: now } },
    { returnDocument: "before" }
  );
  if (!item) return false;
  const recipientIds = Array.isArray(item.recipientIds) ? item.recipientIds : [];
  const notifications = recipientIds.map((userId) => ({
    userId,
    sourceId: itemId,
    type: "communication",
    title: item.title,
    body: item.description || "",
    link: `/calendar/${itemId.toString()}`,
    readAt: null,
    createdAt: now,
  }));
  try {
    if (notifications.length) {
      await db.collection("notifications").bulkWrite(
        notifications.map((notification) => ({
          updateOne: {
            filter: {
              userId: notification.userId,
              sourceId: itemId,
              type: notification.type,
            },
            update: { $setOnInsert: notification },
            upsert: true,
          },
        })),
        { ordered: true }
      );
    }
  } catch (error) {
    await db.collection("calendar").updateOne(
      { _id: itemId, published: true, publishedAt: now },
      { $set: { published: false }, $unset: { publishedAt: "" } }
    );
    throw error;
  }
  for (const notification of notifications) {
    await sendPush(db, notification.userId, notification);
  }
  return true;
}

async function publishDueComms(db, now = new Date()) {
  const due = await db
    .collection("calendar")
    .find({
      isCommunication: true,
      published: false,
      scheduledAt: { $lte: now },
    })
    .project({ _id: 1 })
    .limit(200)
    .toArray();
  let count = 0;
  for (const item of due) {
    if (await publishCommsItem(db, item._id)) count += 1;
  }
  return count;
}

function startCommsPublisher(db) {
  const task = cron.schedule(
    "* * * * *",
    async () => {
      try {
        const published = await publishDueComms(db);
        if (published) console.log(`[communications] Published ${published} scheduled item(s).`);
      } catch (error) {
        console.error("[communications] Scheduled publishing failed:", error);
      }
    },
    { timezone: HARARE_TIME_ZONE }
  );
  return task;
}

module.exports = { publishCommsItem, publishDueComms, startCommsPublisher };
