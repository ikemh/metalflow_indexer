"use strict";

const express = require("express");
const path = require("path");
const { readConfig, writeConfig } = require("./lib/config");
const { scanFolder } = require("./lib/scanner");
const { pushFilesToErp } = require("./lib/sync");
const { generateThumbsForFiles } = require("./lib/thumbgen");

const PORT = process.env.PORT || 4000;
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/thumbs", express.static(path.join(__dirname, "thumbs")));

// Estado em memória do último sync
let syncStatus = null;
let syncing = false;

// ─── Config ──────────────────────────────────────────────────────────────────

app.get("/api/config", async (_req, res) => {
  const config = await readConfig();
  res.json({ erpApiUrl: config.erpApiUrl, apiKey: config.apiKey });
});

app.post("/api/config", async (req, res) => {
  const { erpApiUrl, apiKey } = req.body;
  if (typeof erpApiUrl !== "string" || typeof apiKey !== "string") {
    return res
      .status(400)
      .json({ error: "erpApiUrl e apiKey são obrigatórios" });
  }
  const config = await readConfig();
  config.erpApiUrl = erpApiUrl.trim();
  config.apiKey = apiKey.trim();
  await writeConfig(config);
  res.json({ ok: true });
});

// ─── Mapeamentos ─────────────────────────────────────────────────────────────

app.get("/api/mappings", async (_req, res) => {
  const config = await readConfig();
  res.json(config.mappings);
});

app.post("/api/mappings", async (req, res) => {
  const { folder, customerId, customerName } = req.body;
  if (!folder || !customerId) {
    return res
      .status(400)
      .json({ error: "folder e customerId são obrigatórios" });
  }
  const config = await readConfig();
  const already = config.mappings.find(
    (m) => m.folder === folder && m.customerId === customerId,
  );
  if (already) {
    return res.status(409).json({ error: "Mapeamento já existe" });
  }
  config.mappings.push({
    folder: folder.trim(),
    customerId,
    customerName: customerName || "",
  });
  await writeConfig(config);
  res.json({ ok: true, mappings: config.mappings });
});

app.delete("/api/mappings/:idx", async (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  const config = await readConfig();
  if (isNaN(idx) || idx < 0 || idx >= config.mappings.length) {
    return res.status(404).json({ error: "Índice inválido" });
  }
  config.mappings.splice(idx, 1);
  await writeConfig(config);
  res.json({ ok: true, mappings: config.mappings });
});

// ─── Clientes (proxy para o ERP) ─────────────────────────────────────────────

app.get("/api/customers", async (_req, res) => {
  const config = await readConfig();
  if (!config.erpApiUrl) {
    return res
      .status(400)
      .json({ error: "ERP não configurado. Acesse Configurações." });
  }
  try {
    const response = await fetch(
      `${config.erpApiUrl.replace(/\/$/, "")}/customers`,
    );
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `ERP retornou HTTP ${response.status}` });
    }
    const customers = await response.json();
    res.json(customers);
  } catch (err) {
    res
      .status(502)
      .json({ error: `Não foi possível conectar ao ERP: ${err.message}` });
  }
});

// ─── Sync ────────────────────────────────────────────────────────────────────

app.get("/api/sync/status", (_req, res) => {
  res.json(syncStatus);
});

app.post("/api/sync", async (_req, res) => {
  if (syncing) {
    return res.status(409).json({ error: "Sincronização já em andamento" });
  }

  const config = await readConfig();
  if (!config.erpApiUrl || !config.apiKey) {
    return res.status(400).json({
      error: "Configure a URL do ERP e a API Key antes de sincronizar.",
    });
  }
  if (config.mappings.length === 0) {
    return res.status(400).json({ error: "Nenhum mapeamento configurado." });
  }

  syncing = true;
  const startedAt = Date.now();
  const results = [];

  try {
    for (const mapping of config.mappings) {
      const { files, warnings } = await scanFolder(mapping.folder);
      const filesWithThumbs = await generateThumbsForFiles(
        files,
        mapping.folder,
      );
      const pushResult = await pushFilesToErp(
        config.erpApiUrl,
        config.apiKey,
        mapping.customerId,
        filesWithThumbs,
      );

      results.push({
        folder: mapping.folder,
        customerId: mapping.customerId,
        customerName: mapping.customerName || mapping.customerId,
        scannedFiles: files.length,
        warnings,
        push: pushResult,
      });
    }

    syncStatus = {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      totalMappings: config.mappings.length,
      results,
    };

    config.lastSync = syncStatus.finishedAt;
    await writeConfig(config);
  } finally {
    syncing = false;
  }

  res.json(syncStatus);
});

// ─── Inicialização ───────────────────────────────────────────────────────────

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Indexador rodando em http://localhost:${PORT}`);
  console.log("Abra o endereço acima no navegador para acessar a interface.");
});
