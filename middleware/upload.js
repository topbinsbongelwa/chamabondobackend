const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const STORAGE = String(process.env.STORAGE || "local").trim().toLowerCase();
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

const MIME_BY_EXTENSION = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const ALLOWED_MIME_TYPES = {
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword", "application/vnd.ms-word"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ".jpg": ["image/jpeg", "image/jpg"],
  ".jpeg": ["image/jpeg", "image/jpg"],
  ".png": ["image/png"],
};

const FILE_TYPE_ERROR =
  "Unsupported file type. Upload a PDF, DOC, DOCX, JPG or PNG file.";

if (STORAGE !== "local" && STORAGE !== "cloudinary") {
  throw new Error("STORAGE must be either 'local' or 'cloudinary'");
}

let cloudinary = null;

if (STORAGE === "cloudinary") {
  const required = [
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
  ];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length) {
    throw new Error(
      `STORAGE=cloudinary requires: ${missing.join(", ")}`
    );
  }

  cloudinary = require("cloudinary").v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function allowedMimeType(extension, mimeType) {
  const allowed = ALLOWED_MIME_TYPES[extension];

  if (!allowed) {
    return false;
  }

  const normalized = String(mimeType || "").trim().toLowerCase();

  return (
    !normalized ||
    normalized === "application/octet-stream" ||
    allowed.includes(normalized)
  );
}

function fileFilter(req, file, callback) {
  const extension = path.extname(file.originalname || "").toLowerCase();

  if (!MIME_BY_EXTENSION[extension]) {
    return callback(new Error(FILE_TYPE_ERROR));
  }

  if (!allowedMimeType(extension, file.mimetype)) {
    return callback(new Error(FILE_TYPE_ERROR));
  }

  return callback(null, true);
}

function randomName(extension) {
  return `${crypto.randomBytes(16).toString("hex")}${extension}`;
}

const diskStorage = multer.diskStorage({
  destination(req, file, callback) {
    callback(null, UPLOAD_DIR);
  },
  filename(req, file, callback) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    callback(null, randomName(extension));
  },
});

const upload = multer({
  storage: STORAGE === "cloudinary" ? multer.memoryStorage() : diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 20,
    fieldSize: 10 * 1024,
  },
  fileFilter,
});

function uploadSchemeBookFile(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          message: "File is too large. The maximum size is 10 MB.",
        });
      }

      if (
        error.code === "LIMIT_FILE_COUNT" ||
        error.code === "LIMIT_UNEXPECTED_FILE"
      ) {
        return res.status(400).json({
          message: "Upload one file in the 'file' field.",
        });
      }

      if (
        error.code === "LIMIT_FIELD_COUNT" ||
        error.code === "LIMIT_FIELD_KEY" ||
        error.code === "LIMIT_FIELD_VALUE"
      ) {
        return res.status(400).json({
          message: "Too many or oversized form fields were submitted.",
        });
      }

      return res.status(400).json({ message: error.message });
    }

    return res.status(400).json({
      message: error.message || "Could not process the uploaded file.",
    });
  });
}

const AI_ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".jpg", ".jpeg", ".png"]);
const aiUpload = multer({
  storage: STORAGE === "cloudinary" ? multer.memoryStorage() : diskStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 5,
    fieldSize: 10 * 1024,
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (
      !AI_ALLOWED_EXTENSIONS.has(extension) ||
      !allowedMimeType(extension, file.mimetype)
    ) {
      return callback(
        new Error("Unsupported file type. Upload a PDF, DOCX, JPG or PNG file.")
      );
    }
    return callback(null, true);
  },
});

function uploadAiFile(req, res, next) {
  aiUpload.single("file")(req, res, (error) => {
    if (!error) {
      return next();
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: "File is too large. The maximum size is 10 MB.",
      });
    }
    return res.status(400).json({
      message: error.message || "Could not process the uploaded file.",
    });
  });
}

function uploadToCloudinary(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  const isImage = mimeType.startsWith("image/");
  const resourceType = isImage ? "image" : "raw";
  const publicId = isImage
    ? crypto.randomBytes(16).toString("hex")
    : randomName(extension);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_FOLDER || "schemebooks",
        public_id: publicId,
        resource_type: resourceType,
        overwrite: false,
        secure: true,
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        return resolve(result);
      }
    );

    stream.once("error", reject);
    stream.end(file.buffer);
  });
}

async function storeFile(file) {
  if (!file) {
    return null;
  }

  const extension = path.extname(file.originalname || "").toLowerCase();
  const originalName =
    path.basename(file.originalname || `scheme${extension}`).slice(0, 200) ||
    `scheme${extension}`;
  const mimeType = MIME_BY_EXTENSION[extension];

  if (STORAGE === "cloudinary") {
    const result = await uploadToCloudinary(file);

    return {
      url: result.secure_url,
      originalName,
      mimeType,
      size: file.size,
      storage: "cloudinary",
      publicId: result.public_id,
      resourceType: result.resource_type,
    };
  }

  return {
    url: `/uploads/${file.filename}`,
    originalName,
    mimeType,
    size: file.size,
    storage: "local",
  };
}

async function removeStoredFile(file) {
  if (!file) {
    return;
  }

  const isCloudinary =
    file.storage === "cloudinary" || /^https?:\/\//i.test(file.url || "");

  if (isCloudinary) {
    if (!file.publicId || !cloudinary) {
      return;
    }

    await cloudinary.uploader
      .destroy(file.publicId, {
        resource_type: file.resourceType || "image",
        invalidate: true,
      })
      .catch((error) => {
        console.error("Could not delete Cloudinary file:", error.message);
      });
    return;
  }

  const filename = path.basename(file.url || "");

  if (!filename) {
    return;
  }

  await fs.promises.unlink(path.join(UPLOAD_DIR, filename)).catch((error) => {
    if (error.code !== "ENOENT") {
      console.error("Could not delete local upload:", error.message);
    }
  });
}

async function discardUploadedFile(file) {
  if (!file || !file.path) {
    return;
  }

  await fs.promises.unlink(file.path).catch((error) => {
    if (error.code !== "ENOENT") {
      console.error("Could not remove rejected upload:", error.message);
    }
  });
}

module.exports = {
  MAX_FILE_SIZE,
  STORAGE,
  UPLOAD_DIR,
  storeFile,
  removeStoredFile,
  discardUploadedFile,
  uploadSchemeBookFile,
  uploadAiFile,
};
