const test = require("node:test");
const assert = require("node:assert/strict");
const { getScopeFilter } = require("../utils/adminScope");

test("teacher in charge is scoped to exactly their department", () => {
  assert.deepEqual(
    getScopeFilter({ role: "teacher_in_charge", department: "ECD" }),
    { department: "ECD" }
  );
});

test("leadership roles have a school-wide scope", () => {
  assert.deepEqual(getScopeFilter({ role: "deputy_head", department: "ECD" }), {});
  assert.deepEqual(getScopeFilter({ role: "head", department: "ECD" }), {});
});

test("a teacher-in-charge without a department receives an empty-match scope", () => {
  assert.deepEqual(getScopeFilter({ role: "teacher_in_charge" }), { department: null });
});
