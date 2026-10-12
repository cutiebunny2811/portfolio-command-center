import { createHash, createHmac } from "node:crypto";

// Webull v3 signs the exact JSON body hash for POST requests; GET has no body suffix.
export function makeWebullSignature({ path, query = {}, body = null, appKey, appSecret, host, timestamp, nonce }) {
  const values = {
    ...query,
    host,
    "x-app-key": appKey,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-nonce": nonce,
    "x-signature-version": "1.0",
    "x-timestamp": timestamp,
  };
  const sorted = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join("&");
  const digest = body === null ? "" : `&${createHash("md5").update(body, "utf8").digest("hex").toUpperCase()}`;
  return createHmac("sha1", `${appSecret}&`)
    .update(encodeURIComponent(`${path}&${sorted}${digest}`), "utf8")
    .digest("base64");
}
