"use strict";

const express = require("express");
const path = require("path");
const { readConfig, writeConfig } = require("./lib/config");
const { discoverCustomers, scanFolder, isRootAccessible } = require("./lib/scanner");
const { checkBackendHealth, uploadThumbToErp, batchSyncToErp } = require("./lib/sync");
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
};

let syncTimer = null;

// ---------------------------------------------------------------------------
// Sync cycle
// ---------------------------------------------------------------------------

async function runSyncCycle() {
  if (state.running) {
    console.log("[sync] Cycle already running, skipping");
    return;
  }

  state.running = true;
  state.cycleCount++;
  const cycleNum = state.cycleCount;
  const startedAt = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[sync] Cycle #${cycleNum} START`);
  console.log(`${"=".repeat(60)}`);

  try {
    const config = await readConfig();

    if (!config.erpApiUrl || !config.apiKey) {
      console.error("[sync] Missing erpApiUrl or apiKey in config");
      return;
    }

    if (!config.roots || config.roots.length === 0) {
      console.error("[sync] No roots configured");
      return;
    }

    const healthy = await checkBackendHealth(config.erpApiUrl);
    if (!healthy) {
      console.error("[sync] Backend unreachable, skipping cycle");
      state.lastError = "Backend unreachable";
      return;
    }

    let totalFiles = 0;
    let totalCustomers = 0;
    let totalCreated = 0;
    let totalUpdated = 0;
    let totalDeleted = 0;
    let totalErrors = 0;

    for (const root of config.roots) {
      console.log(`\n[root] ${root.path} (${root.sourceType})`);

      const accessible = await isRootAccessible(root.path);
      if (!accessible) {
        console.error(`[root] INACCESSIBLE: ${root.path} — skipping`);
        totalErrors++;
        continue;
      }

      let customers;
      try {
        customers = await discoverCustomers(root.path);
      } catch (err) {
        console.error(`[root] Failed to discover customers: ${err.message}`);
        totalErrors++;
        continue;
      }

      console.log(`[root] Found ${customers.length} customer folders`);

      for (const customerFolder of customers) {
        const customerPath = path.join(root.path, customerFolder);

        const { files, warnings } = await scanFolder(
          customerPath,
          root.sourceType,
          customerFolder,
        );

        if (warnings.length > 0) {
          for (const w of warnings) {
            console.warn(`[scan] ${w.type}: ${w.message}`);
          }
        }

        if (files.length === 0) continue;

        totalCustomers++;
        totalFiles += files.length;

        // Gerar thumbnails (READ-ONLY no filesystem de origem)
        const filesWithThumbs = await generateThumbsForFiles(
          files,
          customerPath,
          config.thumbConcurrency || 4,
        );

        // Upload de thumbnails novos ao backend
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
              console.warn(
                `[thumb] Upload failed for ${file.fileName}: ${uploadResult.error}`,
              );
            }
          }
        }

        // Batch sync para o backend
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
          syncPayload,
        );

        if (syncResult.ok) {
          const d = syncResult.data;
          if (d.created || d.updated || d.deleted) {
            console.log(
              `[sync] ${customerFolder}: +${d.created} ~${d.updated} -${d.deleted} (${d.total} total)`,
            );
          }
          totalCreated += d.created || 0;
          totalUpdated += d.updated || 0;
          totalDeleted += d.deleted || 0;
        } else {
          console.error(
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

    console.log(`\n${"─".repeat(60)}`);
    console.log(`[sync] Cycle #${cycleNum} DONE in ${(durationMs / 1000).toFixed(1)}s`);
    console.log(
      `[sync] customers=${totalCustomers} files=${totalFiles} +${totalCreated} ~${totalUpdated} -${totalDeleted} errors=${totalErrors}`,
    );
    console.log(`${"─".repeat(60)}\n`);
  } catch (err) {
    console.error(`[sync] Cycle #${cycleNum} CRASHED: ${err.message}`);
    state.lastError = err.message;
  } finally {
    state.running = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP (minimal — status only)
// ---------------------------------------------------------------------------

const app = express();

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    ...state,
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  const config = await readConfig();
  const intervalMs = (config.syncIntervalMinutes || 15) * 60 * 1000;

  console.log("[indexer] Starting DXF File Indexer");
  console.log(`[indexer] Backend: ${config.erpApiUrl}`);
  console.log(`[indexer] Roots: ${config.roots.map((r) => `${r.path} (${r.sourceType})`).join(", ")}`);
  console.log(`[indexer] Sync interval: ${config.syncIntervalMinutes || 15}min`);
  console.log(`[indexer] Health endpoint: http://localhost:${PORT}/health`);
  console.log("");

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[indexer] HTTP listening on 127.0.0.1:${PORT}`);
  });

  // Primeiro ciclo imediato
  await runSyncCycle();

  // Ciclos periódicos
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
