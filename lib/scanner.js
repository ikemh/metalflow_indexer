"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const VALID_EXTENSIONS = new Set([".dxf"]);

function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizePathSeparators(value) {
  return value.split(path.sep).join("/");
}

function buildStableId(customerFolder, relativePath) {
  return crypto
    .createHash("sha1")
    .update(`${customerFolder}::${relativePath}`)
    .digest("hex");
}

async function collectFilesRecursive(dir, rootDir, collector, warnings) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    warnings.push({ type: "READ_DIR_ERROR", dir, message: error.message });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, rootDir, collector, warnings);
      continue;
    }

    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name).toLowerCase();
    if (!VALID_EXTENSIONS.has(extension)) continue;

    try {
      const stats = await fs.stat(fullPath);
      const relativePath = normalizePathSeparators(
        path.relative(rootDir, fullPath),
      );
      const fileName = normalizeText(path.basename(fullPath));

      collector.push({
        id: buildStableId(path.basename(rootDir), relativePath),
        fileName,
        relativePath,
        extension,
        sizeBytes: stats.size,
        lastModifiedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      warnings.push({
        type: "STAT_FILE_ERROR",
        filePath: fullPath,
        message: error.message,
      });
    }
  }
}

/**
 * Scan uma pasta raiz de cliente e retorna os arquivos .dxf encontrados.
 * @param {string} folderPath - Caminho absoluto da pasta do cliente
 * @returns {Promise<{ files: Array, warnings: Array }>}
 */
async function scanFolder(folderPath) {
  const resolvedPath = path.resolve(folderPath);

  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return {
        files: [],
        warnings: [
          {
            type: "NOT_A_DIRECTORY",
            path: resolvedPath,
            message: "O caminho não é um diretório",
          },
        ],
      };
    }
  } catch (error) {
    return {
      files: [],
      warnings: [
        { type: "PATH_NOT_FOUND", path: resolvedPath, message: error.message },
      ],
    };
  }

  const files = [];
  const warnings = [];
  await collectFilesRecursive(resolvedPath, resolvedPath, files, warnings);

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "pt-BR"));

  return { files, warnings };
}

module.exports = { scanFolder };
