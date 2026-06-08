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
  resolveSmartSyncEnabled,
  resolveFolderSignatureCacheEnabled,
  resolveMaxWatcherSyncsPerMinute,
  resolveSyncIntervalMinutes,
  resolveThumbConcurrency,
  resolveWatchUsePolling,
  resolveWatchIntervalMs,
  resolveWatchBinaryIntervalMs,
  resolveWatchStabilityThresholdMs,
  resolveWatchPollIntervalMs,
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
const {
  computeFolderSignature,
  makeFolderSignatureKey,
  loadSignatureCache,
  saveSignatureCache,
  getCachedSignature,
  setCachedSignature,
  signaturesEqual,
  isCacheDirty,
  getCache,
} = require("./lib/folder-signature");

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
// ---------------------------------------------------------------------------
// Watcher rate limiter state
// ---------------------------------------------------------------------------

const watcherRateState = {
  windowStartedAt: 0,
  startedInWindow: 0,
  deferredKeys: new Map(),
  flushTimer: null,
};

function resetWatcherRateLimiter() {
  if (watcherRateState.flushTimer) {
    clearTimeout(watcherRateState.flushTimer);
    watcherRateState.flushTimer = null;
  }
  watcherRateState.deferredKeys.clear();
  watcherRateState.windowStartedAt = 0;
  watcherRateState.startedInWindow = 0;
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
 * Smart skip: se config.smartSyncEnabled=true e source !== "manual-force",
 * calcula assinatura de metadados e pula pasta unchanged.
 *
 * Retorna estatísticas para o caller agregar.
 *
 * Atenção: NÃO toca em state.running. A serialização entre chamadas é
 * responsabilidade do caller (via enqueueSync).
 */
async function syncCustomerFolder(config, root, customerFolder, options = {}) {
  const { source = "cycle", bypassSmartSync = false } = options;
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
    skipped: false,
    smartSkipped: false,
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

  // --- Smart skip ---
  const smartEnabled = resolveSmartSyncEnabled(config);
  const cacheEnabled = resolveFolderSignatureCacheEnabled(config);
  const useSmartSkip =
    smartEnabled &&
    isCompleteScan &&
    !bypassSmartSync &&
    source !== "manual-force";

  if (smartEnabled && !isCompleteScan && !bypassSmartSync && source !== "manual-force") {
    pushLog(
      "info",
      `[smart] skip disabled for ${customerFolder} (${root.sourceType}/${source}) because scan is incomplete`,
    );
  }

  let currentSignature = null;
  let sigKey = null;

  if (useSmartSkip || cacheEnabled) {
    currentSignature = computeFolderSignature(files);
    sigKey = makeFolderSignatureKey({
      sourceType: root.sourceType,
      rootPath: normalizedRoot,
      customerFolder,
    });
  }

  if (useSmartSkip && currentSignature && sigKey) {
    const cachedSig = getCachedSignature(sigKey);
    if (cachedSig && signaturesEqual(currentSignature, cachedSig)) {
      pushLog(
        "info",
        `[smart] skipped unchanged folder ${customerFolder} (${root.sourceType}/${source}) files=${files.length}`,
      );
      result.skipped = true;
      result.smartSkipped = true;
      return result;
    }
  }

  // --- Normal sync flow ---
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
      // Cache signature for empty folder on success
      if (cacheEnabled && sigKey && currentSignature && isCompleteScan) {
        setCachedSignature(sigKey, currentSignature);
        pushLog(
          "info",
          `[smart] cached signature ${customerFolder} (${root.sourceType}/${source}) files=0`,
        );
      }
    }
    return result;
  }

  const thumbResult = await generateThumbsForFiles(files, customerPath, {
    concurrency: resolveThumbConcurrency(config),
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

  // Transient issues = thumb may succeed on next scan; unsafe to cache.
  // failed = usually permanently invalid DXFs; safe to cache.
  const hasTransientThumbIssues =
    thumbStats.timeout > 0 ||
    thumbStats.locked > 0 ||
    thumbStats.missing > 0;

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

    // Update signature cache only on complete scan + sync success + no transient thumb issues
    if (cacheEnabled && sigKey && currentSignature && isCompleteScan && !hasTransientThumbIssues) {
      setCachedSignature(sigKey, currentSignature);
      pushLog(
        "info",
        `[smart] cached signature ${customerFolder} (${root.sourceType}/${source}) files=${files.length}`,
      );
    } else if (cacheEnabled && sigKey && currentSignature && isCompleteScan && hasTransientThumbIssues) {
      pushLog(
        "info",
        `[smart] signature not cached for ${customerFolder} due to transient thumb issues timeout=${thumbStats.timeout} locked=${thumbStats.locked} missing=${thumbStats.missing}`,
      );
    }
  } else {
    recordSyncFailure(config, syncResult.error, pushLog);
    pushLog("error", `[sync] FAILED ${customerFolder}: ${syncResult.error}`);
    result.error = syncResult.error;
    // Do NOT update cache on failure
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

    // Load signature cache for smart skip
    const cacheEnabled = resolveFolderSignatureCacheEnabled(config);
    if (cacheEnabled) {
      const cachePath = path.resolve(
        path.join(__dirname, config.folderSignatureCachePath || "data/folder-signatures.json"),
      );
      await loadSignatureCache(cachePath);
    }

    let totalFiles = 0;
    let totalCustomers = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalErrors = 0;
    let totalSmartSkipped = 0;
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
          smartSkipped: r.smartSkipped || false,
          lastSeenAt: new Date().toISOString(),
        });

        totalCustomers++;
        totalFiles += r.fileCount;
        totalCreated += r.created;
        totalUpdated += r.updated;
        totalDeleted += r.deleted;
        if (r.error) totalErrors++;
        if (r.smartSkipped) totalSmartSkipped++;
      }
    }

    // Persist signature cache after cycle
    if (cacheEnabled && isCacheDirty()) {
      try {
        const cachePath = path.resolve(
          path.join(__dirname, config.folderSignatureCachePath || "data/folder-signatures.json"),
        );
        await saveSignatureCache(cachePath, getCache());
      } catch (err) {
        pushLog("warn", `[smart] failed to save signature cache: ${err.message}`);
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
      `[sync] Cycle #${cycleNum} DONE in ${(durationMs / 1000).toFixed(1)}s — customers=${totalCustomers} files=${totalFiles} skipped=${totalSmartSkipped} +${totalCreated} ~${totalUpdated} -${totalDeleted} errors=${totalErrors}`,
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
      totalSmartSkipped,
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

  // Load signature cache for smart skip
  const cacheEnabled = resolveFolderSignatureCacheEnabled(config);
  if (cacheEnabled) {
    const cachePath = path.resolve(
      path.join(__dirname, config.folderSignatureCachePath || "data/folder-signatures.json"),
    );
    await loadSignatureCache(cachePath);
  }

  await syncCustomerFolder(config, root, customerFolder, { source: "watch" });

  // Persist cache changes
  if (cacheEnabled && isCacheDirty()) {
    try {
      const cachePath = path.resolve(
        path.join(__dirname, config.folderSignatureCachePath || "data/folder-signatures.json"),
      );
      await saveSignatureCache(cachePath, getCache());
    } catch (err) {
      pushLog("warn", `[smart] failed to save signature cache: ${err.message}`);
    }
  }
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
  const minutes = resolveSyncIntervalMinutes(config);
  const intervalMs = minutes * 60 * 1000;
  syncTimer = setInterval(scheduleCycle, intervalMs);
  pushLog(
    "info",
    `[indexer] Timer restarted: ${minutes}min`,
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
  // Always reset rate limiter when reconfiguring watcher — stale deferred
  // events from a previous config must never enqueue syncs.
  resetWatcherRateLimiter();

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

  const maxPerMinute = resolveMaxWatcherSyncsPerMinute(config);

  watcherInstance = createWatcher({
    config,
    log: pushLog,
    onCustomerChanged: ({ root, customerFolder }) => {
      const key = `${root.sourceType}::${root.path}::${customerFolder}`;
      const now = Date.now();

      // Reset window if 60s elapsed
      if (now - watcherRateState.windowStartedAt >= 60000) {
        watcherRateState.windowStartedAt = now;
        watcherRateState.startedInWindow = 0;
      }

      if (watcherRateState.startedInWindow < maxPerMinute) {
        // Under limit: enqueue normally
        watcherRateState.startedInWindow++;
        enqueueSync(`watch:${customerFolder}`, () =>
          syncSingleCustomer(root, customerFolder),
        );
      } else {
        // Rate limit exceeded: defer
        pushLog(
          "warn",
          `[watch] rate limit reached, deferred ${customerFolder}`,
        );
        // Store the root+customerFolder for deferred flush
        watcherRateState.deferredKeys.set(key, { root, customerFolder });

        // Schedule flush if not already scheduled
        if (!watcherRateState.flushTimer) {
          const flushDeferred = () => {
            watcherRateState.flushTimer = null;
            const deferred = new Map(watcherRateState.deferredKeys);
            watcherRateState.deferredKeys.clear();
            // Reset window for the flush
            watcherRateState.windowStartedAt = Date.now();
            watcherRateState.startedInWindow = 0;

            for (const [, { root: dRoot, customerFolder: dFolder }] of deferred) {
              if (watcherRateState.startedInWindow < maxPerMinute) {
                watcherRateState.startedInWindow++;
                enqueueSync(`watch-deferred:${dFolder}`, () =>
                  syncSingleCustomer(dRoot, dFolder),
                );
              } else {
                // Still over limit, re-defer
                watcherRateState.deferredKeys.set(
                  `${dRoot.sourceType}::${dRoot.path}::${dFolder}`,
                  { root: dRoot, customerFolder: dFolder },
                );
              }
            }

            // If there are still deferred items, schedule another flush
            if (watcherRateState.deferredKeys.size > 0 && !watcherRateState.flushTimer) {
              watcherRateState.flushTimer = setTimeout(flushDeferred, 60000);
              if (typeof watcherRateState.flushTimer.unref === "function") {
                watcherRateState.flushTimer.unref();
              }
            }
          };
          watcherRateState.flushTimer = setTimeout(flushDeferred, 60000);
          if (typeof watcherRateState.flushTimer.unref === "function") {
            watcherRateState.flushTimer.unref();
          }
        }
      }
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
    syncIntervalMinutes: resolveSyncIntervalMinutes(config),
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
    smartSyncEnabled: resolveSmartSyncEnabled(config),
    maxWatcherSyncsPerMinute: resolveMaxWatcherSyncsPerMinute(config),
    watcherConfig: {
      usePolling: resolveWatchUsePolling(config),
      intervalMs: resolveWatchIntervalMs(config),
      binaryIntervalMs: resolveWatchBinaryIntervalMs(config),
      stabilityThresholdMs: resolveWatchStabilityThresholdMs(config),
      pollIntervalMs: resolveWatchPollIntervalMs(config),
      debounceSeconds: clampWatchDebounceSeconds(config.watchDebounceSeconds),
    },
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
    syncIntervalMinutes: resolveSyncIntervalMinutes(config),
    thumbConcurrency: resolveThumbConcurrency(config),
    watchEnabled: coerceWatchEnabled(config.watchEnabled),
    watchDebounceSeconds: clampWatchDebounceSeconds(config.watchDebounceSeconds),
    runOnStartup: resolveRunOnStartup(config),
    circuitBreakerEnabled: resolveCircuitBreakerEnabled(config),
    circuitBreakerFailureThreshold: resolveCircuitBreakerFailureThreshold(config),
    circuitBreakerCooldownMinutes: resolveCircuitBreakerCooldownMinutes(config),
    maxConsecutiveSyncErrors: resolveMaxConsecutiveSyncErrors(config),
    // Smart sync
    smartSyncEnabled: resolveSmartSyncEnabled(config),
    folderSignatureCacheEnabled: resolveFolderSignatureCacheEnabled(config),
    folderSignatureCachePath: config.folderSignatureCachePath || "data/folder-signatures.json",
    maxWatcherSyncsPerMinute: resolveMaxWatcherSyncsPerMinute(config),
    // Watcher tuning
    watchUsePolling: resolveWatchUsePolling(config),
    watchIntervalMs: resolveWatchIntervalMs(config),
    watchBinaryIntervalMs: resolveWatchBinaryIntervalMs(config),
    watchStabilityThresholdMs: resolveWatchStabilityThresholdMs(config),
    watchPollIntervalMs: resolveWatchPollIntervalMs(config),
    roots: config.roots || [],
    lastSync: config.lastSync,
  });
});

app.patch("/api/config", async (req, res) => {
  const config = await readConfig();

  // Snapshot para detectar mudanças relevantes ao watcher e timer.
  const prevWatchEnabled = coerceWatchEnabled(config.watchEnabled);
  const prevWatchDebounce = clampWatchDebounceSeconds(config.watchDebounceSeconds);
  const prevWatchIntervalMs = resolveWatchIntervalMs(config);
  const prevWatchBinaryIntervalMs = resolveWatchBinaryIntervalMs(config);
  const prevWatchUsePolling = resolveWatchUsePolling(config);
  const prevWatchStabilityThresholdMs = resolveWatchStabilityThresholdMs(config);
  const prevWatchPollIntervalMs = resolveWatchPollIntervalMs(config);
  const prevMaxWatcherSyncsPerMinute = resolveMaxWatcherSyncsPerMinute(config);
  const prevSyncIntervalMinutes = resolveSyncIntervalMinutes(config);

  // --- Apply fields with coercion/clamp ---
  const b = req.body;
  if (b.erpApiUrl !== undefined) config.erpApiUrl = b.erpApiUrl;
  if (b.apiKey !== undefined) config.apiKey = b.apiKey;
  if (b.syncIntervalMinutes !== undefined) {
    config.syncIntervalMinutes = clampPositiveInt(b.syncIntervalMinutes, { default: 720, min: 30, max: 1440 });
  }
  if (b.thumbConcurrency !== undefined) {
    config.thumbConcurrency = clampPositiveInt(b.thumbConcurrency, { default: 1, min: 1, max: 4 });
  }
  if (b.watchEnabled !== undefined) {
    config.watchEnabled = coerceWatchEnabled(b.watchEnabled);
  }
  if (b.watchDebounceSeconds !== undefined) {
    config.watchDebounceSeconds = clampWatchDebounceSeconds(b.watchDebounceSeconds);
  }
  if (b.runOnStartup !== undefined) {
    config.runOnStartup = coerceBoolean(b.runOnStartup, false);
  }
  if (b.circuitBreakerEnabled !== undefined) {
    config.circuitBreakerEnabled = coerceBoolean(b.circuitBreakerEnabled, true);
  }
  if (b.circuitBreakerFailureThreshold !== undefined) {
    config.circuitBreakerFailureThreshold = clampPositiveInt(b.circuitBreakerFailureThreshold, { default: 3, min: 1, max: 100 });
  }
  if (b.circuitBreakerCooldownMinutes !== undefined) {
    config.circuitBreakerCooldownMinutes = clampPositiveInt(b.circuitBreakerCooldownMinutes, { default: 30, min: 1, max: 1440 });
  }
  if (b.maxConsecutiveSyncErrors !== undefined) {
    config.maxConsecutiveSyncErrors = clampPositiveInt(b.maxConsecutiveSyncErrors, { default: 3, min: 1, max: 100 });
  }
  // Smart sync
  if (b.smartSyncEnabled !== undefined) {
    config.smartSyncEnabled = coerceBoolean(b.smartSyncEnabled, true);
  }
  if (b.folderSignatureCacheEnabled !== undefined) {
    config.folderSignatureCacheEnabled = coerceBoolean(b.folderSignatureCacheEnabled, true);
  }
  if (b.maxWatcherSyncsPerMinute !== undefined) {
    config.maxWatcherSyncsPerMinute = clampPositiveInt(b.maxWatcherSyncsPerMinute, { default: 10, min: 1, max: 120 });
  }
  // Watcher tuning
  if (b.watchUsePolling !== undefined) {
    config.watchUsePolling = coerceBoolean(b.watchUsePolling, true);
  }
  if (b.watchIntervalMs !== undefined) {
    config.watchIntervalMs = clampPositiveInt(b.watchIntervalMs, { default: 15000, min: 5000, max: 60000 });
  }
  if (b.watchBinaryIntervalMs !== undefined) {
    config.watchBinaryIntervalMs = clampPositiveInt(b.watchBinaryIntervalMs, { default: 30000, min: 10000, max: 120000 });
  }
  if (b.watchStabilityThresholdMs !== undefined) {
    config.watchStabilityThresholdMs = clampPositiveInt(b.watchStabilityThresholdMs, { default: 5000, min: 1000, max: 30000 });
  }
  if (b.watchPollIntervalMs !== undefined) {
    config.watchPollIntervalMs = clampPositiveInt(b.watchPollIntervalMs, { default: 1000, min: 500, max: 10000 });
  }

  await writeConfig(config);

  // Restart timer if interval changed
  const newSyncIntervalMinutes = resolveSyncIntervalMinutes(config);
  if (newSyncIntervalMinutes !== prevSyncIntervalMinutes) {
    await restartTimer();
  }

  // Restart watcher if any watch-related field changed
  const newWatchEnabled = coerceWatchEnabled(config.watchEnabled);
  const newWatchDebounce = clampWatchDebounceSeconds(config.watchDebounceSeconds);
  const needsWatcherRestart =
    newWatchEnabled !== prevWatchEnabled ||
    newWatchDebounce !== prevWatchDebounce ||
    resolveWatchIntervalMs(config) !== prevWatchIntervalMs ||
    resolveWatchBinaryIntervalMs(config) !== prevWatchBinaryIntervalMs ||
    resolveWatchUsePolling(config) !== prevWatchUsePolling ||
    resolveWatchStabilityThresholdMs(config) !== prevWatchStabilityThresholdMs ||
    resolveWatchPollIntervalMs(config) !== prevWatchPollIntervalMs ||
    resolveMaxWatcherSyncsPerMinute(config) !== prevMaxWatcherSyncsPerMinute;

  if (needsWatcherRestart) {
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
  const minutes = resolveSyncIntervalMinutes(config);
  const intervalMs = minutes * 60 * 1000;

  pushLog("info", "[indexer] Starting DXF File Indexer");
  pushLog("info", `[indexer] Backend: ${config.erpApiUrl}`);
  pushLog(
    "info",
    `[indexer] Roots: ${(config.roots || []).map((r) => `${r.path} (${r.sourceType})`).join(", ")}`,
  );
  pushLog(
    "info",
    `[indexer] Sync interval: ${minutes}min`,
  );
  pushLog(
    "info",
    `[indexer] Smart sync: ${resolveSmartSyncEnabled(config) ? "enabled" : "disabled"} | maxWatcherSyncsPerMinute=${resolveMaxWatcherSyncsPerMinute(config)}`,
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
  resetWatcherRateLimiter();
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
