require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { connectDB, client } = require("./db");
const { startAutoAbsentJob } = require("./jobs/autoAbsent");
const { startCommsPublisher } = require("./jobs/publishComms");
const { configurePush } = require("./services/pushNotifications");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
  })
);
app.use(helmet());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.send("Chamabondo Teacher Management API is running!");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "OK" });
});

// Routes (these read the db from req.app.locals.db at request time)
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));
app.use("/api/kras", require("./routes/kraRoutes"));
app.use("/api/announcements", require("./routes/announcementRoutes"));
app.use("/api/calendar", require("./routes/calendarRoutes"));
app.use("/api/schemebooks", require("./routes/schemeBookRoutes"));
app.use("/api/scheme-books", require("./routes/schemeBookRoutes"));
app.use("/api/ai", require("./routes/aiRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/comms", require("./routes/commsRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/push", require("./routes/pushRoutes"));

// 404 for unknown routes
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: err.message || "Server error" });
});

async function startServer() {
  try {
    const db = await connectDB();
    app.locals.db = db;
    app.locals.mongoClient = client;

    await db.collection("users").createIndex({ role: 1, department: 1, active: 1 });

    // One attendance record per teacher per day
    await db
      .collection("attendance")
      .createIndex({ teacherId: 1, date: 1 }, { unique: true });
    await db.collection("attendance").createIndex({ date: 1, status: 1 });

    // Calendar visibility, range and feed queries
    const calendar = db.collection("calendar");
    await calendar.createIndex({ startDate: 1 });
    await calendar.createIndex({ endDate: 1 });
    await calendar.createIndex({ type: 1 });
    await calendar.createIndex({ audience: 1, department: 1 });
    await calendar.createIndex({ type: 1, startDate: 1 });
    await calendar.createIndex({ pinned: -1, createdAt: -1 });
    await calendar.createIndex({ expiresAt: 1 });
    await calendar.createIndex({ "assignedTeachers.teacherId": 1 });
    await calendar.createIndex({ isCommunication: 1, published: 1, scheduledAt: 1 });
    await calendar.createIndex({ "createdBy.id": 1, createdAt: -1 });

    await db.collection("audit_log").createIndex({ createdAt: -1 });
    await db.collection("audit_log").createIndex({ actorId: 1, createdAt: -1 });
    await db.collection("notifications").createIndex({ userId: 1, createdAt: -1 });
    await db.collection("notifications").createIndex({ userId: 1, readAt: 1 });
    await db.collection("notifications").createIndex(
      { userId: 1, sourceId: 1, type: 1 },
      { unique: true, partialFilterExpression: { sourceId: { $type: "objectId" } } }
    );
    await db.collection("push_subscriptions").createIndex(
      { userId: 1, endpoint: 1 },
      { unique: true }
    );

    const aiChats = db.collection("ai_chats");
    await aiChats.createIndex({ userId: 1, updatedAt: -1 });
    await aiChats.createIndex(
      { shareToken: 1 },
      {
        unique: true,
        partialFilterExpression: { shareToken: { $type: "string" } },
      }
    );
    await db.collection("ai_messages").createIndex({ chatId: 1, createdAt: 1 });
    await db.collection("ai_projects").createIndex({ userId: 1, createdAt: -1 });
    await db
      .collection("ai_settings")
      .createIndex({ userId: 1 }, { unique: true });
    await db
      .collection("ai_usage")
      .createIndex({ userId: 1, date: 1 }, { unique: true });

    // Scheme book lookups and duplicate protection
    const schemeBooks = db.collection("schemebooks");
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

    app.locals.autoAbsentJob = startAutoAbsentJob(db);
    app.locals.commsPublisherJob = startCommsPublisher(db);
    configurePush();

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
}

startServer();