const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { authenticate } = require("../middleware/auth");
const { uploadAiFile } = require("../middleware/upload");
const aiController = require("../controllers/aiController");

const router = express.Router();
const publicShareLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

router.get("/shared/:token", publicShareLimit, aiController.getSharedChat);

router.use(authenticate);
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number.parseInt(process.env.AI_RATE_LIMIT || "60", 10) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
    message: { message: "Too many AI requests. Please try again later." },
  })
);

router.get("/chats", aiController.listChats);
router.post("/chats", aiController.createChat);
router.get("/chats/:id", aiController.getChat);
router.patch("/chats/:id", aiController.updateChat);
router.delete("/chats/:id", aiController.deleteChat);
router.post("/chats/:id/share", aiController.createShare);
router.delete("/chats/:id/share", aiController.deleteShare);

router.get("/projects", aiController.listProjects);
router.post("/projects", aiController.createProject);
router.patch("/projects/:id", aiController.updateProject);
router.delete("/projects/:id", aiController.deleteProject);

router.get("/settings", aiController.getSettings);
router.put("/settings", aiController.updateSettings);

router.post("/chat/stream", aiController.streamChat);
router.get("/models", aiController.models);
router.get("/plugins", aiController.plugins);
router.post("/upload", uploadAiFile, aiController.upload);

router.post(
  "/scheme/generate",
  aiController.requirePro,
  aiController.generateScheme
);
router.post("/upgrade/checkout", aiController.checkout);

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(500).json({ message: "An unexpected AI service error occurred." });
});

module.exports = router;
