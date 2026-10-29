const express = require("express");
const { authenticate } = require("../middleware/auth");
const comms = require("../controllers/commsController");

const router = express.Router();
router.use(authenticate);
router.get("/", comms.notificationList);
router.patch("/:id/read", comms.markNotificationRead);
router.patch("/read-all", comms.markAllNotificationsRead);

module.exports = router;
