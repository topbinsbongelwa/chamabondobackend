const cron = require("node-cron");
const {
  HARARE_TIME_ZONE,
  TEACHER_ROLES,
  todayDateKey,
} = require("../utils/attendance");

const CRON_EXPRESSION = "0 17 * * 1-5";

function autoAbsentEnabled() {
  return String(process.env.AUTO_ABSENT || "").toLowerCase() === "true";
}

async function markAbsent(db, date = todayDateKey()) {
  const attendance = db.collection("attendance");
  const users = db.collection("users");

  const holiday = await attendance.findOne(
    { date, status: "Holiday" },
    { projection: { _id: 1 } }
  );

  if (holiday) {
    return { date, inserted: 0, skipped: true, reason: "holiday" };
  }

  const [teachers, existingIds] = await Promise.all([
    users
      .find(
        {
          role: { $in: TEACHER_ROLES },
          approved: { $ne: false },
        },
        { projection: { _id: 1 } }
      )
      .toArray(),
    attendance.distinct("teacherId", { date }),
  ]);

  const existing = new Set(existingIds.map((id) => String(id)));
  const now = new Date();
  const documents = teachers
    .filter((teacher) => !existing.has(String(teacher._id)))
    .map((teacher) => ({
      teacherId: teacher._id,
      date,
      shift: "morning",
      checkIn: null,
      checkOut: null,
      status: "Absent",
      notes: "",
      createdAt: now,
      updatedAt: now,
    }));

  if (!documents.length) {
    return { date, inserted: 0, skipped: false };
  }

  try {
    const result = await attendance.insertMany(documents, {
      ordered: false,
    });

    return { date, inserted: result.insertedCount, skipped: false };
  } catch (error) {
    if (error.code === 11000 || Array.isArray(error.writeErrors)) {
      const writeErrors = error.writeErrors || [];
      const inserted =
        error.result?.insertedCount ??
        error.insertedCount ??
        documents.length - writeErrors.length;

      return {
        date,
        inserted,
        skipped: false,
        duplicates: writeErrors.length,
      };
    }

    throw error;
  }
}

function startAutoAbsentJob(db) {
  if (!autoAbsentEnabled()) {
    console.log(
      "[auto-absent] Disabled. Set AUTO_ABSENT=true to enable the weekday 17:00 job."
    );
    return null;
  }

  const task = cron.schedule(
    CRON_EXPRESSION,
    async () => {
      try {
        const result = await markAbsent(db);

        if (result.skipped) {
          console.log(
            `[auto-absent] ${result.date} skipped (${result.reason}).`
          );
          return;
        }

        console.log(
          `[auto-absent] ${result.date}: inserted ${result.inserted} absent record(s).`
        );
      } catch (error) {
        console.error(`[auto-absent] ${todayDateKey()} failed:`, error);
      }
    },
    { timezone: HARARE_TIME_ZONE }
  );

  console.log(
    `[auto-absent] Scheduled weekdays at 17:00 ${HARARE_TIME_ZONE}.`
  );

  return task;
}

module.exports = {
  markAbsent,
  startAutoAbsentJob,
};
