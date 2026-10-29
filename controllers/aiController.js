const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const {
  storeFile,
  discardUploadedFile,
} = require("../middleware/upload");
const aiProviders = require("../services/aiProviders");

const MAX_MESSAGE_LENGTH = 12000;
const MAX_ATTACHMENTS = 5;
const DEFAULT_SETTINGS = {
  tone: "professional",
  subject: "",
  grade: "",
  language: "English",
  customInstructions: "",
};

function collection(req, name) {
  return req.app.locals.db.collection(name);
}

function parseId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

function idFor(req) {
  return parseId(req.user?.id);
}

function publicDocument(document) {
  if (!document) return document;
  const { _id, userId, ...rest } = document;
  return { id: _id.toString(), ...rest };
}

function cleanString(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== "string") {
    return { error: `${field} must be a string.` };
  }
  const normalized = value.trim();
  if (required && !normalized) {
    return { error: `${field} is required.` };
  }
  if (normalized.length > maxLength) {
    return { error: `${field} must be at most ${maxLength} characters.` };
  }
  return { value: normalized };
}

function validateAttachments(value) {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    return { error: `attachments must be an array of at most ${MAX_ATTACHMENTS} items.` };
  }

  const attachments = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object") {
      return { error: "Each attachment must be an object." };
    }
    for (const field of ["name", "url", "type"]) {
      if (
        typeof attachment[field] !== "string" ||
        !attachment[field].trim() ||
        attachment[field].length > 1000
      ) {
        return { error: `Each attachment must include a valid ${field}.` };
      }
    }
    attachments.push({
      name: attachment.name.trim().slice(0, 200),
      url: attachment.url.trim(),
      type: attachment.type.trim().slice(0, 200),
    });
  }
  return { value: attachments };
}

