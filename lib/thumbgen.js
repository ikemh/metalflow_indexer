"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");

const IS_WIN = process.platform === "win32";
const PYTHON = IS_WIN ? "python" : "python3";

const THUMB_DIR = path.join(__dirname, "..", "thumbs");
const DXF_THUMB = path.join(__dirname, "..", "dxf-thumb");
const THUMB_SIZE = 256;
const TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;

// Quantos erros individuais (failed/timeout/missing/locked) imprimir por
// chamada de generateThumbsForFiles antes de começar a suprimir.
const MAX_DETAIL_LOGS_PER_BATCH = 3;

// Padrões para classificar a mensagem do stderr.
const LOCKED_PATTERNS = [
  /resource temporarily unavailable/i,
  /recurso temporariamente indispon[ií]vel/i,
  /\bEAGAIN\b/,
  /\bEBUSY\b/,
  /\bErrno 11\b/,
];

const MISSING_PATTERNS = [
  /arquivo n[aã]o encontrado/i,
  /file not found/i,
  /no such file/i,
  /\bENOENT\b/,
];

async function ensureThumbsDir() {
  await fs.mkdir(THUMB_DIR, { recursive: true });
}

async function thumbExists(fileId) {
  try {
    await fs.access(path.join(THUMB_DIR, `${fileId}.png`));
    return true;
  } catch {
    return false;
  }
}

function classifyExitError(code, stderr) {
  const text = stderr || "";
  if (code === 2 || MISSING_PATTERNS.some((p) => p.test(text))) {
    return "missing";
  }
  if (LOCKED_PATTERNS.some((p) => p.test(text))) {
    return "locked";
  }
  return "failed";
}

function classifySpawnError(message) {
  const text = message || "";
  if (LOCKED_PATTERNS.some((p) => p.test(text))) return "locked";
  if (MISSING_PATTERNS.some((p) => p.test(text))) return "missing";
  return "failed";
}

/**
 * Executa o gerador Python uma única vez. Sempre resolve com:
 *   { status, outPath?, stderr?, exitCode?, error? }
 * onde status é um de: ok | failed | timeout | missing | locked
 *
 * Notas sobre kill no timeout:
 * - Resolve a Promise IMEDIATAMENTE como `timeout` ao bater o timer.
 * - Em paralelo, dispara SIGTERM. Em Unix, agenda um SIGKILL após
 *   KILL_GRACE_MS caso o processo não tenha encerrado.
 * - O cleanup do `killTimer` é feito quando o processo realmente fecha
 *   (`proc.on('close')`), NÃO no `finish()` — caso contrário o SIGKILL
 *   nunca chegaria a rodar.
 */
function spawnThumbOnce(fileId, absoluteDxfPath) {
  const outPath = path.join(THUMB_DIR, `${fileId}.png`);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let killTimer = null;
    let timedOut = false;
    const stderrChunks = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;

      // Apenas o timer principal de timeout pertence ao ciclo do finish.
      // O killTimer é independente — só some quando o processo encerra
      // (proc.on('close')).
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      resolve(result);
    };

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    let proc;
    try {
      proc = spawn(
        PYTHON,
        [DXF_THUMB, absoluteDxfPath, String(THUMB_SIZE), outPath],
        { windowsHide: true },
      );
    } catch (err) {
      finish({
        status: classifySpawnError(err.message),
        error: err.message,
      });
      return;
    }

    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    proc.stderr.on("error", () => {
      // ignora — é coletado por padrão
    });

    proc.on("error", (err) => {
      const msg = err.message || String(err);
      clearKillTimer();
      finish({
        status: classifySpawnError(msg),
        error: msg,
      });
    });

    proc.on("close", (code) => {
      // Processo encerrou de fato: o killTimer não tem mais utilidade.
      clearKillTimer();

      if (timedOut) {
        // Já resolvemos como timeout no setTimeout.
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code === 0) {
        finish({ status: "ok", outPath });
        return;
      }

      finish({
        status: classifyExitError(code, stderr),
        exitCode: code,
        stderr,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;

      // SIGTERM imediato.
      try {
        proc.kill("SIGTERM");
      } catch {}

      // Em Unix, garante kill com SIGKILL caso não encerre dentro do grace.
      // Importante: NÃO cancelar este timer dentro de finish() — o cleanup
      // dele acontece em proc.on('close').
      if (!IS_WIN) {
        killTimer = setTimeout(() => {
          try {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGKILL");
            }
          } catch {}
        }, KILL_GRACE_MS);
        // .unref() para o killTimer não impedir saída do processo Node.
        if (typeof killTimer.unref === "function") killTimer.unref();
      }

      finish({ status: "timeout" });
    }, TIMEOUT_MS);
  });
}

/**
 * Wrapper que adiciona retry curto para 'locked'.
 * Limita a 3 tentativas no total para evitar loop infinito.
 */
