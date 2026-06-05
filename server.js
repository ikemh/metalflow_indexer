"use strict";

const express = require("express");
const path = require("path");
const {
  readConfig,
  writeConfig,
  normalizeExclusionName,
  coerceWatchEnabled,
  clampWatchDebounceSeconds,
  coerceBoolean,
  clampPositiveInt,
  resolveRunOnStartup,
  resolveCircuitBreakerEnabled,
  resolveCircuitBreakerFailureThreshold,
  resolveCircuitBreakerCooldownMinutes,
  resolveMaxConsecutiveSyncErrors,
} = require("./lib/config");
const {
  safetyState,
  isCircuitOpen,
  recordSyncSuccess,
  recordSyncFailure,
} = require("./lib/safety");
const {
  discoverCustomers,
  scanFolder,
  isRootAccessible,
  normalizeRootPath,
  clearExcludedFoldersCache,
} = require("./lib/scanner");
const {
  checkBackendHealth,
  uploadThumbToErp,
  batchSyncToErp,
} = require("./lib/sync");
const { generateThumbsForFiles } = require("./lib/thumbgen");
const { createWatcher } = require("./lib/watcher");

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  running: false,
  lastSync: null,
  lastDurationMs: null,
  lastError: null,
  cycleCount: 0,
  discoveredFolders: [],
};

const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();

  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}

let syncTimer = null;
let watcherInstance = null;

/**
 * Fila serializada para evitar concorrência entre o sync periódico e o
 * sync parcial vindo do watcher. Tudo passa por aqui em ordem FIFO.
 *
 * Garante:
 *   - dois `runSyncCycle` nunca rodam em paralelo
 *   - sync parcial do watcher nunca cruza com sync completo do timer
 *   - dois eventos para o mesmo cliente (após debounce) são executados
 *     sequencialmente (e o segundo encontra o estado já consolidado)
 */
let syncQueue = Promise.resolve();
function enqueueSync(label, fn) {
  syncQueue = syncQueue
    .catch(() => {})
    .then(() => fn())
    .catch((err) => {
      pushLog("error", `[queue] ${label} crashed: ${err.message}`);
    });
  return syncQueue;
}

/**
 * Valida e satura `thumbConcurrency` da config:
 *   - converte para número (descarta strings/NaN)
 *   - default 4 se ausente/null/string vazia/NaN
 *   - clamp para [1, 8] (0 ou negativo viram 1; > 8 viram 8)
 *   - aplicado ANTES de criar workers em thumbgen
 */
function clampThumbConcurrency(raw) {
  if (raw === null || raw === undefined || raw === "") return 4;
  let n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return 4;
  n = Math.floor(n);
  if (n < 1) n = 1;
  if (n > 8) n = 8;
  return n;
}

// ---------------------------------------------------------------------------
// Sync — função reutilizável por cliente
// ---------------------------------------------------------------------------

/**
 * Sincroniza UMA pasta de cliente (root + customerFolder) com o backend ERP.
 *
 * Reutilizada por:
 *   - runSyncCycle() — itera todos os clientes de todos os roots;
 *   - watcher       — sincroniza apenas o cliente afetado por um evento.
 *
 * Retorna estatísticas para o caller agregar.
 *
 * Atenção: NÃO toca em state.running. A serialização entre chamadas é
 * responsabilidade do caller (via enqueueSync).
 */
