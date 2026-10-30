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

const DEFAULT_CLIENT_ORIGINS = [
  "https://chamasattendance-sys.vercel.app",
];

function getAllowedOrigins() {
  const configured = String(process.env.CLIENT_URL || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  const origins = [...DEFAULT_CLIENT_ORIGINS, ...configured];

  if (process.env.NODE_ENV !== "production") {
    origins.push(
      "http://localhost:5173",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:3000"
    );
  }

  return Array.from(new Set(origins));
}

const allowedOrigins = getAllowedOrigins();

if (!process.env.CLIENT_URL && process.env.NODE_ENV === "production") {
  console.warn(
    `[cors] CLIENT_URL is not set. Allowing default origin(s): ${DEFAULT_CLIENT_ORIGINS.join(", ")}`
  );
}

function isLocalDevOrigin(origin) {
  if (process.env.NODE_ENV === "production") return false;

  try {
    const { protocol, hostname } = new URL(origin);

    if (protocol !== "http:" && protocol !== "https:") return false;

    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.includes(normalizeOrigin(origin))) return true;

  // Allow localhost and LAN addresses while developing, including phone testing.
  return isLocalDevOrigin(origin);
}

const corsOptions = {
  origin(origin, callback) {
    return callback(null, isAllowedOrigin(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Disposition"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.set("trust proxy", 1);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin || isAllowedOrigin(origin)) {
    return next();
  }

  console.warn(
    `[cors] Rejected origin: ${origin} (${req.method} ${req.originalUrl})`
  );

  return res.status(403).json({
    status: "error",
    code: "CORS_ORIGIN_NOT_ALLOWED",
    message: `Origin ${origin} is not allowed. Add it to CLIENT_URL on the backend.`,
    allowedOrigins,
  });
});

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

try {
  configurePush();
} catch (error) {
  console.warn("[push] Push notifications are not configured:", error.message);
}

async function connectDatabaseMiddleware(req, res, next) {
  const pathname = req.path.replace(/\/+$/, "") || "/";

  if (pathname === "/" || pathname === "/api/health") {
    return next();
  }

  try {
    const db = await connectDB();

    app.locals.db = db;
    app.locals.mongoClient = getClient();

    ensureIndexes(db);

    return next();
  } catch (error) {
    console.error("[db] Database unavailable:", error.message);

    const missing =
      error.code === "MONGO_URI_MISSING" ||
      /MONGO_URI|MONGODB_URI/.test(error.message || "");

    return res.status(missing ? 500 : 503).json({
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

app.use(connectDatabaseMiddleware);

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
    db: connected ? "connected" : "disconnected",
    database: connected ? "connected" : "disconnected",
    corsOrigins: allowedOrigins,
    ...(reason ? { reason } : {}),
    timestamp: new Date().toISOString(),
  });
});

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

app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(err.status || 500).json({
    status: "error",
    ...(err.code ? { code: err.code } : {}),
    message: err.message || "Server error",
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
