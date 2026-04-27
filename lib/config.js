"use strict";

const fs = require("fs/promises");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const DEFAULT_CONFIG = {
  erpApiUrl: "",
  apiKey: "",
  syncIntervalMinutes: 15,
  thumbConcurrency: 4,
  roots: [],
  excludedFolders: [],
  lastSync: null,
};

/**
 * Normaliza um nome de pasta usado em excludedFolders.
 * Aplica NFKC + trim + lowercase.
 * Retorna null para nomes inválidos:
 *   - vazios (após trim)
 *   - "." ou ".."
 *   - contendo "/" ou "\"
 */
function normalizeExclusionName(raw) {
  if (typeof raw !== "string") return null;

  const normalized = raw.normalize("NFKC").trim().toLowerCase();

  if (!normalized) return null;
  if (normalized === "." || normalized === "..") return null;
  if (normalized.includes("/") || normalized.includes("\\")) return null;

  return normalized;
}

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

module.exports = { readConfig, writeConfig, normalizeExclusionName };
