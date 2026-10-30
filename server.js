require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const {
  connectDB,
  ensureIndexes,
  getClient,
  getConnectionError,
  isDbConnected,
} = require("./db");
const { configurePush } = require("./services/pushNotifications");

const app = express();
const PORT = process.env.PORT || 5000;

function normalizeOrigin(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

const allowedOrigins = String(process.env.CLIENT_URL || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

if (!allowedOrigins.length) {
  console.warn(
    "[cors] CLIENT_URL is not set. All origins are allowed until you configure it."
  );
}

const corsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header (curl, health checks, server-to-server)
    // are always allowed.
    if (!origin) return callback(null, true);

    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes("*")) return callback(null, true);

    return callback(null, allowedOrigins.includes(normalizeOrigin(origin)));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions), (req, res) => res.sendStatus(204));
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

try {
  configurePush();
} catch (error) {
  console.warn("[push] Push notifications are not configured:", error.message);
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Chamabondo Teacher Management API is running!",
  });
});

app.get("/api/health", async (req, res) => {
  let connected = isDbConnected();

  if (!connected) {
    try {
      await connectDB();
      connected = true;
    } catch {
      connected = false;
    }
  }

  const error = getConnectionError();
  const reason = connected
    ? undefined
    : error && error.code === "MONGO_URI_MISSING"
      ? "MONGO_URI (or MONGODB_URI) is not set"
      : "Database connection failed";

  return res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "error",
    database: connected ? "connected" : "disconnected",
    reason,
    timestamp: new Date().toISOString(),
  });
});

async function connectDatabaseMiddleware(req, res, next) {
  try {
    const db = await connectDB();

    // Routes read the connection from app.locals at request time.
    app.locals.db = db;
    app.locals.mongoClient = getClient();

    // Do not block the API on index creation. Failures are logged in db.js.
    ensureIndexes(db);

    return next();
  } catch (error) {
    console.error("[db] Database unavailable:", error.message);

    const missing =
      error.code === "MONGO_URI_MISSING" ||
      /MONGO_URI|MONGODB_URI/.test(error.message || "");

    return res.status(503).json({
      status: "error",
      code: missing ? "DATABASE_NOT_CONFIGURED" : "DATABASE_UNAVAILABLE",
      message: missing
        ? "Database is not configured. Set MONGO_URI (or MONGODB_URI) in the backend environment variables."
        : "Could not connect to the database. Please try again.",
      ...(process.env.NODE_ENV !== "production"
        ? { error: error.message }
        : {}),
    });
  }
}

// Every route below this line gets a cached MongoDB connection.
app.use(connectDatabaseMiddleware);

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

  if (res.headersSent) {
    return next(err);
  }

  return res
    .status(err.status || 500)
    .json({ message: err.message || "Server error" });
});

// Local development only. Vercel imports the exported app as a serverless function.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
