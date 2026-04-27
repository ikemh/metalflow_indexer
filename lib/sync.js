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
//
// Fix MaxListenersExceededWarning:
//   A versão antiga registrava `res.socket.setTimeout(...)` em cada upload.
//   O agent HTTP do Node reaproveita sockets entre requisições, e cada
//   chamada adicionava um novo listener "timeout" ao mesmo socket → após
//   ~10 uploads, EventEmitter emitia o warning.
//
//   Solução: usar um único timer próprio, com cleanup garantido em TODOS os
//   caminhos (sucesso, erro HTTP, erro de stream, JSON inválido, timeout,
//   erro de request, erro do file stream). Nunca tocamos em res.socket.
// ---------------------------------------------------------------------------

const UPLOAD_TIMEOUT_MS = 60_000;

function uploadThumbToErp(erpApiUrl, apiKey, fileId, thumbPath) {
  const baseUrl = normalizeBaseUrl(erpApiUrl);
  const url = `${baseUrl}/indexer/thumbs`;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let req = null;
    let fileStream = null;

    /**
     * `destroyResources` controla se devemos forçar o encerramento dos
     * recursos (file stream e request HTTP). No caminho de SUCESSO esses
     * recursos já encerraram naturalmente — chamar destroy() ali pode
     * mandar RST e atrapalhar keep-alive. Por isso só destruímos em
     * timeout / erros.
     */
    const finish = (result, { destroyResources = false } = {}) => {
      if (settled) return;
      settled = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (destroyResources) {
        if (fileStream && typeof fileStream.destroy === "function") {
          try {
            fileStream.destroy();
          } catch {}
        }
        if (req && typeof req.destroy === "function") {
          try {
            req.destroy();
          } catch {}
        }
      }

      resolve(result);
    };

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      finish({ ok: false, error: `Invalid URL: ${err.message}` });
      return;
    }

    const form = new FormData();
    form.append("fileId", String(fileId));

    fileStream = createReadStream(thumbPath);
    fileStream.once("error", (err) => {
      finish(
        { ok: false, error: `File read error: ${err.message}` },
        { destroyResources: true },
      );
    });
    form.append("file", fileStream);

    const options = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + (parsedUrl.search || ""),
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    };

    try {
      req = form.submit(options, (err, res) => {
        if (err) {
          finish(
            { ok: false, error: `Network error: ${err.message}` },
            { destroyResources: true },
          );
          return;
        }

        // Importante: NÃO usar res.socket.setTimeout — o agent reutiliza
        // sockets e isso vaza listeners ("MaxListenersExceededWarning").
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.once("end", () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            finish(
              {
                ok: false,
                error: `HTTP ${res.statusCode}: ${body.slice(0, 500)}`,
              },
              // res e req já encerraram (recebemos 'end'); mesmo assim
              // marcamos para destruir o file stream caso ainda não tenha
              // sido drenado por completo.
              { destroyResources: true },
            );
            return;
          }
          try {
            const data = JSON.parse(body);
            // Sucesso: NÃO destruir — recursos já encerraram naturalmente.
            finish({ ok: true, thumbnailUrl: data?.thumbnailUrl || null });
          } catch {
            finish(
              { ok: false, error: "Invalid JSON response" },
              { destroyResources: true },
            );
          }
        });
        res.once("error", (e) => {
          finish(
            { ok: false, error: `Stream error: ${e.message}` },
            { destroyResources: true },
          );
        });
      });
    } catch (err) {
      finish(
        { ok: false, error: `Request build error: ${err.message}` },
        { destroyResources: true },
      );
      return;
    }

    if (req && typeof req.once === "function") {
      req.once("error", (err) => {
        finish(
          { ok: false, error: `Request error: ${err.message}` },
          { destroyResources: true },
        );
      });
    }

    timer = setTimeout(() => {
      finish(
        { ok: false, error: `Upload timeout (${UPLOAD_TIMEOUT_MS}ms)` },
        { destroyResources: true },
      );
    }, UPLOAD_TIMEOUT_MS);
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
