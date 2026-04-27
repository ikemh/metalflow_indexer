"use strict";

const express = require("express");
const path = require("path");
const {
  readConfig,
  writeConfig,
  normalizeExclusionName,
} = require("./lib/config");
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
// Sync cycle
// ---------------------------------------------------------------------------

async function runSyncCycle() {
  if (state.running) {
    pushLog("warn", "[sync] Cycle already running, skipping");
    return { skipped: true };
  }

  state.running = true;
  state.cycleCount++;
  const cycleNum = state.cycleCount;
  const startedAt = Date.now();

  pushLog("info", `[sync] Cycle #${cycleNum} START`);

  try {
    const config = await readConfig();

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

    for (const root of config.roots) {
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
        customers = await discoverCustomers(root.path);
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
        const customerPath = path.join(root.path, customerFolder);

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

        folders.push({
          folderName: customerFolder,
          sourceType: root.sourceType,
          rootPath: normalizedRoot,
          fileCount: files.length,
          isCompleteScan,
          lastSeenAt: new Date().toISOString(),
        });

        totalCustomers++;
        totalFiles += files.length;

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
            pushLog("warn", `[sync] Empty folder register failed ${customerFolder}: ${emptyResult.error}`);
          }
          continue;
        }

        const thumbResult = await generateThumbsForFiles(files, customerPath, {
          concurrency: clampThumbConcurrency(config.thumbConcurrency),
          customerLabel: customerFolder,
        });
        const filesWithThumbs = thumbResult.files;
        const thumbStats = thumbResult.stats;

        // Resumo por cliente é só para casos com algum evento relevante.
        // Se foi tudo cache (ou nada), o terminal fica limpo.
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
          const d = syncResult.data;
          if (d.created || d.updated || d.deleted) {
            pushLog(
              "info",
              `[sync] ${customerFolder}: +${d.created} ~${d.updated} -${d.deleted} (${d.total} total)`,
            );
          }
          totalCreated += d.created || 0;
          totalUpdated += d.updated || 0;
          totalDeleted += d.deleted || 0;
        } else {
          pushLog(
            "error",
            `[sync] FAILED ${customerFolder}: ${syncResult.error}`,
          );
          totalErrors++;
        }
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

// ---------------------------------------------------------------------------
// Restart periodic timer (after config changes)
// ---------------------------------------------------------------------------

async function restartTimer() {
  if (syncTimer) clearInterval(syncTimer);
  const config = await readConfig();
  const intervalMs = (config.syncIntervalMinutes || 15) * 60 * 1000;
  syncTimer = setInterval(runSyncCycle, intervalMs);
  pushLog(
    "info",
    `[indexer] Timer restarted: ${config.syncIntervalMinutes || 15}min`,
  );
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
    roots: config.roots || [],
    lastSync: config.lastSync,
  });
});

app.patch("/api/config", async (req, res) => {
  const config = await readConfig();
  const allowed = ["erpApiUrl", "apiKey", "syncIntervalMinutes", "thumbConcurrency"];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      config[key] = req.body[key];
    }
  }

  await writeConfig(config);
  await restartTimer();

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

  res.json({ ok: true });
});

// --- API: Excluded Folders ---

app.get("/api/exclusions", async (_req, res) => {
  try {
    const config = await readConfig();
    const exclusions = (config.excludedFolders || []).map((e, i) => ({
      index: i,
      ...e,
    }));
    res.json(exclusions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/exclusions", async (req, res) => {
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
    (e) => normalizeExclusionName(e?.folderName) === normalized,
  );
  if (duplicate) {
    return res.status(409).json({ error: "Pasta já está excluída." });
  }

  list.push({ folderName: normalized });
  config.excludedFolders = list;

  try {
    await writeConfig(config);
  } catch (err) {
    return res.status(500).json({ error: `Falha ao salvar config: ${err.message}` });
  }

  // Invalida cache do scanner imediatamente.
  clearExcludedFoldersCache();

  pushLog("info", `[config] Exclusion added: ${normalized}`);
  res.json({ ok: true, index: list.length - 1, folderName: normalized });
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
  res.json({ ok: true });
});

// --- API: Manual sync ---

app.post("/api/sync", async (_req, res) => {
  if (state.running) {
    return res.status(409).json({ error: "Sync already running" });
  }

  res.json({ ok: true, message: "Sync started" });
  runSyncCycle();
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

  await runSyncCycle();

  syncTimer = setInterval(runSyncCycle, intervalMs);
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`\n[indexer] ${signal} received, shutting down...`);
  if (syncTimer) clearInterval(syncTimer);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  console.error(`[indexer] Fatal startup error: ${err.message}`);
  process.exit(1);
});