async function syncCustomerFolder(config, root, customerFolder, options = {}) {
  const { source = "cycle" } = options;
  const normalizedRoot = normalizeRootPath(root.path);
  const customerPath = path.join(root.path, customerFolder);

  const result = {
    customerFolder,
    sourceType: root.sourceType,
    rootPath: normalizedRoot,
    fileCount: 0,
    isCompleteScan: false,
    created: 0,
    updated: 0,
    deleted: 0,
    error: null,
    source,
  };

  const { files, warnings } = await scanFolder(
    customerPath,
    root.sourceType,
    customerFolder,
  );

  const hasWarnings = warnings.length > 0;
  if (hasWarnings) {
    for (const w of warnings) {
      pushLog("warn", `[scan] ${w.type}: ${w.message}`);
    }
  }

  const isCompleteScan = !hasWarnings;
  result.isCompleteScan = isCompleteScan;
  result.fileCount = files.length;

  if (files.length === 0) {
    const emptyResult = await batchSyncToErp(
      config.erpApiUrl,
      config.apiKey,
      customerFolder,
      root.sourceType,
      normalizedRoot,
      isCompleteScan,
      [],
    );
    if (!emptyResult.ok) {
      recordSyncFailure(config, emptyResult.error, pushLog);
      pushLog(
        "warn",
        `[sync] Empty folder register failed ${customerFolder}: ${emptyResult.error}`,
      );
      result.error = emptyResult.error;
    } else {
      recordSyncSuccess(config);
    }
    return result;
  }

  const thumbResult = await generateThumbsForFiles(files, customerPath, {
    concurrency: clampThumbConcurrency(config.thumbConcurrency),
    customerLabel: customerFolder,
  });
  const filesWithThumbs = thumbResult.files;
  const thumbStats = thumbResult.stats;

  const hasThumbEvents =
    thumbStats.ok > 0 ||
    thumbStats.failed > 0 ||
    thumbStats.timeout > 0 ||
    thumbStats.missing > 0 ||
    thumbStats.locked > 0;

  if (hasThumbEvents) {
    pushLog(
      "info",
      `[thumb] ${customerFolder}: ok=${thumbStats.ok} cached=${thumbStats.cached} failed=${thumbStats.failed} timeout=${thumbStats.timeout} missing=${thumbStats.missing} locked=${thumbStats.locked}`,
    );
  }

  for (const file of filesWithThumbs) {
    if (file.thumbnailPath && !file.thumbCached) {
      const uploadResult = await uploadThumbToErp(
        config.erpApiUrl,
        config.apiKey,
        file.id,
        file.thumbnailPath,
      );
      if (uploadResult.ok) {
        file.thumbnailUrl = uploadResult.thumbnailUrl;
      } else {
        pushLog(
          "warn",
          `[thumb] Upload failed for ${file.fileName}: ${uploadResult.error}`,
        );
      }
    }
  }

  // IMPORTANTE: payload do backend NUNCA inclui `absolutePath`.
  // Esse campo é apenas interno (usado pelo gerador de thumbs).
  const syncPayload = filesWithThumbs.map((f) => ({
    fileName: f.fileName,
    relativePath: f.relativePath,
    extension: f.extension,
    sizeBytes: f.sizeBytes,
    lastModifiedAt: f.lastModifiedAt,
    thumbnailUrl: f.thumbnailUrl || null,
  }));

  const syncResult = await batchSyncToErp(
    config.erpApiUrl,
    config.apiKey,
    customerFolder,
    root.sourceType,
    normalizedRoot,
    isCompleteScan,
    syncPayload,
  );

  if (syncResult.ok) {
    recordSyncSuccess(config);
    const d = syncResult.data || {};
    if (d.created || d.updated || d.deleted) {
      pushLog(
        "info",
        `[sync] ${customerFolder}: +${d.created || 0} ~${d.updated || 0} -${d.deleted || 0} (${d.total || 0} total)`,
      );
    }
    result.created = d.created || 0;
    result.updated = d.updated || 0;
    result.deleted = d.deleted || 0;
  } else {
    recordSyncFailure(config, syncResult.error, pushLog);
    pushLog("error", `[sync] FAILED ${customerFolder}: ${syncResult.error}`);
    result.error = syncResult.error;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sync cycle (varredura completa)
// ---------------------------------------------------------------------------

async function runSyncCycle(options = {}) {
  const { bypassCircuitBreaker = false } = options;

  if (state.running) {
    pushLog("warn", "[sync] Cycle already running, skipping");
    return { skipped: true };
  }

  const config = await readConfig();

  if (!bypassCircuitBreaker && isCircuitOpen(config)) {
    pushLog("warn", "[safety] Sync cycle skipped: circuit breaker open");
    return { skipped: true, reason: "circuit_open" };
  }

  state.running = true;
  state.cycleCount++;
  const cycleNum = state.cycleCount;
  const startedAt = Date.now();

  pushLog("info", `[sync] Cycle #${cycleNum} START`);

  try {
    if (!config.erpApiUrl || !config.apiKey) {
      pushLog("error", "[sync] Missing erpApiUrl or apiKey in config");
      return { error: "Missing config" };
    }

    if (!config.roots || config.roots.length === 0) {
      pushLog("error", "[sync] No roots configured");
      return { error: "No roots" };
    }

    const healthy = await checkBackendHealth(config.erpApiUrl);
    if (!healthy) {
      pushLog("error", "[sync] Backend unreachable, skipping cycle");
      state.lastError = "Backend unreachable";
      return { error: "Backend unreachable" };
    }

    let totalFiles = 0;
    let totalCustomers = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    const folders = [];
    let circuitInterrupted = false;

    for (const root of config.roots) {
      if (circuitInterrupted) break;

      const normalizedRoot = normalizeRootPath(root.path);
      pushLog("info", `[root] ${root.path} (${root.sourceType})`);

      const accessible = await isRootAccessible(root.path);
      if (!accessible) {
        pushLog("error", `[root] INACCESSIBLE: ${root.path} — skipping`);
        totalErrors++;
        continue;
      }

      let customers;
      try {
        customers = await discoverCustomers(root.path, root.sourceType);
      } catch (err) {
        pushLog(
          "error",
          `[root] Failed to discover customers: ${err.message}`,
        );
        totalErrors++;
        continue;
      }

      pushLog("info", `[root] Found ${customers.length} customer folders`);

      for (const customerFolder of customers) {
        if (!bypassCircuitBreaker && isCircuitOpen(config)) {
          pushLog(
            "warn",
            "[safety] Sync cycle interrupted: circuit breaker opened mid-cycle",
          );
          circuitInterrupted = true;
          break;
        }

        const r = await syncCustomerFolder(config, root, customerFolder, {
          source: "cycle",
        });

        folders.push({
          folderName: r.customerFolder,
          sourceType: r.sourceType,
          rootPath: normalizedRoot,
          fileCount: r.fileCount,
          isCompleteScan: r.isCompleteScan,
          lastSeenAt: new Date().toISOString(),
        });

        totalCustomers++;
        totalFiles += r.fileCount;
        totalCreated += r.created;
        totalUpdated += r.updated;
        totalDeleted += r.deleted;
        if (r.error) totalErrors++;
      }
    }

    const durationMs = Date.now() - startedAt;

    config.lastSync = new Date().toISOString();
    await writeConfig(config);

    state.lastSync = config.lastSync;
    state.lastDurationMs = durationMs;
    state.lastError = totalErrors > 0 ? `${totalErrors} errors` : null;
    state.discoveredFolders = folders;

    pushLog(
      "info",
      `[sync] Cycle #${cycleNum} DONE in ${(durationMs / 1000).toFixed(1)}s — customers=${totalCustomers} files=${totalFiles} +${totalCreated} ~${totalUpdated} -${totalDeleted} errors=${totalErrors}`,
    );

    return {
      cycle: cycleNum,
      durationMs,
      totalCustomers,
      totalFiles,
      totalCreated,
      totalUpdated,
      totalDeleted,
      totalErrors,
    };
  } catch (err) {
    pushLog("error", `[sync] Cycle #${cycleNum} CRASHED: ${err.message}`);
    state.lastError = err.message;
    return { error: err.message };
  } finally {
    state.running = false;
  }
}

/**
 * Sincroniza um único cliente em resposta a evento do watcher.
 * Sempre passa pela `enqueueSync` para nunca cruzar com runSyncCycle.
 *
 * Não usa state.running diretamente — a fila já garante exclusão mútua.
 */
async function syncSingleCustomer(root, customerFolder) {
  const config = await readConfig();

  if (isCircuitOpen(config)) {
    pushLog("warn", "[watch] sync skipped because circuit breaker is open");
    return;
  }

  if (!config.erpApiUrl || !config.apiKey) {
    pushLog(
      "warn",
      `[watch] missing erpApiUrl/apiKey, skipping ${customerFolder}`,
    );
    return;
  }

  const accessible = await isRootAccessible(root.path);
  if (!accessible) {
    pushLog(
      "warn",
      `[watch] root inaccessible (${root.path}), skipping ${customerFolder}`,
    );
    return;
  }

  const healthy = await checkBackendHealth(config.erpApiUrl);
  if (!healthy) {
    pushLog(
      "warn",
      `[watch] backend unreachable, skipping ${customerFolder}`,
    );
    return;
  }

  await syncCustomerFolder(config, root, customerFolder, { source: "watch" });
}

// ---------------------------------------------------------------------------
// Restart periodic timer (after config changes)
// ---------------------------------------------------------------------------

function scheduleCycle(options = {}) {
  enqueueSync("cycle", () => runSyncCycle(options));
}

async function restartTimer() {
  if (syncTimer) clearInterval(syncTimer);
  const config = await readConfig();
  const intervalMs = (config.syncIntervalMinutes || 15) * 60 * 1000;
  syncTimer = setInterval(scheduleCycle, intervalMs);
  pushLog(
    "info",
    `[indexer] Timer restarted: ${config.syncIntervalMinutes || 15}min`,
  );
}

// ---------------------------------------------------------------------------
// Watcher lifecycle
// ---------------------------------------------------------------------------

/**
 * (Re)inicia o watcher conforme config atual.
 *
 * Chamado:
 *   - no startup, após carregar a config;
 *   - após PATCH /api/config se watchEnabled/watchDebounceSeconds mudarem;
 *   - após mutações em /api/roots ou /api/exclusions (para refletir
 *     mudança na lista de pastas observadas).
 *
 * Política:
 *   - se watchEnabled === false, fecha watcher anterior (se existir) e
 *     loga `[watch] disabled`.
 *   - se watchEnabled === true e há pelo menos 1 root, cria/recria o
 *     watcher e loga `[watch] enabled: roots=N debounce=Xs`.
 */
async function applyWatcherConfig() {
  if (watcherInstance) {
    try {
      await watcherInstance.close();
    } catch (err) {
      pushLog("warn", `[watch] close error: ${err.message}`);
    }
    watcherInstance = null;
  }

  const config = await readConfig();

  if (!coerceWatchEnabled(config.watchEnabled)) {
    pushLog("info", "[watch] disabled");
    return;
  }

  watcherInstance = createWatcher({
    config,
    log: pushLog,
    onCustomerChanged: ({ root, customerFolder }) => {
      // Enfileira: nunca roda sync parcial em paralelo com sync completo
      // ou com outro sync parcial.
      enqueueSync(`watch:${customerFolder}`, () =>
        syncSingleCustomer(root, customerFolder),
      );
    },
  });

  watcherInstance.start();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Health ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ...state });
});

