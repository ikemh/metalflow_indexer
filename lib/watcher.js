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
 *
 * Uso:
 *   const w = createWatcher({ config, onCustomerChanged, log });
 *   w.start();
 *   // ...
 *   await w.close();
 */

const path = require("path");
const chokidar = require("chokidar");
const {
  normalizeExclusionName,
  clampWatchDebounceSeconds,
} = require("./config");

const DXF_EXT = ".dxf";

function isDxfPath(p) {
  return path.extname(p).toLowerCase() === DXF_EXT;
}

function isValidSourceType(sourceType) {
  return sourceType === "ATACADO" || sourceType === "VAREJO";
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

  /** @type {Map<string, NodeJS.Timeout>} timers por chave */
  const timers = new Map();
  /** @type {Map<string, {eventType: string, relativePath: string}>} */
  const lastEvents = new Map();

  let watcher = null;
  let started = false;
  let closed = false;

  function makeKey(root, customerFolder) {
    return `${root.sourceType}\u0000${root.path}\u0000${customerFolder}`;
  }

  function scheduleSync(eventType, file) {
    if (closed) return;
    if (!isDxfPath(file)) return;

    const located = locateInRoots(file, roots);
    if (!located) return;

    const { root, customerFolder, relativePath } = located;

    // Exclusão vale APENAS no primeiro nível do root (customerFolder),
    // e é específica por sourceType.
    if (isExcludedCustomerFolder(root, customerFolder)) {
      return;
    }

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

    watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      persistent: true,
      // Evita disparar antes do arquivo terminar de ser gravado (Windows).
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500,
      },
      // Filtra extensões e exclusões na entrada para não criar watchers
      // em árvores desnecessárias.
      ignored: (p, stats) => {
        // Não ignorar diretórios por nome: exclusão vale apenas para o
        // primeiro nível do root (pasta do cliente), e subpastas internas
        // devem continuar observáveis.
        if (stats && stats.isDirectory && stats.isDirectory()) return false;
        // Para arquivos: só interessam .dxf.
        const ext = path.extname(p);
        if (!ext) return false; // sem extensão: pode ser dir não inspecionado
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
      `[watch] enabled: roots=${roots.length} debounce=${Math.round(debounceMs / 1000)}s`,
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
