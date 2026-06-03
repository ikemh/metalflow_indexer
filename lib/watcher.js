"use strict";

/**
 * Watcher opcional baseado em chokidar.
 *
 * Política:
 *   - Padrão DESLIGADO. Só roda se config.watchEnabled === true.
 *   - NUNCA substitui o sync periódico. É apenas complementar para
 *     reduzir latência entre alteração de arquivo e atualização no ERP.
 *   - Recomendado: produção Windows com disco local.
 *   - NÃO recomendado: Fedora + SMB + Tailscale (eventos pouco confiáveis,
 *     custo de inotify alto via FUSE/cifs).
 *   - Quando há evento em um .dxf, sincroniza a pasta INTEIRA do cliente
 *     afetado (não o arquivo isolado), respeitando excludedFolders.
 *   - Debounce por (sourceType + rootPath + customerFolder).
 *   - Concorrência: o caller decide o que fazer no callback. Recomenda-se
 *     enfileirar atrás de uma fila serializada para não cruzar com o sync
 *     completo do timer.
 */

const path = require("path");
const chokidar = require("chokidar");
const {
  normalizeExclusionName,
  clampWatchDebounceSeconds,
} = require("./config");

const DXF_EXT = ".dxf";

// No Windows, o modo nativo de fs.watch/chokidar pode manter handles em
// diretórios e bloquear rename/delete em pastas compartilhadas. Polling reduz
// esse risco ao custo de um pequeno atraso, preservando atualização quase em
// tempo real para o ERP.
const DEFAULT_USE_POLLING = process.platform === "win32";
const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_BINARY_INTERVAL_MS = 3000;
const DEFAULT_STABILITY_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 500;

const IGNORED_FILE_NAMES = new Set([
  "thumbs.db",
  "desktop.ini",
]);

const IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".trash-0",
  ".trash-1000",
  "$recycle.bin",
  "system volume information",
]);

function isDxfPath(p) {
  return path.extname(p).toLowerCase() === DXF_EXT;
}

function isValidSourceType(sourceType) {
  return sourceType === "ATACADO" || sourceType === "VAREJO";
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function isIgnoredNoisePath(p) {
  const base = path.basename(p).toLowerCase();

  if (IGNORED_FILE_NAMES.has(base)) return true;
  if (base.startsWith("~$")) return true;
  if (base.endsWith(".tmp")) return true;
  if (base.endsWith(".temp")) return true;
  if (base.endsWith(".bak")) return true;
  if (base.endsWith(".crdownload")) return true;
  if (base.endsWith(".partial")) return true;

  return false;
}

function buildExcludedByType(excludedFolders) {
  /** @type {Map<string, Set<string>>} */
  const byType = new Map();
  for (const e of excludedFolders || []) {
    const sourceType = e?.sourceType;
    // Compat defensiva: regras legadas sem sourceType NÃO são aplicadas.
    if (!isValidSourceType(sourceType)) continue;

    const norm = normalizeExclusionName(e?.folderName);
    if (!norm) continue;

    let set = byType.get(sourceType);
    if (!set) {
      set = new Set();
      byType.set(sourceType, set);
    }
    set.add(norm);
  }
  return byType;
}

/**
 * Tenta localizar o arquivo dentro de algum dos roots.
 * Retorna { root, customerFolder, relativePath } ou null se não bater.
 *
 * - customerFolder = primeiro segmento relativo ao root.
 * - relativePath = caminho dentro da pasta do cliente, com "/" como separador.
 */
function locateInRoots(filePath, roots) {
  const target = path.resolve(filePath);

  for (const root of roots) {
    const rootResolved = path.resolve(root.path);
    const rel = path.relative(rootResolved, target);

    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;

    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length < 2) continue; // arquivo direto na raiz: sem cliente

    const customerFolder = segments[0];
    const relativePath = segments.slice(1).join("/");
    return { root, customerFolder, relativePath };
  }
  return null;
}

/**
 * Cria um watcher pronto para uso. Lazy: nada acontece até `start()`.
 *
 * @param {object} args
 * @param {object} args.config        - config carregada (precisa de roots, excludedFolders, watchDebounceSeconds)
 * @param {function} args.onCustomerChanged - chamado após debounce: ({root, customerFolder, eventType, relativePath}) => void
 * @param {function} args.log         - opcional: (level, message) => void
 */