// --- API: Status ---

app.get("/api/status", async (_req, res) => {
  const config = await readConfig();
  res.json({
    running: state.running,
    lastSync: state.lastSync,
    lastDurationMs: state.lastDurationMs,
    lastError: state.lastError,
    cycleCount: state.cycleCount,
    syncIntervalMinutes: config.syncIntervalMinutes || 15,
    rootCount: (config.roots || []).length,
    discoveredFolders: state.discoveredFolders,
    circuitOpen: isCircuitOpen(config),
    circuitOpenUntil: safetyState.circuitOpenUntil
      ? safetyState.circuitOpenUntil.toISOString()
      : null,
    consecutiveSyncFailures: safetyState.consecutiveSyncFailures,
    lastCircuitReason: safetyState.lastCircuitReason,
    runOnStartup: resolveRunOnStartup(config),
    watchEnabled: coerceWatchEnabled(config.watchEnabled),
  });
});

// --- API: Logs ---

app.get("/api/logs", (req, res) => {
  const level = req.query.level;
  const entries = level
    ? logBuffer.filter((e) => e.level === level)
    : logBuffer;
  res.json(entries.slice(-100));
});

// --- API: Config ---

app.get("/api/config", async (_req, res) => {
  const config = await readConfig();
  res.json({
    erpApiUrl: config.erpApiUrl || "",
    syncIntervalMinutes: config.syncIntervalMinutes || 15,
    thumbConcurrency: config.thumbConcurrency || 4,
    watchEnabled: coerceWatchEnabled(config.watchEnabled),
    watchDebounceSeconds: clampWatchDebounceSeconds(config.watchDebounceSeconds),
    runOnStartup: resolveRunOnStartup(config),
    circuitBreakerEnabled: resolveCircuitBreakerEnabled(config),
    circuitBreakerFailureThreshold: resolveCircuitBreakerFailureThreshold(config),
    circuitBreakerCooldownMinutes: resolveCircuitBreakerCooldownMinutes(config),
    maxConsecutiveSyncErrors: resolveMaxConsecutiveSyncErrors(config),
    roots: config.roots || [],
    lastSync: config.lastSync,
  });
});

