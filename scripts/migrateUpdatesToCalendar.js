require("dotenv").config();

const { MongoClient, ObjectId } = require("mongodb");
const {
  isValidTime,
  normalizeCalendarCategory,
  normalizeCalendarPriority,
  toCalendarDateKey,
} = require("../utils/calendar");

const SOURCE_COLLECTION = process.env.UPDATES_COLLECTION || "updates";
const TARGET_COLLECTION = "calendar";
const APPLY = process.argv.includes("--apply");
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/*
  Adjust these field names if your old "updates" documents use different keys.
  The first key found in each list is used.
*/
const FIELDS = {
  title: ["title"],
  description: ["body", "description"],
  startDate: ["date", "startDate", "eventDate"],
  endDate: ["endDate"],
  startTime: ["startTime"],
  endTime: ["endTime"],
  allDay: ["allDay"],
  venue: ["venue"],
  audience: ["audience", "target"],
  department: ["department"],
  assignedTeachers: ["assignedTeachers", "teachers"],
  priority: ["priority"],
  pinned: ["pinned"],
  expiresAt: ["expiresAt"],
  category: ["category"],
  author: ["author"],
  authorId: ["authorId", "createdById"],
  authorName: ["authorName", "createdByName"],
  authorRole: ["authorRole", "createdByRole"],
  createdAt: ["createdAt"],
  updatedAt: ["updatedAt"],
};

const CATEGORY_ALIASES = {
  general: "Other",
  event: "Other",
  meeting: "Meeting",
  sports: "Sports",
  academic: "Academic",
  cultural: "Cultural",
  other: "Other",
};

function firstValue(document, fields) {
  for (const field of fields) {
    if (document[field] !== undefined && document[field] !== null) {
      return document[field];
    }
  }

  return undefined;
}

function toObjectId(value) {
  if (value instanceof ObjectId) {
    return value;
  }

  if (
    typeof value === "string" &&
    OBJECT_ID_PATTERN.test(value.trim())
  ) {
    return new ObjectId(value.trim());
  }

  return null;
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function timeValue(value) {
  return isValidTime(value) ? value.trim() : null;
}

function migrateCreatedBy(document) {
  const author = firstValue(document, FIELDS.author);
  let id = null;
  let name = "";
  let role = "";

  if (author instanceof ObjectId) {
    id = author;
  } else if (author && typeof author === "object") {
    id = toObjectId(
      author.id ?? author._id ?? author.userId
    );
    name =
      author.name ??
      author.fullName ??
      author.authorName ??
      "";
    role = author.role ?? "";
  } else if (typeof author === "string") {
    name = author;
  }

  if (!id) {
    id = toObjectId(firstValue(document, FIELDS.authorId));
  }

  if (!name) {
    const authorName = firstValue(document, FIELDS.authorName);

    if (typeof authorName === "string") {
      name = authorName;
    }
  }

  if (!role) {
    const authorRole = firstValue(document, FIELDS.authorRole);

    if (typeof authorRole === "string") {
      role = authorRole;
    }
  }

  return {
    id,
    name:
      typeof name === "string" && name.trim()
        ? name.trim()
        : "Migrated author",
    role:
      typeof role === "string" && role.trim()
        ? role.trim().toLowerCase()
        : "teacher",
  };
}

function migrateAudience(document) {
  const rawAudience = firstValue(document, FIELDS.audience);
  const rawDepartment = firstValue(document, FIELDS.department);
  const department =
    typeof rawDepartment === "string"
      ? rawDepartment.trim()
      : "";

  if (
    typeof rawAudience === "string" &&
    rawAudience.trim().toLowerCase() === "department" &&
    department
  ) {
    return { audience: "department", department };
  }

  return { audience: "all", department: null };
}

function migrateAssignedTeachers(document) {
  const value = firstValue(document, FIELDS.assignedTeachers);

  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const teachers = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const teacherId = toObjectId(
      entry.teacherId ?? entry.id ?? entry._id
    );

    if (!teacherId || seen.has(teacherId.toString())) {
      continue;
    }

    seen.add(teacherId.toString());
    teachers.push({
      teacherId,
      teacherName:
        typeof entry.teacherName === "string" &&
        entry.teacherName.trim()
          ? entry.teacherName.trim()
          : "Teacher",
    });
  }

  return teachers;
}

