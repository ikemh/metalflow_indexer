"use strict";

const {
  resolveCircuitBreakerEnabled,
  resolveCircuitBreakerFailureThreshold,
  resolveCircuitBreakerCooldownMinutes,
} = require("./config");

const safetyState = {
  consecutiveSyncFailures: 0,
  circuitOpenUntil: null,
  lastCircuitReason: null,
};

function isCircuitOpen(config) {
  if (!resolveCircuitBreakerEnabled(config)) return false;
  if (!safetyState.circuitOpenUntil) return false;

  if (Date.now() >= safetyState.circuitOpenUntil.getTime()) {
    safetyState.circuitOpenUntil = null;
    safetyState.lastCircuitReason = null;
    return false;
  }

  return true;
}

function closeCircuit() {
  safetyState.consecutiveSyncFailures = 0;
  safetyState.circuitOpenUntil = null;
  safetyState.lastCircuitReason = null;
}

function openCircuit(config, reason, log) {
  const cooldownMinutes = resolveCircuitBreakerCooldownMinutes(config);
  safetyState.circuitOpenUntil = new Date(
    Date.now() + cooldownMinutes * 60 * 1000,
  );
  safetyState.lastCircuitReason = reason;

  const message = `[safety] Circuit breaker opened for ${cooldownMinutes}min: ${reason}`;
  if (typeof log === "function") log("error", message);
  else console.error(message);
}

function recordSyncSuccess(config) {
  closeCircuit();
}

function recordSyncFailure(config, reason, log) {
  safetyState.consecutiveSyncFailures += 1;

  if (!resolveCircuitBreakerEnabled(config)) return;

  if (isCircuitOpen(config)) {
    safetyState.lastCircuitReason = reason;
    return;
  }

  const threshold = resolveCircuitBreakerFailureThreshold(config);
  if (safetyState.consecutiveSyncFailures >= threshold) {
    openCircuit(config, reason, log);
  }
}

module.exports = {
  safetyState,
  isCircuitOpen,
  openCircuit,
  closeCircuit,
  recordSyncSuccess,
  recordSyncFailure,
};
