const express = require("express");
const Busboy = require("busboy");
const { GridFSBucket, ObjectId } = require("mongodb");
const { authenticate, signToken, verifyToken } = require("../middleware/auth");
const { logAction } = require("../controllers/adminController");

const router = express.Router();
const MAX_DOCUMENT_SIZE = 3 * 1000 * 1000 * 1000;
const DOCUMENT_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
]);
const HEADMASTER_ROLES = new Set([
  "head",
  "headmaster",
  "headmistress",
  "headteacher",
  "principal",
  "schoolhead",
]);

function kras(req) {
  return req.app.locals.db.collection("kras");
}

function documents(req) {
  return new GridFSBucket(req.app.locals.db, { bucketName: "kraDocuments" });
}

function isHeadmaster(req) {
  const role = String(req.user.role || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return HEADMASTER_ROLES.has(role);
}

function headmasterOnly(req, res, next) {
  if (!isHeadmaster(req)) {
    return res.status(403).json({ message: "Headmaster access required" });
  }

  return next();
}

function parseId(value) {
  return typeof value === "string" && ObjectId.isValid(value)
    ? new ObjectId(value)
    : null;
}

function publicKra(kra) {
  return {
    ...kra,
    id: kra._id.toString(),
    _id: undefined,
    teacherId: kra.teacherId?.toString() || null,
    documentId: kra.documentId?.toString() || null,
  };
}

function parseSubmission(req, bucket) {
  return new Promise((resolve, reject) => {
    let parser;

    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 7, fieldSize: 1200, fileSize: MAX_DOCUMENT_SIZE },
      });
    } catch {
      reject(new Error("Submit the KRA as multipart form data."));
      return;
    }

    const fields = {};
    let uploadStream = null;
    let document = null;
    let filePromise = Promise.resolve();
    let parseError = null;

    parser.on("field", (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) {
        parseError = new Error("A submitted field is too long.");
        return;
      }

      fields[name] = value;
    });

    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "document" || uploadStream) {
        parseError = new Error("Only one document may be uploaded.");
        stream.resume();
        return;
      }

      const extension = require("path").extname(info.filename).toLowerCase();
      const contentType = DOCUMENT_TYPES.get(extension);
      const mimeType = String(info.mimeType || "").toLowerCase();

      if (
        !contentType ||
        (mimeType &&
          mimeType !== "application/octet-stream" &&
          mimeType !== contentType)
      ) {
        parseError = new Error("Upload a PDF, DOC, or DOCX document.");
        stream.resume();
        return;
      }

      const filename = require("path")
        .basename(info.filename)
        .replace(/[^\w .()-]/g, "_")
        .slice(0, 180);
      uploadStream = bucket.openUploadStream(filename || `kra${extension}`, {
        contentType,
        metadata: { ownerId: req.user.id },
      });

      const fileId = uploadStream.id;
      document = {
        id: fileId,
        name: filename || `kra${extension}`,
        contentType,
      };

      stream.on("limit", () => {
        parseError = new Error("The document exceeds the 3 GB upload limit.");
        uploadStream.destroy(parseError);
      });

      filePromise = new Promise((resolveFile, rejectFile) => {
        uploadStream.once("finish", resolveFile);
        uploadStream.once("error", rejectFile);
        stream.once("error", rejectFile);
        stream.pipe(uploadStream);
      }).then(async () => {
        const file = await req.app.locals.db
          .collection("kraDocuments.files")
          .findOne({ _id: fileId }, { projection: { length: 1 } });
        if (document && file) document.size = file.length;
      });
    });

    parser.once("filesLimit", () => {
      parseError = new Error("Only one document may be uploaded.");
    });
    parser.once("fieldsLimit", () => {
      parseError = new Error("Too many KRA fields were submitted.");
    });
    parser.once("error", (error) => {
      parseError = error;
    });
    parser.once("finish", async () => {
      try {
        await filePromise;
        if (parseError) throw parseError;
        resolve({ fields, document });
      } catch (error) {
        if (uploadStream) {
          await bucket.delete(uploadStream.id).catch(() => undefined);
        }
        reject(error);
      }
    });

    req.once("error", reject);
    req.pipe(parser);
  });
}

function validateFields(fields) {
  const values = {};

  for (const [field, maxLength] of [
    ["title", 160],
    ["description", 1200],
    ["indicator", 300],
    ["target", 160],
    ["term", 40],
    ["year", 4],
  ]) {
    const value = typeof fields[field] === "string" ? fields[field].trim() : "";
    if (!value || value.length > maxLength) {
      return { error: `${field} is required and must be at most ${maxLength} characters.` };
    }
    values[field] = value;
  }

  if (!/^\d{4}$/.test(values.year)) {
    return { error: "Enter a valid KRA year." };
  }

  const status = fields.status || "draft";
  if (!["draft", "pending"].includes(status)) {
    return { error: "KRA status must be draft or pending." };
  }

  return { values, status };
}

