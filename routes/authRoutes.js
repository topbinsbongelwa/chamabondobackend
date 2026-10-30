const express = require("express");
const crypto = require("crypto");
const { promisify } = require("util");
const { ObjectId } = require("mongodb");
const { authenticate, signToken } = require("../middleware/auth");

const router = express.Router();

const scryptAsync = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const EC_NUMBER_PATTERN = /^[A-Z0-9]{3,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let ecNumberIndexPromise = null;

function users(req) {
  return req.app.locals.db.collection("users");
}

function normalizeEcNumber(value) {
  return typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
}

function ensureEcNumberIndex(collection) {
  if (!ecNumberIndexPromise) {
    ecNumberIndexPromise = collection
      .createIndex({ ecNumber: 1 }, { unique: true, sparse: true })
      .catch((error) => {
        ecNumberIndexPromise = null;
        throw error;
      });
  }

  return ecNumberIndexPromise;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);

  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string") {
    return false;
  }

  const [algorithm, salt, hash] = storedHash.split("$");

  if (algorithm !== "scrypt" || !salt || !hash) {
    return false;
  }

  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
  const storedBuffer = Buffer.from(hash, "hex");

  return (
    storedBuffer.length === derivedKey.length &&
    crypto.timingSafeEqual(storedBuffer, derivedKey)
  );
}

function displayName(user) {
  const name = [user.firstName, user.surname].filter(Boolean).join(" ");
  return name || user.name || user.ecNumber || "Teacher";
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    firstName: user.firstName || null,
    surname: user.surname || null,
    name: displayName(user),
    fullName: displayName(user),
    ecNumber: user.ecNumber || null,
    phone: user.phone || null,
    department: user.department || null,
    email: user.email || null,
    role: user.role || "teacher",
    plan: user.plan || "free",
    planExpiresAt: user.planExpiresAt || null,
    approved: user.approved !== false,
    createdAt: user.createdAt,
  };
}

function tokenPayload(user) {
  return {
    sub: user._id.toString(),
    ecNumber: user.ecNumber,
    name: displayName(user),
    role: user.role || "teacher",
    department: user.department || null,
    plan: user.plan || "free",
  };
}

function splitName(body) {
  const firstName =
    typeof body.firstName === "string" ? body.firstName.trim() : "";
  const surname = typeof body.surname === "string" ? body.surname.trim() : "";

  if (firstName || surname) {
    return { firstName, surname };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);

  return { firstName: first || "", surname: rest.join(" ") };
}

router.post("/register", async (req, res, next) => {
  try {
    const body = req.body || {};
    const { firstName, surname } = splitName(body);
    const ecNumber = normalizeEcNumber(body.ecNumber);
    const password = typeof body.password === "string" ? body.password : "";

    if (!firstName || !surname || !ecNumber || !password) {
      return res.status(400).json({
        message:
          "firstName, surname, ecNumber and password are required",
      });
    }

    if (!EC_NUMBER_PATTERN.test(ecNumber)) {
      return res
        .status(400)
        .json({ message: "Enter a valid EC number, for example EC12345" });
    }

    if (
      password.length < PASSWORD_MIN_LENGTH ||
      password.length > PASSWORD_MAX_LENGTH
    ) {
      return res.status(400).json({
        message: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
      });
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (email && !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    const collection = users(req);
    await ensureEcNumberIndex(collection);

    const existing = await collection.findOne({ ecNumber });

    if (existing) {
      return res.status(409).json({
        message: "An account with this EC number already exists",
      });
    }

    const now = new Date();
    const document = {
      firstName,
      surname,
      name: `${firstName} ${surname}`.trim(),
      ecNumber,
      email: email || null,
      passwordHash: await hashPassword(password),
      role: "teacher",
      plan: "free",
      department:
        typeof body.department === "string" && body.department.trim()
          ? body.department.trim()
          : null,
      phone:
        typeof body.phone === "string" && body.phone.trim()
          ? body.phone.trim()
          : null,
      approved: true,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    const result = await collection.insertOne(document);
    const user = { ...document, _id: result.insertedId };

    return res.status(201).json({
      token: signToken(tokenPayload(user)),
      user: publicUser(user),
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "An account with this EC number already exists",
      });
    }

    return next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const body = req.body || {};
    const ecNumber = normalizeEcNumber(body.ecNumber);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if ((!ecNumber && !email) || !password) {
      return res
        .status(400)
        .json({ message: "EC number and password are required" });
    }

    const filter = ecNumber ? { ecNumber } : { email };
    const user = await users(req).findOne(filter);

    if (!user) {
      return res
        .status(401)
        .json({ message: "Wrong EC number or password" });
    }

    if (user.active === false) {
      return res.status(401).json({ message: "Account is inactive" });
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);

    if (!passwordMatches) {
      return res
        .status(401)
        .json({ message: "Wrong EC number or password" });
    }

    return res.json({
      token: signToken(tokenPayload(user)),
      user: publicUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", authenticate, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.user.id)) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const user = await users(req).findOne({
      _id: new ObjectId(req.user.id),
    });

    if (!user) {
      return res.status(401).json({ message: "User no longer exists" });
    }

    return res.json({ user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/me", authenticate, async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.user.id)) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const updates = {};
    const body = req.body || {};

    if (Object.hasOwn(body, "email")) {
      const email =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

      if (email && !EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ message: "Invalid email address" });
      }

      updates.email = email || null;
    }

    if (Object.hasOwn(body, "phone")) {
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";

      if (phone && !/^[+0-9() .-]{7,25}$/.test(phone)) {
        return res.status(400).json({ message: "Invalid phone number" });
      }

      updates.phone = phone || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        message: "Provide an email address or phone number to update",
      });
    }

    updates.updatedAt = new Date();

    const userId = new ObjectId(req.user.id);
    const collection = users(req);
    const result = await collection.updateOne(
      { _id: userId },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User no longer exists" });
    }

    const user = await collection.findOne({ _id: userId });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
