"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");

const THUMB_DIR = path.join(__dirname, "..", "thumbs");
const DXF_THUMB = path.join(__dirname, "..", "dxf-thumb");
const THUMB_SIZE = 256;
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 4; // arquivos processados em paralelo

// Pode ser sobrescrito via variável de ambiente
const BASE_URL = (
  process.env.THUMBS_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

// ─── helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Gera uma miniatura chamando o script Python dxf-thumb.
 * Resolve com a URL pública da miniatura, ou null em caso de falha.
 * @param {string} fileId
 * @param {string} absoluteDxfPath
 * @returns {Promise<string | null>}
 */
function spawnThumb(fileId, absoluteDxfPath) {
  const outPath = path.join(THUMB_DIR, `${fileId}.png`);
  return new Promise((resolve) => {
    let settled = false;
    const stderrLines = [];

    function done(result) {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    }

    const proc = spawn("python3", [
      DXF_THUMB,
      absoluteDxfPath,
      String(THUMB_SIZE),
      outPath,
    ]);

    proc.stderr.on("data", (chunk) => stderrLines.push(chunk.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      console.warn(
        `[thumbgen] timeout ao gerar ${path.basename(absoluteDxfPath)}`,
      );
      done(null);
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done(`${BASE_URL}/thumbs/${fileId}.png`);
      } else {
        const errMsg = stderrLines.join("").trim();
        if (errMsg) console.warn(`[thumbgen] falha (exit ${code}): ${errMsg}`);
        done(null);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.warn(`[thumbgen] erro ao iniciar python3: ${err.message}`);
      done(null);
    });
  });
}

/**
 * Processa um único arquivo: retorna o objeto file enriquecido com thumbnailUrl
 * (quando geração for bem-sucedida) ou o objeto original sem a chave.
 * @param {{ id: string; relativePath: string; [key: string]: any }} file
 * @param {string} folderPath  Pasta raiz do cliente (para resolver o caminho absoluto)
 * @returns {Promise<object>}
 */
async function processFile(file, folderPath) {
  try {
    const absolutePath = path.resolve(path.join(folderPath, file.relativePath));
    const cached = await thumbExists(file.id);
    const url = cached
      ? `${BASE_URL}/thumbs/${file.id}.png`
      : await spawnThumb(file.id, absolutePath);

    return url !== null ? { ...file, thumbnailUrl: url } : { ...file };
  } catch {
    return { ...file };
  }
}

/**
 * Gera (ou aproveita do cache) as miniaturas de um lote de arquivos DXF.
 * Processa no máximo CONCURRENCY arquivos em paralelo.
 * Nunca lança exceção — falhas individuais apenas omitem thumbnailUrl no item.
 *
 * @param {Array<{ id: string; relativePath: string; [key: string]: any }>} files
 * @param {string} folderPath  Pasta raiz do cliente
 * @returns {Promise<Array>}
 */
async function generateThumbsForFiles(files, folderPath) {
  await ensureThumbsDir();

  const results = new Array(files.length);
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const idx = next++;
      results[idx] = await processFile(files[idx], folderPath);
    }
  }

  // Sobe CONCURRENCY workers em paralelo
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, files.length) },
    worker,
  );
  await Promise.all(workers);

  return results;
}

module.exports = { generateThumbsForFiles };
