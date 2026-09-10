const crypto = require("crypto");

// Assina um payload com HMAC (sem lib de JWT, só um HMAC sobre JSON), usando
// o segredo próprio desta aplicação (SESSION_SECRET).
function sign(payloadObj, secret) {
  const encoded = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verify(token, secret) {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const encoded = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  const expectedSig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge !== undefined) str += `; Max-Age=${opts.maxAge}`;
  str += `; Path=${opts.path || "/"}`;
  if (opts.httpOnly !== false) str += "; HttpOnly";
  str += `; SameSite=${opts.sameSite || "Lax"}`;
  if (opts.secure) str += "; Secure";
  return str;
}

module.exports = { sign, verify, parseCookies, serializeCookie };
