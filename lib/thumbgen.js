"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs/promises");

const THUMB_DIR = path.join(__dirname, "..", "thumbs");
const DXF_THUMB = path.join(__dirname, "..", "dxf-thumb");
const THUMB_SIZE = 256;
const TIMEOUT_MS = 30_000;

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
        `[thumbgen] timeout: ${path.basename(absoluteDxfPath)}`,
      );
      done(null);
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done(outPath);
      } else {
        const errMsg = stderrLines.join("").trim();
        if (errMsg) console.warn(`[thumbgen] exit ${code}: ${errMsg}`);
        done(null);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.warn(`[thumbgen] spawn error: ${err.message}`);
      done(null);
    });
  });
}

async function processFile(file, folderPath) {
  try {
    const absolutePath = path.resolve(
      path.join(folderPath, file.relativePath),
    );
    const cached = await thumbExists(file.id);
    const thumbPath = cached
      ? path.join(THUMB_DIR, `${file.id}.png`)
      : await spawnThumb(file.id, absolutePath);

    return thumbPath !== null
      ? { ...file, thumbnailPath: thumbPath, thumbCached: cached }
      : { ...file };
  } catch {
    return { ...file };
  }
}

/**
 * Gera (ou aproveita do cache) as miniaturas de um lote de arquivos DXF.
 * READ-ONLY no filesystem de origem — thumbs vão para ./thumbs/ local.
 *
 * @param {Array} files
 * @param {string} folderPath  Pasta raiz do cliente
 * @param {number} concurrency Workers paralelos
 * @returns {Promise<Array>}
 */
async function generateThumbsForFiles(files, folderPath, concurrency = 4) {
  await ensureThumbsDir();

  const results = new Array(files.length);
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const idx = next++;
      results[idx] = await processFile(files[idx], folderPath);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, files.length) },
    worker,
  );
  await Promise.all(workers);

  return results;
}

module.exports = { generateThumbsForFiles };
