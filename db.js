const { MongoClient } = require("mongodb");

const DB_NAME =
  process.env.MONGODB_DB || process.env.MONGO_DB || "chamabondo";

let client = null;
let db = null;
let connectionPromise = null;
let indexesPromise = null;
let lastError = null;

function getMongoUri() {
  return (process.env.MONGO_URI || process.env.MONGODB_URI || "").trim();
}

function getDb() {
  return db;
}

function getClient() {
  return client;
}

function isDbConnected() {
  return Boolean(db);
}

function getConnectionError() {
  return lastError;
}

async function connectDB() {
  if (db) return db;
  if (connectionPromise) return connectionPromise;

  const uri = getMongoUri();

  if (!uri) {
    const error = new Error(
      "MONGO_URI (or MONGODB_URI) is not set. Add it to the backend environment variables."
    );
    error.code = "MONGO_URI_MISSING";
    lastError = error;
    throw error;
  }

  const candidate = new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  connectionPromise = (async () => {
    try {
      await candidate.connect();
      const database = candidate.db(DB_NAME);
      await database.command({ ping: 1 });

      client = candidate;
      db = database;
      lastError = null;

      console.log(`[db] Connected to MongoDB database "${DB_NAME}"`);
      return db;
    } catch (error) {
      lastError = error;
      client = null;
      db = null;

      try {
        await candidate.close();
      } catch {
        // Ignore close errors while reporting the original connection failure.
      }

      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

async function createIndexes(database) {
  await database
    .collection("users")
    .createIndex({ role: 1, department: 1, active: 1 });

  // One attendance record per teacher per day
  await database
    .collection("attendance")
    .createIndex({ teacherId: 1, date: 1 }, { unique: true });
  await database.collection("attendance").createIndex({ date: 1, status: 1 });

  // Calendar visibility, range and feed queries
  const calendar = database.collection("calendar");
  await calendar.createIndex({ startDate: 1 });
  await calendar.createIndex({ endDate: 1 });
  await calendar.createIndex({ type: 1 });
  await calendar.createIndex({ audience: 1, department: 1 });
  await calendar.createIndex({ type: 1, startDate: 1 });
  await calendar.createIndex({ pinned: -1, createdAt: -1 });
  await calendar.createIndex({ expiresAt: 1 });
  await calendar.createIndex({ "assignedTeachers.teacherId": 1 });
  await calendar.createIndex({
    isCommunication: 1,
    published: 1,
    scheduledAt: 1,
  });
  await calendar.createIndex({ "createdBy.id": 1, createdAt: -1 });

  await database.collection("audit_log").createIndex({ createdAt: -1 });
  await database
    .collection("audit_log")
    .createIndex({ actorId: 1, createdAt: -1 });
  await database
    .collection("notifications")
    .createIndex({ userId: 1, createdAt: -1 });
  await database
    .collection("notifications")
    .createIndex({ userId: 1, readAt: 1 });
  await database.collection("notifications").createIndex(
    { userId: 1, sourceId: 1, type: 1 },
    { unique: true, partialFilterExpression: { sourceId: { $type: "objectId" } } }
  );
  await database
    .collection("push_subscriptions")
    .createIndex({ userId: 1, endpoint: 1 }, { unique: true });

  const aiChats = database.collection("ai_chats");
  await aiChats.createIndex({ userId: 1, updatedAt: -1 });
  await aiChats.createIndex(
    { shareToken: 1 },
    {
      unique: true,
      partialFilterExpression: { shareToken: { $type: "string" } },
    }
  );
  await database
    .collection("ai_messages")
    .createIndex({ chatId: 1, createdAt: 1 });
  await database
    .collection("ai_projects")
    .createIndex({ userId: 1, createdAt: -1 });
  await database
    .collection("ai_settings")
    .createIndex({ userId: 1 }, { unique: true });
  await database
    .collection("ai_usage")
    .createIndex({ userId: 1, date: 1 }, { unique: true });

  // Scheme book lookups and duplicate protection
  const schemeBooks = database.collection("schemebooks");
  await schemeBooks.createIndex({ teacherId: 1 });
  await schemeBooks.createIndex({ status: 1 });
  await schemeBooks.createIndex(
    {
      teacherId: 1,
      subject: 1,
      grade: 1,
      term: 1,
      year: 1,
      weekFrom: 1,
      weekTo: 1,
    },
    { unique: true, name: "unique_teacher_scheme_book" }
  );
}

function ensureIndexes(database) {
  if (indexesPromise) return indexesPromise;

  indexesPromise = createIndexes(database).catch((error) => {
    // Index creation must never block logins or other API requests.
    console.error("[db] Index setup failed:", error.message);
    return null;
  });

  return indexesPromise;
}

module.exports = {
  connectDB,
  ensureIndexes,
  getClient,
  getConnectionError,
  getDb,
  isDbConnected,
};
