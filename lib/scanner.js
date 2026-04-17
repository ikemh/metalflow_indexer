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

function buildStableId(sourceType, customerFolder, relativePath) {
  return crypto
    .createHash("sha1")
    .update(`${sourceType}::${customerFolder}::${relativePath}`)
    .digest("hex");
}

/**
 * Lista diretórios de primeiro nível em rootPath.
 * Cada diretório = um cliente.
 * @returns {Promise<string[]>} nomes dos diretórios
 */
async function discoverCustomers(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function collectFilesRecursive(
  dir,
  rootDir,
  sourceType,
  customerFolder,
  collector,
  warnings,
) {
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
      await collectFilesRecursive(
        fullPath,
        rootDir,
        sourceType,
        customerFolder,
        collector,
        warnings,
      );
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
        id: buildStableId(sourceType, customerFolder, relativePath),
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
 * Escaneia recursivamente uma pasta de cliente, retornando arquivos .dxf.
 * READ-ONLY — nunca modifica o filesystem.
 */
async function scanFolder(folderPath, sourceType, customerFolder) {
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
  await collectFilesRecursive(
    resolvedPath,
    resolvedPath,
    sourceType,
    customerFolder,
    files,
    warnings,
  );

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "pt-BR"));

  return { files, warnings };
}

/**
 * Verifica se um root path está acessível (mount disponível).
 * READ-ONLY.
 */
async function isRootAccessible(rootPath) {
  try {
    const stats = await fs.stat(rootPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

module.exports = { discoverCustomers, scanFolder, isRootAccessible };