function createWatcher({ config, onCustomerChanged, log }) {
  const safeLog = typeof log === "function" ? log : () => {};

  const debounceMs =
    clampWatchDebounceSeconds(config.watchDebounceSeconds) * 1000;
  const roots = (config.roots || []).filter(
    (r) => r && typeof r.path === "string" && r.path.trim() !== "",
  );
  const excludedByType = buildExcludedByType(config.excludedFolders);

  function isExcludedCustomerFolder(root, customerFolder) {
    const sourceType = root?.sourceType;
    if (!isValidSourceType(sourceType)) return false;
    const set = excludedByType.get(sourceType);
    if (!set || set.size === 0) return false;
    const norm = normalizeExclusionName(customerFolder);
    if (!norm) return false;
    return set.has(norm);
  }

  function isExcludedPathByCustomerFolder(p) {
    const located = locateInRoots(p, roots);
    if (!located) return false;
    return isExcludedCustomerFolder(located.root, located.customerFolder);
  }

  /** @type {Map<string, NodeJS.Timeout>} timers por chave */
  const timers = new Map();
  /** @type {Map<string, {eventType: string, relativePath: string}>} */
  const lastEvents = new Map();

  let watcher = null;
  let started = false;
  let closed = false;

  function makeKey(root, customerFolder) {
    return [root.sourceType, root.path, customerFolder].join("::");
  }

  function scheduleSync(eventType, file) {
    if (closed) return;
    if (isIgnoredNoisePath(file)) return;
    if (!isDxfPath(file)) return;

    const located = locateInRoots(file, roots);
    if (!located) return;

    const { root, customerFolder, relativePath } = located;

    // Exclusão vale APENAS no primeiro nível do root (customerFolder),
    // e é específica por sourceType.
    if (isExcludedCustomerFolder(root, customerFolder)) return;

    const key = makeKey(root, customerFolder);

    safeLog(
      "info",
      `[watch] queued ${customerFolder} (${root.sourceType}): ${eventType} ${relativePath}`,
    );

    lastEvents.set(key, { eventType, relativePath });

    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      timers.delete(key);
      const ev = lastEvents.get(key);
      lastEvents.delete(key);

      safeLog(
        "info",
        `[watch] syncing ${customerFolder} (${root.sourceType}) after debounce`,
      );

      try {
        onCustomerChanged({
          root,
          customerFolder,
          eventType: ev?.eventType,
          relativePath: ev?.relativePath,
        });
      } catch (err) {
        safeLog("error", `[watch] handler error: ${err.message}`);
      }
    }, debounceMs);

    // Não segura o event loop — em shutdown, processo pode encerrar.
    if (typeof t.unref === "function") t.unref();

    timers.set(key, t);
  }

  function start() {
    if (started || closed) return;
    started = true;

    if (roots.length === 0) {
      safeLog("warn", "[watch] no roots configured, watcher idle");
      return;
    }

    const paths = roots.map((r) => r.path);
    const usePolling = config.watchUsePolling ?? DEFAULT_USE_POLLING;
    const interval = toPositiveInt(config.watchIntervalMs, DEFAULT_INTERVAL_MS);
    const binaryInterval = toPositiveInt(
      config.watchBinaryIntervalMs,
      DEFAULT_BINARY_INTERVAL_MS,
    );
    const stabilityThreshold = toPositiveInt(
      config.watchStabilityThresholdMs,
      DEFAULT_STABILITY_MS,
    );
    const pollInterval = toPositiveInt(
      config.watchPollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );

    watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
      usePolling,
      interval,
      binaryInterval,
      alwaysStat: false,
      // Evita disparar antes do arquivo terminar de ser gravado (Windows).
      awaitWriteFinish: {
        stabilityThreshold,
        pollInterval,
      },
      // Filtra lixo do Windows e extensões sem interesse antes do handler.
      // Diretórios continuam transitáveis, mas em Windows usam polling para
      // reduzir handles que bloqueiam rename/delete.
      ignored: (p, stats) => {
        if (isIgnoredNoisePath(p)) return true;

        const base = path.basename(p).toLowerCase();
        if (stats && stats.isDirectory && stats.isDirectory()) {
          if (IGNORED_DIR_NAMES.has(base)) return true;
          return isExcludedPathByCustomerFolder(p);
        }

        const ext = path.extname(p);
        if (!ext) return false; // caminho ainda sem stats conclusivo
        return ext.toLowerCase() !== DXF_EXT;
      },
    });

    watcher.on("add", (p) => scheduleSync("add", p));
    watcher.on("change", (p) => scheduleSync("change", p));
    watcher.on("unlink", (p) => scheduleSync("unlink", p));
    watcher.on("error", (err) => {
      safeLog("error", `[watch] error: ${err?.message || err}`);
    });

    safeLog(
      "info",
      `[watch] enabled: roots=${roots.length} debounce=${Math.round(debounceMs / 1000)}s polling=${usePolling ? "on" : "off"} interval=${interval}ms`,
    );
  }

  async function close() {
    if (closed) return;
    closed = true;

    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    lastEvents.clear();

    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        safeLog("warn", `[watch] close error: ${err.message}`);
      }
      watcher = null;
    }
  }

  return {
    start,
    close,
    rootsCount: roots.length,
    debounceMs,
  };
}

module.exports = { createWatcher };
