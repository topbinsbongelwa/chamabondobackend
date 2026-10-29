const webpush = require("web-push");

let configured = false;

function configurePush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

async function sendPush(db, userId, notification) {
  if (!configured && !configurePush()) return;
  const collection = db.collection("push_subscriptions");
  const subscriptions = await collection.find({ userId }).toArray();
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        JSON.stringify({
          title: notification.title,
          body: notification.body,
          link: notification.link || "/",
        })
      );
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await collection.deleteOne({ _id: subscription._id });
      } else {
        console.error("[web-push] Notification delivery failed:", error.message);
      }
    }
  }
}

module.exports = { configurePush, sendPush };
