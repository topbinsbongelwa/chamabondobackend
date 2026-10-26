require("dotenv").config();

const { MongoClient } = require("mongodb");

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is missing from your .env file");
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();

    const db = client.db(process.env.MONGODB_DB || "chamabondo");
    const attendance = db.collection("attendance");

    const filter = {
      status: {
        $regex: "^official[ _-]?duty$",
        $options: "i",
      },
    };

    const matched = await attendance.countDocuments(filter);
    const result = await attendance.updateMany(filter, {
      $set: {
        status: "School Duty",
        updatedAt: new Date(),
      },
    });

    console.log(`Matched ${matched} "Official Duty" attendance record(s).`);
    console.log(`Updated ${result.modifiedCount} record(s) to "School Duty".`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
});
