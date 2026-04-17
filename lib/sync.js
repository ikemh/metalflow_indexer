"use strict";

const { createReadStream } = require("fs");
const FormData = require("form-data");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.startsWith("http") ? trimmed : `http://${trimmed}`;
}

function buildHeaders(apiKey, extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

const DEFAULT_DELAYS = [2_000, 5_000, 15_000];

async function withRetry(fn, label, delays = DEFAULT_DELAYS) {
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.ok) return result;

    if (attempt < maxAttempts) {
      const delay = delays[attempt - 1];
      console.warn(
        `[retry] ${label} attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${result.error}`,
      );
      await sleep(delay);
    } else {
      console.error(
        `[retry] ${label} all ${maxAttempts} attempts failed: ${result.error}`,
      );
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkBackendHealth(erpApiUrl) {
  const baseUrl = normalizeBaseUrl(erpApiUrl);
  try {
    const res = await fetch(baseUrl, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thumbnail upload
// ---------------------------------------------------------------------------

function uploadThumbToErp(erpApiUrl, apiKey, fileId, thumbPath) {
  const baseUrl = normalizeBaseUrl(erpApiUrl);
  const url = `${baseUrl}/indexer/thumbs`;

  return new Promise((resolve) => {
    const form = new FormData();
    form.append("fileId", String(fileId));
    form.append("file", createReadStream(thumbPath));

    const parsedUrl = new URL(url);
    const options = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 60_000,
    };

    form.submit(options, (err, res) => {
      if (err) {
        resolve({ ok: false, error: `Network error: ${err.message}` });
        return;
      }

      res.socket?.setTimeout(60_000, () => {
        res.destroy();
        resolve({ ok: false, error: "Socket timeout (60s)" });
      });

      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200 && res.statusCode !== 201) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body}` });
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve({ ok: true, thumbnailUrl: data?.thumbnailUrl || null });
        } catch {
          resolve({ ok: false, error: "Invalid JSON response" });
        }
      });
      res.on("error", (e) => {
        resolve({ ok: false, error: `Stream error: ${e.message}` });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Batch sync
// ---------------------------------------------------------------------------

async function batchSyncToErp(
  erpApiUrl,
  apiKey,
  customerFolder,
  sourceType,
  rootPath,
  isCompleteScan,
  files,
) {
  const baseUrl = normalizeBaseUrl(erpApiUrl);
  const url = `${baseUrl}/indexer/sync`;

  return withRetry(async () => {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: buildHeaders(apiKey, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          customerFolder,
          sourceType,
          rootPath,
          isCompleteScan,
          files,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, error: `Network error: ${error.message}` };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }

    const data = await res.json().catch(() => null);
    return { ok: true, data };
  }, `batchSync(${customerFolder}/${sourceType})`);
}

module.exports = {
  checkBackendHealth,
  uploadThumbToErp,
  batchSyncToErp,
};
