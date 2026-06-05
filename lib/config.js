"use strict";

const fs = require("fs/promises");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

/**
 * Defaults da config. O sync periódico (`syncIntervalMinutes`) NUNCA deve
 * ser desligado por padrão — o watcher é apenas adicional.
 *
 * watchEnabled / watchDebounceSeconds:
 *   - default desligado;
 *   - quando ligado, complementa (não substitui) o sync periódico;
 *   - recomendado apenas em produção Windows com disco local;
 *   - não recomendado para Fedora + SMB + Tailscale.
 */
const DEFAULT_CONFIG = {
  erpApiUrl: "",
  apiKey: "",
  syncIntervalMinutes: 15,
  thumbConcurrency: 4,
  roots: [],
  excludedFolders: [],
  watchEnabled: false,
  watchDebounceSeconds: 15,
  runOnStartup: false,
  circuitBreakerEnabled: true,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMinutes: 30,
  maxConsecutiveSyncErrors: 3,
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

/**
 * Coage `watchEnabled` para boolean estrito.
 * Aceita boolean nativo, "true"/"false" e variantes em maiúsculas.
 * Default: false.
 */
function coerceWatchEnabled(raw) {
  if (raw === true) return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") {
    return true;
  }
  return false;
}

/**
 * Valida e satura `watchDebounceSeconds`:
 *   - default 15 se ausente/null/string vazia/NaN
 *   - mínimo 5
 *   - máximo 120
 */
function clampWatchDebounceSeconds(raw) {
  if (raw === null || raw === undefined || raw === "") return 15;
  let n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return 15;
  n = Math.floor(n);
  if (n < 5) n = 5;
  if (n > 120) n = 120;
  return n;
}

/**
 * Coage valor para boolean estrito.
 * Aceita boolean nativo e strings "true"/"false".
 */
function coerceBoolean(raw, defaultValue = false) {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return defaultValue;
}

/**
 * Valida e satura inteiro positivo com limites opcionais.
 */
function clampPositiveInt(raw, { default: defaultValue, min = 1, max = 1440 } = {}) {
  if (raw === null || raw === undefined || raw === "") return defaultValue;
  let n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return defaultValue;
  n = Math.floor(n);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

function resolveRunOnStartup(config) {
  return coerceBoolean(config?.runOnStartup, DEFAULT_CONFIG.runOnStartup);
}

function resolveCircuitBreakerEnabled(config) {
  return coerceBoolean(
    config?.circuitBreakerEnabled,
    DEFAULT_CONFIG.circuitBreakerEnabled,
  );
}

function resolveMaxConsecutiveSyncErrors(config) {
  return clampPositiveInt(config?.maxConsecutiveSyncErrors, {
    default: DEFAULT_CONFIG.maxConsecutiveSyncErrors,
    min: 1,
    max: 100,
  });
}

function resolveCircuitBreakerFailureThreshold(config) {
  const raw = config?.circuitBreakerFailureThreshold;
  if (raw !== null && raw !== undefined && raw !== "") {
    return clampPositiveInt(raw, {
      default: DEFAULT_CONFIG.circuitBreakerFailureThreshold,
      min: 1,
      max: 100,
    });
  }
  return resolveMaxConsecutiveSyncErrors(config);
}

function resolveCircuitBreakerCooldownMinutes(config) {
  return clampPositiveInt(config?.circuitBreakerCooldownMinutes, {
    default: DEFAULT_CONFIG.circuitBreakerCooldownMinutes,
    min: 1,
    max: 1440,
  });
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

module.exports = {
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
};
