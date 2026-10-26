const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const controller = require("../controllers/calendarController");

const router = express.Router();

router.use(authenticate);

router.post(
  "/",
  requireRole("teacher_in_charge", "deputy_head", "head"),
  controller.create
);

router.get("/", controller.list);
router.get("/upcoming", controller.upcoming);
router.get("/updates", controller.updates);
router.get("/holidays", controller.holidays);
router.get("/summary", controller.summary);

router.get("/:id", controller.getById);
router.put("/:id", controller.update);
router.delete("/:id", controller.remove);

router.patch(
  "/:id/pin",
  requireRole("deputy_head", "head"),
  controller.pin
);

module.exports = router;
