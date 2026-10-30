const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/chamabondo";

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 20,
  retryWrites: true,
});

async function connectDB() {
  try {
    if (!client.topology?.isConnected?.()) {
      await client.connect();
    }

    const db = client.db("chamabondo");
    await db.command({ ping: 1 });

    console.log("MongoDB connected successfully!");
    return db;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }
}

module.exports = { connectDB, client };
