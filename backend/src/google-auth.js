"use strict";

const TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

async function verifyGoogleIdToken(idToken, clientId, fetchImpl, nowMs) {
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) {
    throw new Error("Invalid Google credential.");
  }
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw new Error("Google sign-in is not configured.");
  }

  const request = fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await request(TOKEN_INFO_URL + "?id_token=" + encodeURIComponent(idToken), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response || !response.ok) throw new Error("Invalid Google credential.");

  const claims = await response.json();
  const now = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  const audience = claims && (claims.aud || claims.audience || claims.issued_to);
  const issuer = claims && claims.iss;
  const emailVerified = claims && (claims.email_verified === true || claims.email_verified === "true");
  if (!claims || audience !== clientId || !["accounts.google.com", "https://accounts.google.com"].includes(issuer) ||
      !claims.sub || typeof claims.sub !== "string" || claims.sub.length > 255 ||
      !emailVerified || typeof claims.email !== "string" || !claims.email.includes("@") ||
      !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now) {
    throw new Error("Invalid Google credential.");
  }

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === "string" ? claims.name.trim().slice(0, 40) : "",
  };
}

module.exports = { verifyGoogleIdToken };
