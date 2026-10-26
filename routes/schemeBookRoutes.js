const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const { uploadSchemeBookFile } = require("../middleware/upload");
const schemeBookController = require("../controllers/schemeBookController");

const router = express.Router();
const REVIEWER_ROLES = ["teacher_in_charge", "deputy_head", "head"];

router.post(
  "/",
  authenticate,
  uploadSchemeBookFile,
  schemeBookController.createSchemeBook
);

router.get("/mine", authenticate, schemeBookController.getMySchemeBooks);

router.get(
  "/summary",
  authenticate,
  requireRole(...REVIEWER_ROLES),
  schemeBookController.getSummary
);

router.get(
  "/",
  authenticate,
  requireRole(...REVIEWER_ROLES),
  schemeBookController.listSchemeBooks
);

router.put(
  "/:id",
  authenticate,
  uploadSchemeBookFile,
  schemeBookController.updateSchemeBook
);

router.patch(
  "/:id/review",
  authenticate,
  requireRole(...REVIEWER_ROLES),
  schemeBookController.reviewSchemeBook
);

router.delete("/:id", authenticate, schemeBookController.deleteSchemeBook);

module.exports = router;