function handleRouteError(res, error) {
  if (error.message === "The document exceeds the 3 GB upload limit.") {
    return res.status(413).json({ message: error.message });
  }
  if (
    error.message.startsWith("Upload ") ||
    error.message.startsWith("Only one") ||
    error.message.startsWith("Too many") ||
    error.message.startsWith("A submitted") ||
    error.message.startsWith("Submit the KRA")
  ) {
    return res.status(400).json({ message: error.message });
  }
  console.error("KRA request failed:", error);
  return res.status(500).json({ message: "Could not save the KRA document." });
}

router.get("/", authenticate, async (req, res, next) => {
  try {
    const teacherId = parseId(req.user.id);
    if (!teacherId) return res.status(401).json({ message: "Invalid token" });

    const items = await kras(req)
      .find({ teacherId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return res.json({ kras: items.map(publicKra) });
  } catch (error) {
    return next(error);
  }
});

router.get("/review", authenticate, headmasterOnly, async (req, res, next) => {
  try {
    const items = await kras(req)
      .find({ status: { $in: ["pending", "approved", "rejected"] } })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return res.json({ kras: items.map(publicKra) });
  } catch (error) {
    return next(error);
  }
});

router.post("/", authenticate, async (req, res) => {
  let uploadedDocument = null;

  try {
    const parsed = await parseSubmission(req, documents(req));
    uploadedDocument = parsed.document;
    const { values, status, error } = validateFields(parsed.fields);

    if (error) {
      if (uploadedDocument) await documents(req).delete(uploadedDocument.id);
      return res.status(400).json({ message: error });
    }
    if (status === "pending" && !uploadedDocument) {
      return res.status(400).json({
        message: "Attach a PDF, DOC, or DOCX document before submitting for review.",
      });
    }

    const teacherId = parseId(req.user.id);
    if (!teacherId) {
      if (uploadedDocument) await documents(req).delete(uploadedDocument.id);
      return res.status(401).json({ message: "Invalid token" });
    }

    const teacher = await req.app.locals.db
      .collection("users")
      .findOne({ _id: teacherId });
    if (!teacher) {
      if (uploadedDocument) await documents(req).delete(uploadedDocument.id);
      return res.status(401).json({ message: "User no longer exists" });
    }

    const now = new Date();
    const kra = {
      ...values,
      progress: 0,
      status,
      reviewerComment: null,
      teacherId,
      teacherName:
        [teacher.firstName, teacher.surname].filter(Boolean).join(" ") ||
        teacher.name ||
        teacher.ecNumber ||
        "Teacher",
      department: teacher.department || null,
      documentId: uploadedDocument?.id || null,
      documentName: uploadedDocument?.name || null,
      documentContentType: uploadedDocument?.contentType || null,
      documentSize: uploadedDocument?.size || null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await kras(req).insertOne(kra);
    return res.status(201).json({ kra: publicKra({ ...kra, _id: result.insertedId }) });
  } catch (error) {
    if (uploadedDocument) await documents(req).delete(uploadedDocument.id).catch(() => undefined);
    return handleRouteError(res, error);
  }
});

router.patch("/:id", authenticate, async (req, res) => {
  let uploadedDocument = null;

  try {
    const id = parseId(req.params.id);
    const teacherId = parseId(req.user.id);
    if (!id || !teacherId) return res.status(400).json({ message: "Invalid KRA id" });

    const collection = kras(req);
    const existing = await collection.findOne({ _id: id });
    if (!existing) return res.status(404).json({ message: "KRA not found" });
    if (!existing.teacherId?.equals(teacherId)) {
      return res.status(403).json({ message: "You cannot update this KRA" });
    }
    if (!["draft", "rejected"].includes(existing.status)) {
      return res.status(409).json({ message: "Only drafts and rejected KRAs can be edited" });
    }

    const parsed = await parseSubmission(req, documents(req));
    uploadedDocument = parsed.document;
    const { values, status, error } = validateFields(parsed.fields);
    if (error) {
      if (uploadedDocument) await documents(req).delete(uploadedDocument.id);
      return res.status(400).json({ message: error });
    }

    const documentId = uploadedDocument?.id || existing.documentId;
    if (status === "pending" && !documentId) {
      return res.status(400).json({
        message: "Attach a PDF, DOC, or DOCX document before submitting for review.",
      });
    }

    const now = new Date();
    const updates = {
      ...values,
      status,
      reviewerComment: status === "pending" ? null : existing.reviewerComment,
      updatedAt: now,
    };
    if (uploadedDocument) {
      updates.documentId = uploadedDocument.id;
      updates.documentName = uploadedDocument.name;
      updates.documentContentType = uploadedDocument.contentType;
      updates.documentSize = uploadedDocument.size;
    }

    await collection.updateOne({ _id: id }, { $set: updates });
    if (uploadedDocument && existing.documentId) {
      await documents(req).delete(existing.documentId).catch(() => undefined);
    }

    return res.json({ kra: publicKra({ ...existing, ...updates, _id: id }) });
  } catch (error) {
    if (uploadedDocument) await documents(req).delete(uploadedDocument.id).catch(() => undefined);
    return handleRouteError(res, error);
  }
});

router.get("/:id/document-link", authenticate, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid KRA id" });

    const kra = await kras(req).findOne({ _id: id });
    if (!kra) return res.status(404).json({ message: "KRA not found" });
    if (
      kra.teacherId?.toString() !== req.user.id &&
      !isHeadmaster(req)
    ) {
      return res.status(403).json({ message: "You cannot view this document" });
    }
    if (!kra.documentId) {
      return res.status(404).json({ message: "No document was attached to this KRA" });
    }

    const token = signToken(
      {
        sub: req.user.id,
        role: req.user.role,
        scope: "kra-document",
        kraId: id.toString(),
      },
      90
    );
    return res.json({
      url: `/api/kras/${id.toString()}/document?token=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    return next(error);
  }
});

function authenticateDocument(req, res, next) {
  if (req.headers.authorization) {
    return authenticate(req, res, next);
  }

  try {
    const claims = verifyToken(req.query.token);
    if (
      claims.scope !== "kra-document" ||
      claims.kraId !== req.params.id
    ) {
      return res.status(401).json({ message: "Invalid document link" });
    }

    req.user = { id: claims.sub, role: claims.role };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired document link" });
  }
}

router.get("/:id/document", authenticateDocument, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid KRA id" });

    const kra = await kras(req).findOne({ _id: id });
    if (!kra) return res.status(404).json({ message: "KRA not found" });
    if (
      kra.teacherId?.toString() !== req.user.id &&
      !isHeadmaster(req)
    ) {
      return res.status(403).json({ message: "You cannot view this document" });
    }
    if (!kra.documentId) {
      return res.status(404).json({ message: "No document was attached to this KRA" });
    }

    const fileId = parseId(kra.documentId.toString());
    const file = await req.app.locals.db
      .collection("kraDocuments.files")
      .findOne({ _id: fileId });
    if (!file) return res.status(404).json({ message: "KRA document not found" });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(kra.documentName || "kra-document").replace(/["\\]/g, "_")}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Length", file.length);
    return documents(req).openDownloadStream(fileId).on("error", next).pipe(res);
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/progress", authenticate, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const teacherId = parseId(req.user.id);
    const progress = Number(req.body?.progress);
    if (!id || !teacherId || !Number.isInteger(progress) || progress < 0 || progress > 100) {
      return res.status(400).json({ message: "Progress must be a whole number from 0 to 100" });
    }

    const result = await kras(req).findOneAndUpdate(
      { _id: id, teacherId },
      { $set: { progress, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "KRA not found" });

    return res.json({ kra: publicKra(result) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/approve", authenticate, headmasterOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid KRA id" });

    const result = await kras(req).findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "approved",
          reviewerComment: null,
          reviewerId: req.user.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Pending KRA not found" });

    await logAction(req, "kra.reviewed", id, {
      status: result.status,
      previousStatus: "pending",
    });
    return res.json({ kra: publicKra(result) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id/reject", authenticate, headmasterOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const comment =
      typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
    if (!id) return res.status(400).json({ message: "Invalid KRA id" });
    if (!comment || comment.length > 1200) {
      return res.status(400).json({ message: "A review comment is required" });
    }

    const result = await kras(req).findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "rejected",
          reviewerComment: comment,
          reviewerId: req.user.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Pending KRA not found" });

    await logAction(req, "kra.reviewed", id, {
      status: result.status,
      previousStatus: "pending",
    });
    return res.json({ kra: publicKra(result) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", authenticate, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const teacherId = parseId(req.user.id);
    if (!id || !teacherId) return res.status(400).json({ message: "Invalid KRA id" });

    const result = await kras(req).findOneAndDelete({
      _id: id,
      teacherId,
      status: "draft",
    });
    if (!result) return res.status(404).json({ message: "Draft KRA not found" });
    if (result.documentId) {
      await documents(req).delete(result.documentId).catch(() => undefined);
    }

    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
