require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chamabondo Teacher Management API is running!");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "OK" });
});

// Routes (these read the db from req.app.locals.db at request time)
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));

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

    // One attendance record per teacher per day
    await db
      .collection("attendance")
      .createIndex({ teacherId: 1, date: 1 }, { unique: true });

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
}

startServer();