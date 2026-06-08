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
 *
 * Smart sync:
 *   - smartSyncEnabled: pula pastas unchanged via assinatura de metadados;
 *   - folderSignatureCacheEnabled: persiste assinatura em disco;
 *   - maxWatcherSyncsPerMinute: rate limiter para eventos do watcher.
 */
const DEFAULT_CONFIG = {
  erpApiUrl: "",
  apiKey: "",
  syncIntervalMinutes: 720,
  thumbConcurrency: 1,
  roots: [],
  excludedFolders: [],
  watchEnabled: false,
  watchDebounceSeconds: 90,
  runOnStartup: false,
  circuitBreakerEnabled: true,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMinutes: 30,
  maxConsecutiveSyncErrors: 3,
  lastSync: null,

  // Smart sync
  smartSyncEnabled: true,
  folderSignatureCacheEnabled: true,
  folderSignatureCachePath: "data/folder-signatures.json",
  maxWatcherSyncsPerMinute: 10,

  // Watcher tuning
  watchUsePolling: true,
  watchIntervalMs: 15000,
  watchBinaryIntervalMs: 30000,
  watchStabilityThresholdMs: 5000,
  watchPollIntervalMs: 1000,
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
 *   - default 90 se ausente/null/string vazia/NaN
 *   - mínimo 5
 *   - máximo 300
 */
function clampWatchDebounceSeconds(raw) {
  if (raw === null || raw === undefined || raw === "") return 90;
  let n = Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return 90;
  n = Math.floor(n);
  if (n < 5) n = 5;
  if (n > 300) n = 300;
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

// ---------------------------------------------------------------------------
// Smart sync resolvers
// ---------------------------------------------------------------------------

function resolveSmartSyncEnabled(config) {
  return coerceBoolean(config?.smartSyncEnabled, DEFAULT_CONFIG.smartSyncEnabled);
}

function resolveFolderSignatureCacheEnabled(config) {
  return coerceBoolean(
    config?.folderSignatureCacheEnabled,
    DEFAULT_CONFIG.folderSignatureCacheEnabled,
  );
}

function resolveMaxWatcherSyncsPerMinute(config) {
  return clampPositiveInt(config?.maxWatcherSyncsPerMinute, {
    default: DEFAULT_CONFIG.maxWatcherSyncsPerMinute,
    min: 1,
    max: 120,
  });
}

function resolveSyncIntervalMinutes(config) {
  return clampPositiveInt(config?.syncIntervalMinutes, {
    default: DEFAULT_CONFIG.syncIntervalMinutes,
    min: 30,
    max: 1440,
  });
}

function resolveThumbConcurrency(config) {
  return clampPositiveInt(config?.thumbConcurrency, {
    default: DEFAULT_CONFIG.thumbConcurrency,
    min: 1,
    max: 4,
  });
}

// ---------------------------------------------------------------------------
// Watcher tuning resolvers
// ---------------------------------------------------------------------------

function resolveWatchUsePolling(config) {
  if (config?.watchUsePolling === undefined || config?.watchUsePolling === null) {
    return DEFAULT_CONFIG.watchUsePolling;
  }
  return coerceBoolean(config.watchUsePolling, DEFAULT_CONFIG.watchUsePolling);
}

function resolveWatchIntervalMs(config) {
  return clampPositiveInt(config?.watchIntervalMs, {
    default: DEFAULT_CONFIG.watchIntervalMs,
    min: 5000,
    max: 60000,
  });
}

function resolveWatchBinaryIntervalMs(config) {
  return clampPositiveInt(config?.watchBinaryIntervalMs, {
    default: DEFAULT_CONFIG.watchBinaryIntervalMs,
    min: 10000,
    max: 120000,
  });
}

function resolveWatchStabilityThresholdMs(config) {
  return clampPositiveInt(config?.watchStabilityThresholdMs, {
    default: DEFAULT_CONFIG.watchStabilityThresholdMs,
    min: 1000,
    max: 30000,
  });
}

function resolveWatchPollIntervalMs(config) {
  return clampPositiveInt(config?.watchPollIntervalMs, {
    default: DEFAULT_CONFIG.watchPollIntervalMs,
    min: 500,
    max: 10000,
  });
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

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
  // Smart sync
  resolveSmartSyncEnabled,
  resolveFolderSignatureCacheEnabled,
  resolveMaxWatcherSyncsPerMinute,
  resolveSyncIntervalMinutes,
  resolveThumbConcurrency,
  // Watcher tuning
  resolveWatchUsePolling,
  resolveWatchIntervalMs,
  resolveWatchBinaryIntervalMs,
  resolveWatchStabilityThresholdMs,
  resolveWatchPollIntervalMs,
};
