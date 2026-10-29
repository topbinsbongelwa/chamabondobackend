const crypto = require("crypto");
const { ObjectId } = require("mongodb");

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL_SECONDS =
  Number(process.env.JWT_EXPIRES_IN_SECONDS) || 60 * 60 * 24 * 7;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is missing from your .env file");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(payload, ttlSeconds = TOKEN_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(
    JSON.stringify({
      ...payload,
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  const data = `${header}.${body}`;
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64url");

  return `${data}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== "string") {
    throw new Error("Missing token");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }

  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const expected = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64url");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature");
  }

  const decodedHeader = JSON.parse(
    Buffer.from(header, "base64url").toString("utf8")
  );

  if (decodedHeader.alg !== "HS256") {
    throw new Error("Unsupported token algorithm");
  }

  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8")
  );

  if (!payload.sub || !payload.exp) {
    throw new Error("Invalid token payload");
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }

  return payload;
}

async function authenticate(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    const message =
      error.message === "Token expired"
        ? "Token expired"
        : "Invalid or expired token";
    return res.status(401).json({ message });
  }

  if (!ObjectId.isValid(payload.sub)) {
    return res.status(401).json({ message: "Invalid token" });
  }

  let user;
  try {
    user = await req.app.locals.db.collection("users").findOne(
      { _id: new ObjectId(payload.sub) },
      {
        projection: {
          name: 1,
          firstName: 1,
          surname: 1,
          email: 1,
          role: 1,
          department: 1,
          plan: 1,
          active: 1,
        },
      }
    );
  } catch (error) {
    return next(error);
  }

  if (!user || user.active === false) {
    return res.status(401).json({ message: "Account is inactive or unavailable" });
  }

  req.user = {
    id: payload.sub,
    email: user.email || payload.email,
    name:
      [user.firstName, user.surname].filter(Boolean).join(" ") ||
      user.name ||
      payload.name,
    role: user.role || "teacher",
    department: user.department || null,
    plan: user.plan || payload.plan,
  };

  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  signToken,
  verifyToken,
};