function validTools(value) {
  if (value === undefined) return { webSearch: false, plugins: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const webSearch = value.webSearch ?? false;
  const plugins = value.plugins ?? [];
  if (
    typeof webSearch !== "boolean" ||
    !Array.isArray(plugins) ||
    plugins.length > 20 ||
    plugins.some((plugin) => typeof plugin !== "string" || plugin.length > 100)
  ) {
    return null;
  }
  return { webSearch, plugins };
}

function messageLimit() {
  const value = Number.parseInt(process.env.FREE_DAILY_LIMIT || "10", 10);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

async function reserveFreeMessage(req, userId) {
  const date = utcDate();
  const usage = collection(req, "ai_usage");
  try {
    await usage.updateOne(
      { userId, date },
      { $setOnInsert: { messageCount: 0, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  const result = await usage.updateOne(
    { userId, date, messageCount: { $lt: messageLimit() } },
    { $inc: { messageCount: 1 } }
  );
  return result.matchedCount === 1;
}

async function activePlan(req, userId) {
  const user = await collection(req, "users").findOne(
    { _id: userId },
    { projection: { plan: 1, planExpiresAt: 1 } }
  );
  if (!user) return null;

  const expiration = user.planExpiresAt
    ? new Date(user.planExpiresAt)
    : null;
  return user.plan === "pro" && (!expiration || expiration > new Date())
    ? "pro"
    : "free";
}

function validIdResponse(req, res) {
  const userId = idFor(req);
  if (userId) return userId;
  res.status(401).json({ message: "Invalid user identity." });
  return null;
}

function makeChatTitle(message) {
  return message.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
}

function chatResponse(chat) {
  const result = publicDocument(chat);
  if (result.projectId instanceof ObjectId) {
    result.projectId = result.projectId.toString();
  }
  return result;
}

function messageResponse(message, { hideUserId = false } = {}) {
  const { _id, userId, chatId, ...rest } = message;
  const result = { id: _id.toString(), ...rest };
  if (!hideUserId) {
    result.chatId = chatId.toString();
  }
  return result;
}

async function requirePro(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  try {
    const plan = await activePlan(req, userId);
    if (!plan) {
      return res.status(401).json({ message: "User account was not found." });
    }
    if (plan !== "pro") {
      return res.status(402).json({ message: "Upgrade required" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function listChats(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  try {
    const chats = await collection(req, "ai_chats")
      .find({ userId })
      .sort({ pinned: -1, updatedAt: -1 })
      .limit(100)
      .toArray();
    return res.json({ chats: chats.map(chatResponse) });
  } catch (error) {
    return next(error);
  }
}

async function createChat(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const title = req.body?.title === undefined
    ? "New chat"
    : cleanString(req.body.title, "title", 120, { required: true });
  if (title?.error) return res.status(400).json({ message: title.error });

  let projectId = null;
  if (req.body?.projectId !== undefined && req.body.projectId !== null) {
    projectId = parseId(req.body.projectId);
    if (!projectId) {
      return res.status(400).json({ message: "projectId must be a valid id." });
    }
    const project = await collection(req, "ai_projects").findOne({
      _id: projectId,
      userId,
    });
    if (!project) {
      return res.status(404).json({ message: "Project not found." });
    }
  }

  try {
    const now = new Date();
    const chat = {
      userId,
      title: typeof title === "string" ? title : title.value,
      projectId,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      shareToken: null,
    };
    const result = await collection(req, "ai_chats").insertOne(chat);
    return res.status(201).json({
      chat: chatResponse({ ...chat, _id: result.insertedId }),
    });
  } catch (error) {
    return next(error);
  }
}

async function getChat(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const chatId = parseId(req.params.id);
  if (!chatId) return res.status(400).json({ message: "Invalid chat id." });

  try {
    const chat = await collection(req, "ai_chats").findOne({
      _id: chatId,
      userId,
    });
    if (!chat) return res.status(404).json({ message: "Chat not found." });
    const messages = await collection(req, "ai_messages")
      .find({ chatId, userId })
      .sort({ createdAt: 1 })
      .toArray();
    return res.json({
      chat: chatResponse(chat),
      messages: messages.map((message) => messageResponse(message)),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateChat(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const chatId = parseId(req.params.id);
  if (!chatId) return res.status(400).json({ message: "Invalid chat id." });

  const updates = {};
  const body = req.body || {};
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);
  if (has("title")) {
    const value = cleanString(body.title, "title", 120, { required: true });
    if (value.error) return res.status(400).json({ message: value.error });
    updates.title = value.value;
  }
  if (has("pinned")) {
    if (typeof body.pinned !== "boolean") {
      return res.status(400).json({ message: "pinned must be a boolean." });
    }
    updates.pinned = body.pinned;
  }
  if (has("projectId")) {
    if (body.projectId === null) {
      updates.projectId = null;
    } else {
      const projectId = parseId(body.projectId);
      if (!projectId) {
        return res.status(400).json({ message: "projectId must be a valid id or null." });
      }
      const project = await collection(req, "ai_projects").findOne({
        _id: projectId,
        userId,
      });
      if (!project) {
        return res.status(404).json({ message: "Project not found." });
      }
      updates.projectId = projectId;
    }
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ message: "Provide title, pinned or projectId to update." });
  }

  try {
    updates.updatedAt = new Date();
    const result = await collection(req, "ai_chats").findOneAndUpdate(
      { _id: chatId, userId },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Chat not found." });
    return res.json({ chat: chatResponse(result) });
  } catch (error) {
    return next(error);
  }
}

async function deleteChat(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const chatId = parseId(req.params.id);
  if (!chatId) return res.status(400).json({ message: "Invalid chat id." });

  try {
    const result = await collection(req, "ai_chats").deleteOne({
      _id: chatId,
      userId,
    });
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Chat not found." });
    }
    await collection(req, "ai_messages").deleteMany({ chatId, userId });
    return res.json({ message: "Chat deleted." });
  } catch (error) {
    return next(error);
  }
}

async function listProjects(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  try {
    const projects = await collection(req, "ai_projects")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ projects: projects.map(publicDocument) });
  } catch (error) {
    return next(error);
  }
}

function parseProject(body, base = {}) {
  const result = {};
  const fields = [
    ["name", 120, true],
    ["description", 2000, false],
    ["instructions", 5000, false],
  ];
  for (const [field, maxLength, required] of fields) {
    const value = body[field] === undefined ? base[field] : body[field];
    if (value === undefined && !required) {
      result[field] = "";
      continue;
    }
    const parsed = cleanString(value, field, maxLength, { required });
    if (parsed.error) return { error: parsed.error };
    result[field] = parsed.value;
  }
  return { value: result };
}

async function createProject(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const parsed = parseProject(req.body || {});
  if (parsed.error) return res.status(400).json({ message: parsed.error });
  try {
    const project = {
      userId,
      ...parsed.value,
      createdAt: new Date(),
    };
    const result = await collection(req, "ai_projects").insertOne(project);
    return res.status(201).json({
      project: publicDocument({ ...project, _id: result.insertedId }),
    });
  } catch (error) {
    return next(error);
  }
}

async function updateProject(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const projectId = parseId(req.params.id);
  if (!projectId) return res.status(400).json({ message: "Invalid project id." });
  try {
    const existing = await collection(req, "ai_projects").findOne({
      _id: projectId,
      userId,
    });
    if (!existing) return res.status(404).json({ message: "Project not found." });
    const parsed = parseProject(req.body || {}, existing);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const result = await collection(req, "ai_projects").findOneAndUpdate(
      { _id: projectId, userId },
      { $set: parsed.value },
      { returnDocument: "after" }
    );
    return res.json({ project: publicDocument(result) });
  } catch (error) {
    return next(error);
  }
}

async function deleteProject(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const projectId = parseId(req.params.id);
  if (!projectId) return res.status(400).json({ message: "Invalid project id." });
  try {
    const result = await collection(req, "ai_projects").deleteOne({
      _id: projectId,
      userId,
    });
    if (!result.deletedCount) {
      return res.status(404).json({ message: "Project not found." });
    }
    await collection(req, "ai_chats").updateMany(
      { userId, projectId },
      { $set: { projectId: null, updatedAt: new Date() } }
    );
    return res.json({ message: "Project deleted." });
  } catch (error) {
    return next(error);
  }
}

async function getSettings(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  try {
    const settings = await collection(req, "ai_settings").findOne({ userId });
    return res.json({
      settings: settings
        ? { ...DEFAULT_SETTINGS, ...publicDocument(settings) }
        : DEFAULT_SETTINGS,
    });
  } catch (error) {
    return next(error);
  }
}

async function updateSettings(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const fields = {
    tone: 80,
    subject: 120,
    grade: 80,
    language: 80,
    customInstructions: 3000,
  };
  const updates = {};
  for (const [field, maxLength] of Object.entries(fields)) {
    if (req.body?.[field] === undefined) continue;
    const value = cleanString(req.body[field], field, maxLength);
    if (value.error) return res.status(400).json({ message: value.error });
    updates[field] = value.value;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ message: "Provide at least one setting to update." });
  }
  try {
    const result = await collection(req, "ai_settings").findOneAndUpdate(
      { userId },
      {
        $set: updates,
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" }
    );
    return res.json({ settings: publicDocument(result) });
  } catch (error) {
    return next(error);
  }
}

async function streamChat(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const body = req.body || {};
  const messageResult = cleanString(body.message, "message", MAX_MESSAGE_LENGTH, {
    required: true,
  });
  if (messageResult.error) {
    return res.status(400).json({ message: messageResult.error });
  }
  const message = messageResult.value;
  const attachmentResult = validateAttachments(body.attachments);
  if (attachmentResult.error) {
    return res.status(400).json({ message: attachmentResult.error });
  }
  const tools = validTools(body.tools);
  if (!tools) {
    return res.status(400).json({ message: "tools must include a boolean webSearch and a plugins array." });
  }
  if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 120)) {
    return res.status(400).json({ message: "model must be a string of at most 120 characters." });
  }
  if (body.page !== undefined) {
    try {
      if (!body.page || typeof body.page !== "object" || Array.isArray(body.page) ||
        JSON.stringify(body.page).length > 10000) {
        return res.status(400).json({ message: "page must be an object no larger than 10 KB." });
      }
    } catch {
      return res.status(400).json({ message: "page must be valid JSON." });
    }
  }

  let chatId = null;
  if (body.chatId !== undefined) {
    chatId = parseId(body.chatId);
    // A stale client-side ID starts a fresh chat; only valid IDs are looked up.
  }

  try {
    const plan = await activePlan(req, userId);
    if (!plan) return res.status(401).json({ message: "User account was not found." });
    const chats = collection(req, "ai_chats");
    let chat = chatId ? await chats.findOne({ _id: chatId, userId }) : null;
    if (chatId && !chat) {
      return res.status(404).json({ message: "Chat not found." });
    }
    if (plan === "free" && !(await reserveFreeMessage(req, userId))) {
      return res.status(429).json({
        message: `Daily free message limit reached (${messageLimit()} messages). Upgrade to Pro to continue.`,
      });
    }

    const now = new Date();
    if (!chat) {
      chat = {
        userId,
        title: makeChatTitle(message),
        projectId: null,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        shareToken: null,
      };
      const inserted = await chats.insertOne(chat);
      chatId = inserted.insertedId;
      chat._id = chatId;
    }

    const messageDocument = {
      chatId,
      userId,
      role: "user",
      content: message,
      attachments: attachmentResult.value,
      tools,
      createdAt: now,
    };
    await collection(req, "ai_messages").insertOne(messageDocument);
    await chats.updateOne({ _id: chatId, userId }, { $set: { updatedAt: now } });

    const historyLimit = Math.max(
      1,
      Math.min(50, Number.parseInt(process.env.AI_HISTORY_LIMIT || "20", 10) || 20)
    );
    const history = await collection(req, "ai_messages")
      .find({ chatId, userId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(historyLimit)
      .toArray();
    history.reverse();

    const [settings, project] = await Promise.all([
      collection(req, "ai_settings").findOne({ userId }),
      chat.projectId
        ? collection(req, "ai_projects").findOne({ _id: chat.projectId, userId })
        : Promise.resolve(null),
    ]);
    const systemPrompt = [
      process.env.INTELLI_AI_SYSTEM_PROMPT ||
        "You are Intelli AI, an education assistant. Provide accurate, age-appropriate teaching support.",
      settings?.tone ? `Tone: ${settings.tone}` : null,
      settings?.subject ? `Subject: ${settings.subject}` : null,
      settings?.grade ? `Grade: ${settings.grade}` : null,
      settings?.language ? `Language: ${settings.language}` : null,
      settings?.customInstructions,
      project?.instructions ? `Project instructions: ${project.instructions}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const providerPayload = {
      model: body.model || undefined,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((item) => ({
          role: item.role,
          content: item.content,
          ...(item.attachments?.length ? { attachments: item.attachments } : {}),
        })),
      ],
      tools,
      ...(body.page ? { page: body.page } : {}),
    };

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });
    const sendEvent = (event) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    sendEvent({ type: "chat", chatId: chatId.toString() });

    const answer = await aiProviders.postChat(providerPayload, {
      signal: abortController.signal,
      onStatus: (text) => sendEvent({ type: "status", text }),
      onToken: (text) => sendEvent({ type: "token", text }),
    });
    if (abortController.signal.aborted) return;
    if (!answer.trim()) {
      throw new Error("Intelli AI returned an empty answer.");
    }
    await collection(req, "ai_messages").insertOne({
      chatId,
      userId,
      role: "assistant",
      content: answer,
      attachments: [],
      tools: [],
      createdAt: new Date(),
    });
    await chats.updateOne(
      { _id: chatId, userId },
      { $set: { updatedAt: new Date() } }
    );
    sendEvent({ type: "done" });
    return res.end();
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) {
        const message =
          /^(Intelli AI|OpenAI|Google Gemini|Anthropic Claude)\b/.test(error.message)
          ? error.message
          : "Unable to complete the AI response.";
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.end();
      }
      return;
    }
    if (/^(Intelli AI|OpenAI|Google Gemini|Anthropic Claude)\b/.test(error.message)) {
      return res.status(502).json({ message: error.message });
    }
    return next(error);
  }
}

async function models(req, res) {
  return res.json({ models: await aiProviders.fetchModels() });
}

async function plugins(req, res) {
  return res.json({ plugins: await aiProviders.fetchPlugins() });
}

async function upload(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ message: "Select a PDF, DOCX, JPG or PNG file." });
  }
  try {
    const file = await storeFile(req.file);
    return res.status(201).json({
      url: file.url,
      name: file.originalName,
      type: file.mimeType,
    });
  } catch (error) {
    await discardUploadedFile(req.file);
    return next(new Error("Could not store uploaded file."));
  }
}

async function createShare(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const chatId = parseId(req.params.id);
  if (!chatId) return res.status(400).json({ message: "Invalid chat id." });
  try {
    const shareToken = crypto.randomBytes(32).toString("base64url");
    const result = await collection(req, "ai_chats").findOneAndUpdate(
      { _id: chatId, userId },
      { $set: { shareToken } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Chat not found." });
    return res.status(201).json({ shareToken });
  } catch (error) {
    return next(error);
  }
}

async function deleteShare(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  const chatId = parseId(req.params.id);
  if (!chatId) return res.status(400).json({ message: "Invalid chat id." });
  try {
    const result = await collection(req, "ai_chats").updateOne(
      { _id: chatId, userId },
      { $set: { shareToken: null } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ message: "Chat not found." });
    }
    return res.json({ message: "Sharing disabled." });
  } catch (error) {
    return next(error);
  }
}

async function getSharedChat(req, res, next) {
  try {
    const chat = await collection(req, "ai_chats").findOne({
      shareToken: req.params.token,
    });
    if (!chat) return res.status(404).json({ message: "Shared chat not found." });
    const messages = await collection(req, "ai_messages")
      .find({ chatId: chat._id })
      .sort({ createdAt: 1 })
      .toArray();
    return res.json({
      chat: { title: chat.title, createdAt: chat.createdAt },
      messages: messages.map((message) =>
        messageResponse(message, { hideUserId: true })
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function checkout(req, res, next) {
  const userId = validIdResponse(req, res);
  if (!userId) return;
  try {
    const user = await collection(req, "users").findOne(
      { _id: userId },
      { projection: { _id: 1 } }
    );
    if (!user) return res.status(401).json({ message: "User account was not found." });
    return res.status(200).json({
      checkoutUrl: "https://checkout.example.com/placeholder",
      message: "Payment checkout is not configured yet.",
    });
  } catch (error) {
    return next(error);
  }
}

async function generateScheme(req, res) {
  return res.status(501).json({ message: "Coming soon." });
}

module.exports = {
  checkout,
  createChat,
  createProject,
  createShare,
  deleteChat,
  deleteProject,
  deleteShare,
  generateScheme,
  getChat,
  getSettings,
  getSharedChat,
  listChats,
  listProjects,
  models,
  plugins,
  requirePro,
  streamChat,
  updateChat,
  updateProject,
  updateSettings,
  upload,
};