function migrateCategory(document) {
  const value = firstValue(document, FIELDS.category);

  if (typeof value !== "string") {
    return null;
  }

  return (
    normalizeCalendarCategory(value) ||
    CATEGORY_ALIASES[value.trim().toLowerCase()] ||
    null
  );
}

function buildDocument(document, now) {
  const startDate = toCalendarDateKey(
    firstValue(document, FIELDS.startDate)
  );

  if (!startDate) {
    return {
      error: "missing or invalid start date",
    };
  }

  let endDate =
    toCalendarDateKey(firstValue(document, FIELDS.endDate)) ||
    startDate;

  if (endDate < startDate) {
    endDate = startDate;
  }

  const rawTitle = firstValue(document, FIELDS.title);
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? rawTitle.trim().slice(0, 160)
      : "Untitled update";
  const rawDescription = firstValue(
    document,
    FIELDS.description
  );
  const description =
    typeof rawDescription === "string"
      ? rawDescription.trim().slice(0, 4000)
      : "";
  const rawVenue = firstValue(document, FIELDS.venue);
  const venue =
    typeof rawVenue === "string" && rawVenue.trim()
      ? rawVenue.trim().slice(0, 200)
      : null;
  const audience = migrateAudience(document);
  const priority =
    normalizeCalendarPriority(
      firstValue(document, FIELDS.priority)
    ) || "Normal";
  const createdAt =
    asDate(firstValue(document, FIELDS.createdAt)) || now;
  const updatedAt =
    asDate(firstValue(document, FIELDS.updatedAt)) || createdAt;

  return {
    document: {
      type: "Update",
      title,
      description,
      startDate,
      endDate,
      startTime: timeValue(
        firstValue(document, FIELDS.startTime)
      ),
      endTime: timeValue(
        firstValue(document, FIELDS.endTime)
      ),
      allDay:
        firstValue(document, FIELDS.allDay) === true,
      venue,
      audience: audience.audience,
      department: audience.department,
      assignedTeachers: migrateAssignedTeachers(document),
      priority,
      pinned:
        firstValue(document, FIELDS.pinned) === true,
      expiresAt: toCalendarDateKey(
        firstValue(document, FIELDS.expiresAt)
      ),
      category: migrateCategory(document),
      createdBy: migrateCreatedBy(document),
      createdAt,
      updatedAt,
      legacyId: document._id,
    },
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error(
      "MONGODB_URI is missing from your .env file"
    );
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();

    const db = client.db(
      process.env.MONGODB_DB || "chamabondo"
    );
    const source = db.collection(SOURCE_COLLECTION);
    const target = db.collection(TARGET_COLLECTION);

    const total = await source.countDocuments({});
    const existing = new Set(
      (
        await target
          .find(
            { legacyId: { $exists: true } },
            { projection: { legacyId: 1 } }
          )
          .toArray()
      ).map((item) => String(item.legacyId))
    );

    const now = new Date();
    const documents = [];
    let alreadyMigrated = 0;
    let invalid = 0;

    for await (const document of source.find({})) {
      if (
        document._id &&
        existing.has(String(document._id))
      ) {
        alreadyMigrated += 1;
        continue;
      }

      const built = buildDocument(document, now);

      if (built.error) {
        invalid += 1;
        console.warn(
          `Skipped ${document._id}: ${built.error}`
        );
        continue;
      }

      documents.push(built.document);
    }

    console.log(
      `Source "${SOURCE_COLLECTION}": ${total} document(s).`
    );
    console.log(
      `Prepared ${documents.length}, skipped ${alreadyMigrated} already migrated, ${invalid} invalid.`
    );

    if (!APPLY) {
      console.log(
        "Dry run only. Re-run with --apply to insert into calendar."
      );
      return;
    }

    if (documents.length) {
      const result = await target.insertMany(documents, {
        ordered: false,
      });

      console.log(
        `Inserted ${result.insertedCount} document(s) into "${TARGET_COLLECTION}".`
      );
    } else {
      console.log("Nothing to insert.");
    }

    console.log(
      `Source "${SOURCE_COLLECTION}" was not modified.`
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
});
