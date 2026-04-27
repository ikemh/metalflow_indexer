"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { readConfig, normalizeExclusionName } = require("./config");

const VALID_EXTENSIONS = new Set([".dxf"]);

let excludedFoldersCache = null;
let excludedFoldersLastLoad = 0;
const EXCLUDED_CACHE_TTL_MS = 5000;

async function getExcludedFolders() {
  const now = Date.now();
  if (
    excludedFoldersCache &&
    now - excludedFoldersLastLoad < EXCLUDED_CACHE_TTL_MS
  ) {
    return excludedFoldersCache;
  }

  try {
    const config = await readConfig();
    const set = new Set();
    for (const e of config.excludedFolders || []) {
      const norm = normalizeExclusionName(e?.folderName);
      if (norm) set.add(norm);
    }
    excludedFoldersCache = set;
    excludedFoldersLastLoad = now;
    return excludedFoldersCache;
  } catch {
    return new Set();
  }
}

function clearExcludedFoldersCache() {
  excludedFoldersCache = null;
  excludedFoldersLastLoad = 0;
}

function isExcluded(name, excludedFolders) {
  if (!excludedFolders || excludedFolders.size === 0) return false;
  const norm = normalizeExclusionName(name);
  if (!norm) return false;
  return excludedFolders.has(norm);
}

function normalizeText(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizePathSeparators(value) {
  return value.replace(/\\/g, "/");
}

function buildStableId(sourceType, customerFolder, relativePath) {
  return crypto
    .createHash("sha1")
    .update(`${sourceType}::${customerFolder}::${relativePath}`)
    .digest("hex");
}

/**
 * Lista diretórios de primeiro nível em rootPath.
 * Cada diretório = um cliente. Pastas excluídas são ignoradas.
 * @returns {Promise<string[]>} nomes dos diretórios
 */
async function discoverCustomers(rootPath) {
  const excludedFolders = await getExcludedFolders();
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => !isExcluded(e.name, excludedFolders))
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
  excludedFolders,
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
      if (isExcluded(entry.name, excludedFolders)) {
        continue;
      }
      await collectFilesRecursive(
        fullPath,
        rootDir,
        sourceType,
        customerFolder,
        collector,
        warnings,
        excludedFolders,
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
        // Caminho físico real preservado para uso interno (thumbnail).
        // NUNCA enviar este campo ao backend ERP — é apenas para o indexador.
        absolutePath: fullPath,
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
 * Pastas excluídas são ignoradas durante a varredura recursiva.
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

  const excludedFolders = await getExcludedFolders();
  const files = [];
  const warnings = [];
  await collectFilesRecursive(
    resolvedPath,
    resolvedPath,
    sourceType,
    customerFolder,
    files,
    warnings,
    excludedFolders,
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

function normalizeRootPath(rootPath) {
  return rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

module.exports = {
  discoverCustomers,
  scanFolder,
  isRootAccessible,
  normalizeRootPath,
  clearExcludedFoldersCache,
};