app.patch("/api/config", async (req, res) => {
  const config = await readConfig();
  const allowed = [
    "erpApiUrl",
    "apiKey",
    "syncIntervalMinutes",
    "thumbConcurrency",
    "watchEnabled",
    "watchDebounceSeconds",
    "runOnStartup",
    "circuitBreakerEnabled",
    "circuitBreakerFailureThreshold",
    "circuitBreakerCooldownMinutes",
    "maxConsecutiveSyncErrors",
  ];

  // Snapshot para detectar mudanças relevantes ao watcher.
  const prevWatchEnabled = coerceWatchEnabled(config.watchEnabled);
  const prevWatchDebounce = clampWatchDebounceSeconds(
    config.watchDebounceSeconds,
  );

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === "watchEnabled") {
        config.watchEnabled = coerceWatchEnabled(req.body.watchEnabled);
      } else if (key === "watchDebounceSeconds") {
        config.watchDebounceSeconds = clampWatchDebounceSeconds(
          req.body.watchDebounceSeconds,
        );
      } else if (key === "runOnStartup") {
        config.runOnStartup = coerceBoolean(req.body.runOnStartup, false);
      } else if (key === "circuitBreakerEnabled") {
        config.circuitBreakerEnabled = coerceBoolean(
          req.body.circuitBreakerEnabled,
          true,
        );
      } else if (key === "circuitBreakerFailureThreshold") {
        config.circuitBreakerFailureThreshold = clampPositiveInt(
          req.body.circuitBreakerFailureThreshold,
          { default: 3, min: 1, max: 100 },
        );
      } else if (key === "circuitBreakerCooldownMinutes") {
        config.circuitBreakerCooldownMinutes = clampPositiveInt(
          req.body.circuitBreakerCooldownMinutes,
          { default: 30, min: 1, max: 1440 },
        );
      } else if (key === "maxConsecutiveSyncErrors") {
        config.maxConsecutiveSyncErrors = clampPositiveInt(
          req.body.maxConsecutiveSyncErrors,
          { default: 3, min: 1, max: 100 },
        );
      } else {
        config[key] = req.body[key];
      }
    }
  }

  await writeConfig(config);
  await restartTimer();

  const newWatchEnabled = coerceWatchEnabled(config.watchEnabled);
  const newWatchDebounce = clampWatchDebounceSeconds(
    config.watchDebounceSeconds,
  );

  if (
    newWatchEnabled !== prevWatchEnabled ||
    newWatchDebounce !== prevWatchDebounce
  ) {
    await applyWatcherConfig();
  }

  res.json({ ok: true });
});

