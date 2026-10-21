
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing from your .env file");
}

const client = new MongoClient(uri);

async function connectDB() {
  await client.connect();

  const db = client.db("chamabondo");

  await db.command({ ping: 1 });

  console.log("MongoDB connected successfully!");

  return db;
}

module.exports = { connectDB, client };
