"use strict";

/**
 * Assinatura leve de pasta para smart sync.
 *
 * Calcula uma fingerprint baseada apenas nos metadados já coletados pelo
 * scanner (relativePath, sizeBytes, lastModifiedAt). NÃO lê conteúdo de
 * arquivos. NÃO calcula contentHash.
 *
 * A assinatura é usada para detectar se uma pasta mudou desde o último
 * sync bem-sucedido. Se não mudou, o sync é pulado (smart skip).
 *
 * Persistência: JSON atômico (escreve .tmp + rename).
 */

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** @type {Map<string, object>|null} */
let signatureCache = null;
let signatureCacheDirty = false;

// ---------------------------------------------------------------------------
// Signature computation
// ---------------------------------------------------------------------------

/**
 * Calcula assinatura leve de uma pasta a partir do array de files retornado
 * por scanFolder().
 *
 * Componentes:
 *   - fileCount
 *   - totalSizeBytes
 *   - maxMtimeMs (maior mtime entre todos os arquivos)
 *   - fingerprint: sha1 de entradas ordenadas por relativePath:
 *       relativePath + "|" + sizeBytes + "|" + lastModifiedAt
 *
 * Para pasta vazia (files=[]), retorna assinatura válida com fileCount=0.
 */
function computeFolderSignature(files) {
  const fileCount = files.length;
  let totalSizeBytes = 0;
  let maxMtimeMs = 0;

  const hash = crypto.createHash("sha1");

  // files já vem ordenado por relativePath do scanner, mas garantimos
  // ordenação para segurança.
  const sorted = [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  for (const f of sorted) {
    const size = typeof f.sizeBytes === "number" ? f.sizeBytes : 0;
    totalSizeBytes += size;

    const mtime = f.lastModifiedAt
      ? new Date(f.lastModifiedAt).getTime()
      : 0;
    if (mtime > maxMtimeMs) maxMtimeMs = mtime;

    hash.update(`${f.relativePath}|${size}|${f.lastModifiedAt || ""}\n`);
  }

  const fingerprint = fileCount > 0 ? hash.digest("hex") : "empty";

  return {
    fileCount,
    totalSizeBytes,
    maxMtimeMs,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Gera chave única para o cache de assinaturas.
 * Formato: sourceType::rootPath::customerFolder (normalizado).
 */
function makeFolderSignatureKey({ sourceType, rootPath, customerFolder }) {
  // rootPath já vem normalizado pelo caller (normalizeRootPath)
  return `${sourceType}::${rootPath}::${customerFolder}`;
}

// ---------------------------------------------------------------------------
// Persistence — load/save JSON atômico
// ---------------------------------------------------------------------------

/**
 * Carrega cache de assinaturas do disco.
 * Retorna Map<string, object> — vazio se arquivo não existir ou for inválido.
 */
async function loadSignatureCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      signatureCache = new Map(Object.entries(data));
    } else {
      signatureCache = new Map();
    }
  } catch {
    signatureCache = new Map();
  }
  signatureCacheDirty = false;
  return signatureCache;
}

/**
 * Persiste cache de assinaturas no disco atomicamente.
 * Escreve arquivo .tmp e faz rename para o destino.
 * Cria diretório data/ se não existir.
 */
async function saveSignatureCache(cachePath, cache) {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });

  const obj = {};
  for (const [k, v] of cache) {
    obj[k] = v;
  }

  const tmpPath = cachePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmpPath, cachePath);
  signatureCacheDirty = false;
}

// ---------------------------------------------------------------------------
// In-memory getters/setters
// ---------------------------------------------------------------------------

/**
 * Retorna assinatura cacheada para a chave, ou null se não existir.
 * Requer que loadSignatureCache tenha sido chamado antes.
 */
function getCachedSignature(key) {
  if (!signatureCache) return null;
  return signatureCache.get(key) || null;
}

/**
 * Atualiza assinatura no cache em memória.
 * O caller deve chamar saveSignatureCache depois para persistir.
 */
function setCachedSignature(key, signature) {
  if (!signatureCache) {
    signatureCache = new Map();
  }
  signatureCache.set(key, signature);
  signatureCacheDirty = true;
}

/**
 * Verifica se duas assinaturas são iguais.
 * Compara fingerprint, fileCount, totalSizeBytes e maxMtimeMs.
 */
function signaturesEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.fingerprint === b.fingerprint &&
    a.fileCount === b.fileCount &&
    a.totalSizeBytes === b.totalSizeBytes &&
    a.maxMtimeMs === b.maxMtimeMs
  );
}

/**
 * Retorna true se o cache em memória foi modificado desde o último load/save.
 */
function isCacheDirty() {
  return signatureCacheDirty;
}

/**
 * Retorna o cache em memória (ou null se não carregado).
 */
function getCache() {
  return signatureCache;
}

module.exports = {
  computeFolderSignature,
  makeFolderSignatureKey,
  loadSignatureCache,
  saveSignatureCache,
  getCachedSignature,
  setCachedSignature,
  signaturesEqual,
  isCacheDirty,
  getCache,
};