// --- API: Roots ---

app.get("/api/roots", async (_req, res) => {
  const config = await readConfig();
  const roots = (config.roots || []).map((r, i) => ({ index: i, ...r }));
  res.json(roots);
});

app.post("/api/roots", async (req, res) => {
  const { path: rootPath, sourceType } = req.body;
  if (!rootPath || !sourceType) {
    return res.status(400).json({ error: "path and sourceType required" });
  }
  if (!["ATACADO", "VAREJO"].includes(sourceType)) {
    return res.status(400).json({ error: "sourceType must be ATACADO or VAREJO" });
  }

  const config = await readConfig();
  config.roots = config.roots || [];
  config.roots.push({ path: rootPath, sourceType });
  await writeConfig(config);

  if (coerceWatchEnabled(config.watchEnabled)) await applyWatcherConfig();

  res.json({ ok: true, index: config.roots.length - 1 });
});

app.put("/api/roots/:index", async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const config = await readConfig();

  if (!config.roots || idx < 0 || idx >= config.roots.length) {
    return res.status(404).json({ error: "Root not found" });
  }

  const { path: rootPath, sourceType } = req.body;
  if (rootPath) config.roots[idx].path = rootPath;
  if (sourceType) {
    if (!["ATACADO", "VAREJO"].includes(sourceType)) {
      return res.status(400).json({ error: "sourceType must be ATACADO or VAREJO" });
    }
    config.roots[idx].sourceType = sourceType;
  }

  await writeConfig(config);

  if (coerceWatchEnabled(config.watchEnabled)) await applyWatcherConfig();

  res.json({ ok: true });
});