async function spawnThumb(fileId, absoluteDxfPath) {
  const lockedDelaysMs = [500, 1500];

  let result = await spawnThumbOnce(fileId, absoluteDxfPath);

  for (let attempt = 0; attempt < lockedDelaysMs.length; attempt++) {
    if (result.status !== "locked") break;
    await new Promise((r) => setTimeout(r, lockedDelaysMs[attempt]));
    result = await spawnThumbOnce(fileId, absoluteDxfPath);
  }

  return result;
}

async function processFile(file, folderPath) {
  // Preferir absolutePath (caminho físico real preservado pelo scanner);
  // só reconstruir como fallback.
  const absolutePath =
    typeof file.absolutePath === "string" && file.absolutePath
      ? file.absolutePath
      : path.resolve(path.join(folderPath, file.relativePath));

  // Se a thumb já existe em cache, reaproveita sem invocar Python.
  if (await thumbExists(file.id)) {
    const cachedPath = path.join(THUMB_DIR, `${file.id}.png`);
    return {
      file: { ...file, thumbnailPath: cachedPath, thumbCached: true },
      status: "cached",
    };
  }

  // Antes de invocar Python, valida se o arquivo realmente existe.
  // Ajuda a evitar gastar processo só para receber exit 2.
  try {
    await fs.access(absolutePath);
  } catch {
    return { file: { ...file }, status: "missing" };
  }

  let result;
  try {
    result = await spawnThumb(file.id, absolutePath);
  } catch (err) {
    return { file: { ...file }, status: "failed", detail: err.message };
  }

  if (result.status === "ok") {
    return {
      file: { ...file, thumbnailPath: result.outPath, thumbCached: false },
      status: "ok",
    };
  }

  return {
    file: { ...file },
    status: result.status,
    detail: result.stderr || result.error,
  };
}

function formatDetailLog(customerLabel, file, status, detail) {
  const fileName =
    file.fileName ||
    path.basename(file.relativePath || file.absolutePath || "?");
  const trim = (s) => String(s || "").split("\n")[0].slice(0, 200);
  const prefix = customerLabel
    ? `[thumbgen] ${customerLabel}:`
    : `[thumbgen]`;

  if (status === "timeout") {
    return `${prefix} timeout ${fileName}`;
  }
  if (status === "missing") {
    return `${prefix} missing ${fileName}${detail ? " — " + trim(detail) : ""}`;
  }
  if (status === "locked") {
    return `${prefix} locked ${fileName}${detail ? " — " + trim(detail) : ""}`;
  }
  // failed
  return `${prefix} failed ${fileName}${detail ? " — " + trim(detail) : ""}`;
}

/**
 * READ-ONLY no filesystem de origem — thumbs vão para ./thumbs/ local.
 *
 * Aceita 3o parâmetro como número (concurrency, retrocompat) ou objeto:
 *   { concurrency, customerLabel }
 *
 * Retorna: { files, stats }
 *   files: array dos arquivos (com thumbnailPath/thumbCached preenchidos quando aplicável)
 *   stats: { ok, cached, failed, timeout, missing, locked }
 */
async function generateThumbsForFiles(files, folderPath, options = {}) {
  if (typeof options === "number") {
    options = { concurrency: options };
  }

  // Concurrency clamping defensivo (server.js também valida antes,
  // mas defendemos contra chamadas internas).
  let concurrency = Number(options.concurrency);
  if (!Number.isFinite(concurrency)) concurrency = 4;
  concurrency = Math.floor(concurrency);
  if (concurrency < 1) concurrency = 1;
  if (concurrency > 8) concurrency = 8;

  const customerLabel =
    typeof options.customerLabel === "string" ? options.customerLabel : "";

  await ensureThumbsDir();

  const out = new Array(files.length);
  const stats = {
    ok: 0,
    cached: 0,
    failed: 0,
    timeout: 0,
    missing: 0,
    locked: 0,
  };

  // Controle de verbosidade dos detalhes por lote.
  let detailLogCount = 0;
  let suppressedCount = 0;

  const reportDetail = (file, status, detail) => {
    if (detailLogCount < MAX_DETAIL_LOGS_PER_BATCH) {
      console.warn(formatDetailLog(customerLabel, file, status, detail));
      detailLogCount++;
    } else {
      suppressedCount++;
    }
  };

  let next = 0;

  async function worker() {
    while (next < files.length) {
      const idx = next++;
      const r = await processFile(files[idx], folderPath);
      out[idx] = r.file;
      if (stats[r.status] !== undefined) stats[r.status]++;
      if (r.status !== "ok" && r.status !== "cached") {
        reportDetail(files[idx], r.status, r.detail);
      }
    }
  }

  const effectiveConcurrency = Math.max(
    1,
    Math.min(concurrency, files.length || 1),
  );
  const workers = Array.from({ length: effectiveConcurrency }, worker);
  await Promise.all(workers);

  if (suppressedCount > 0) {
    const prefix = customerLabel
      ? `[thumbgen] ${customerLabel}:`
      : `[thumbgen]`;
    console.warn(
      `${prefix} suppressed ${suppressedCount} additional thumbnail errors`,
    );
  }

  return { files: out, stats };
}

module.exports = { generateThumbsForFiles };
