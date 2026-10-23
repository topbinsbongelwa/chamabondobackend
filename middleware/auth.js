const crypto = require("crypto");

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

function authenticate(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const payload = verifyToken(token);

    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };

    return next();
  } catch (error) {
    const message =
      error.message === "Token expired"
        ? "Token expired"
        : "Invalid or expired token";

    return res.status(401).json({ message });
  }
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