app.delete("/api/roots/:index", async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const config = await readConfig();

  if (!config.roots || idx < 0 || idx >= config.roots.length) {
    return res.status(404).json({ error: "Root not found" });
  }

  config.roots.splice(idx, 1);
  await writeConfig(config);

  if (coerceWatchEnabled(config.watchEnabled)) await applyWatcherConfig();

  res.json({ ok: true });
});

// --- API: Excluded Folders ---

app.get("/api/exclusions", async (_req, res) => {
  try {
    const config = await readConfig();
    const exclusions = (config.excludedFolders || []).map((e, i) => {
      const rawSourceType = e?.sourceType;
      const sourceType =
        rawSourceType === "ATACADO" || rawSourceType === "VAREJO"
          ? rawSourceType
          : null;

      // Compat defensiva: regras legadas sem sourceType aparecem na GUI
      // para o usuário corrigir, mas NÃO são aplicadas pelo scanner/watcher.
      const folderName = typeof e?.folderName === "string" ? e.folderName : "";
      const normalizedFolderName = normalizeExclusionName(folderName);

      return {
        index: i,
        sourceType,
        folderName,
        normalizedFolderName,
      };
    });
    res.json(exclusions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/exclusions", async (req, res) => {
  const sourceType = req.body && req.body.sourceType;
  if (!["ATACADO", "VAREJO"].includes(sourceType)) {
    return res.status(400).json({ error: "sourceType must be ATACADO or VAREJO" });
  }

  const raw = req.body && req.body.folderName;
  const normalized = normalizeExclusionName(raw);

  if (!normalized) {
    return res.status(400).json({
      error:
        "folderName inválido (vazio, '.', '..', ou contém '/' ou '\\').",
    });
  }

  const config = await readConfig();
  const list = Array.isArray(config.excludedFolders)
    ? config.excludedFolders
    : [];

  // Duplicata: comparar pela forma normalizada (NFKC + trim + lowercase),
  // de modo que "Antigos", "antigos " e "ANTIGOS" sejam todos a mesma exclusão.
  const duplicate = list.some(
    (e) =>
      e?.sourceType === sourceType &&
      normalizeExclusionName(e?.folderName) === normalized,
  );
  if (duplicate) {
    return res.status(409).json({ error: "Pasta já está excluída." });
  }

  list.push({ sourceType, folderName: normalized });
  config.excludedFolders = list;

  try {
    await writeConfig(config);
  } catch (err) {
    return res.status(500).json({ error: `Falha ao salvar config: ${err.message}` });
  }

  // Invalida cache do scanner imediatamente.
  clearExcludedFoldersCache();

  pushLog("info", `[config] Exclusion added: ${sourceType}:${normalized}`);

  if (coerceWatchEnabled(config.watchEnabled)) await applyWatcherConfig();

  res.json({
    ok: true,
    index: list.length - 1,
    sourceType,
    folderName: normalized,
  });
});

app.delete("/api/exclusions/:index", async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const config = await readConfig();

  if (
    !Array.isArray(config.excludedFolders) ||
    Number.isNaN(idx) ||
    idx < 0 ||
    idx >= config.excludedFolders.length
  ) {
    return res.status(404).json({ error: "Exclusion not found" });
  }

  const removed = config.excludedFolders[idx];
  config.excludedFolders.splice(idx, 1);

  try {
    await writeConfig(config);
  } catch (err) {
    return res.status(500).json({ error: `Falha ao salvar config: ${err.message}` });
  }

  clearExcludedFoldersCache();

  pushLog(
    "info",
    `[config] Exclusion removed: ${removed?.folderName ?? ""}`.trim(),
  );

  if (coerceWatchEnabled(config.watchEnabled)) await applyWatcherConfig();

  res.json({ ok: true });
});

// --- API: Manual sync ---

app.post("/api/sync", async (_req, res) => {
  if (state.running) {
    return res.status(409).json({ error: "Sync already running" });
  }

  res.json({ ok: true, message: "Sync started" });
  // Passa pela fila para nunca cruzar com sync parcial do watcher.
  // Sync manual ignora circuit breaker para permitir retry operacional.
  scheduleCycle({ bypassCircuitBreaker: true });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const config = await readConfig();
  const intervalMs = (config.syncIntervalMinutes || 15) * 60 * 1000;

  pushLog("info", "[indexer] Starting DXF File Indexer");
  pushLog("info", `[indexer] Backend: ${config.erpApiUrl}`);
  pushLog(
    "info",
    `[indexer] Roots: ${(config.roots || []).map((r) => `${r.path} (${r.sourceType})`).join(", ")}`,
  );
  pushLog(
    "info",
    `[indexer] Sync interval: ${config.syncIntervalMinutes || 15}min`,
  );
  pushLog(
    "info",
    `[indexer] GUI: http://localhost:${PORT}`,
  );

  app.listen(PORT, "0.0.0.0", () => {
    pushLog("info", `[indexer] HTTP listening on 0.0.0.0:${PORT}`);
  });

  // Watcher é opcional. O sync periódico continua sendo a fonte de verdade
  // — o watcher apenas reduz latência em produção Windows com disco local.
  // No ambiente local (Fedora + SMB + Tailscale), watchEnabled deve ficar false.
  await applyWatcherConfig();

  // Primeiro ciclo opcional + agendamento periódico, ambos passando pela fila.
  if (resolveRunOnStartup(config)) {
    scheduleCycle();
  } else {
    pushLog(
      "info",
      "[indexer] Startup sync disabled by config.runOnStartup=false",
    );
  }
  syncTimer = setInterval(scheduleCycle, intervalMs);
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[indexer] ${signal} received, shutting down...`);
  if (syncTimer) clearInterval(syncTimer);
  if (watcherInstance) {
    try {
      await watcherInstance.close();
    } catch (err) {
      console.error(`[indexer] watcher close error: ${err.message}`);
    }
    watcherInstance = null;
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  console.error(`[indexer] Fatal startup error: ${err.message}`);
  process.exit(1);
});
