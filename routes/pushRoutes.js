const express = require("express");
const { authenticate } = require("../middleware/auth");
const comms = require("../controllers/commsController");

const router = express.Router();
router.use(authenticate);
router.post("/subscribe", comms.subscribePush);
router.delete("/subscribe", comms.unsubscribePush);

module.exports = router;
