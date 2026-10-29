const { ObjectId } = require("mongodb");
const { TEACHER_ROLES } = require("./attendance");

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

function getScopeFilter(user) {
  if (user?.role === "teacher_in_charge") {
    return { department: user.department || null };
  }

  return {};
}

function parseObjectId(value) {
  if (typeof value !== "string" || !OBJECT_ID_PATTERN.test(value.trim())) {
    return null;
  }

  return new ObjectId(value.trim());
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactInsensitive(value) {
  return { $regex: `^${escapeRegex(value)}$`, $options: "i" };
}

async function getScopedStaff(db, user, extraFilter = {}) {
  const scopeFilter = getScopeFilter(user);
  if (user?.role === "teacher_in_charge" && !user.department) {
    return [];
  }

  return db
    .collection("users")
    .find({
      ...scopeFilter,
      ...extraFilter,
      role: { $in: TEACHER_ROLES },
    })
    .toArray();
}

function idsForRecords(staff) {
  return staff.flatMap((person) => [
    person._id,
    person._id.toString(),
  ]);
}

async function ownsDepartment(db, user, record) {
  if (user?.role !== "teacher_in_charge") {
    return true;
  }

  if (!user.department || !record) {
    return false;
  }

  const teacherId = record.teacherId ?? record.userId;
  const teacherObjectId =
    teacherId instanceof ObjectId
      ? teacherId
      : parseObjectId(String(teacherId || ""));
  if (teacherObjectId) {
    const teacher = await db.collection("users").findOne(
      { _id: teacherObjectId, ...getScopeFilter(user) },
      { projection: { _id: 1 } }
    );
    return Boolean(teacher);
  }

  return (
    typeof record.department === "string" &&
    record.department.trim().toLowerCase() ===
      user.department.trim().toLowerCase()
  );
}

module.exports = {
  exactInsensitive,
  getScopeFilter,
  getScopedStaff,
  idsForRecords,
  ownsDepartment,
  parseObjectId,
};
