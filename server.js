
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chamabondo Teacher Management API is running!");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "OK" });
});

async function startServer() {
  try {
    const db = await connectDB();

    app.locals.db = db;

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
}

startServer();
