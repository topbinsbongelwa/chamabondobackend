const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../middleware/auth");
const admin = require("../controllers/adminController");
const comms = require("../controllers/commsController");

const router = express.Router();
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many admin requests. Try again later." },
});

router.use(authenticate, adminLimiter, requireRole(...admin.ADMIN_ROLES));

router.get("/overview", admin.overview);
router.get("/staff", admin.staffList);
router.get("/staff/:id", admin.staffProfile);
router.get("/attendance/day", admin.attendanceDay);
router.patch("/attendance/:id", admin.correctAttendance);
router.post("/kras/bulk-review", (req, res, next) =>
  admin.bulkReview(req, res, next, "kras")
);
router.post("/schemebooks/bulk-review", (req, res, next) =>
  admin.bulkReview(req, res, next, "schemebooks")
);
router.get("/reports/:type", admin.report);

router.get("/comms/sent", comms.sent);
router.post("/comms", comms.create);
router.get("/comms/:id/rsvps", comms.rsvps);
router.put("/comms/:id", comms.update);
router.delete("/comms/:id", comms.remove);

router.patch("/users/:id/role", requireRole("head"), (req, res, next) =>
  admin.updateUser(req, res, next, "role")
);
router.patch("/users/:id/department", requireRole("head"), (req, res, next) =>
  admin.updateUser(req, res, next, "department")
);
router.patch("/users/:id/status", requireRole("head"), (req, res, next) =>
  admin.updateUser(req, res, next, "active")
);
router.get("/audit", requireRole("head"), admin.audit);

module.exports = router;
