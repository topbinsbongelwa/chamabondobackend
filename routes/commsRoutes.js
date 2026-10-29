const express = require("express");
const { authenticate } = require("../middleware/auth");
const comms = require("../controllers/commsController");

const router = express.Router();
router.use(authenticate);
router.post("/:id/seen", comms.markSeen);
router.post("/:id/rsvp", comms.rsvp);

module.exports = router;
