/**
 * Circuit Breaker Pattern for LLM Council Providers
 *
 * Previene cascade failures isolando provider problematici.
 * Stati: CLOSED (normale), OPEN (bloccato), HALF_OPEN (test)
 *
 * @version 1.0.0
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const CIRCUIT_CONFIG = {
  failureThreshold: 3,        // Apri dopo 3 fallimenti consecutivi
  resetTimeout: 60000,        // Riprova dopo 60s (1 minuto)
  halfOpenMaxCalls: 2,        // Max chiamate in half-open prima di decidere
  successThreshold: 2,        // Successi necessari in half-open per chiudere
  monitorWindow: 300000       // 5 minuti window per tracciare failures
};

// =============================================================================
// CIRCUIT STATE
// =============================================================================

const circuitState = {};

// Circuit states enum
export const CIRCUIT_STATES = {
  CLOSED: 'CLOSED',       // Normale operazione
  OPEN: 'OPEN',           // Provider bloccato
  HALF_OPEN: 'HALF_OPEN'  // Testing recovery
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get or initialize circuit state for a provider
 */
export function getCircuitState(provider) {
  if (!circuitState[provider]) {
    circuitState[provider] = {
      state: CIRCUIT_STATES.CLOSED,
      failures: 0,
      successes: 0,
      lastFailure: null,
      lastSuccess: null,
      lastStateChange: Date.now(),
      halfOpenCalls: 0,
      halfOpenSuccesses: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      recentFailures: []  // timestamps of recent failures
    };
  }
  return circuitState[provider];
}

/**
 * Clean old failures outside monitoring window
 */
function cleanOldFailures(circuit) {
  const cutoff = Date.now() - CIRCUIT_CONFIG.monitorWindow;
  circuit.recentFailures = circuit.recentFailures.filter(ts => ts > cutoff);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check if a provider can be called
 * @param {string} provider - Provider key
 * @returns {boolean} True if call is allowed
 */
export function canCall(provider) {
  const circuit = getCircuitState(provider);

  switch (circuit.state) {
    case CIRCUIT_STATES.CLOSED:
      return true;

    case CIRCUIT_STATES.OPEN:
      // Check if it's time to try half-open
      const timeSinceLastFailure = Date.now() - circuit.lastFailure;

      if (timeSinceLastFailure >= CIRCUIT_CONFIG.resetTimeout) {
        // Transition to HALF_OPEN
        circuit.state = CIRCUIT_STATES.HALF_OPEN;
        circuit.halfOpenCalls = 0;
        circuit.halfOpenSuccesses = 0;
        circuit.lastStateChange = Date.now();
        console.log(`[Circuit] ${provider}: OPEN -> HALF_OPEN (after ${Math.round(timeSinceLastFailure/1000)}s)`);
        return true;
      }

      // Still in cooldown
      const remaining = Math.round((CIRCUIT_CONFIG.resetTimeout - timeSinceLastFailure) / 1000);
      console.log(`[Circuit] ${provider}: OPEN - blocked for ${remaining}s more`);
      return false;

    case CIRCUIT_STATES.HALF_OPEN:
      // Allow limited calls in half-open
      if (circuit.halfOpenCalls < CIRCUIT_CONFIG.halfOpenMaxCalls) {
        return true;
      }
      console.log(`[Circuit] ${provider}: HALF_OPEN - max calls reached, waiting for results`);
      return false;

    default:
      return true;
  }
}

/**
 * Record a successful call
 * @param {string} provider - Provider key
 * @param {number} latency - Call latency in ms
 */
export function recordSuccess(provider, latency = 0) {
  const circuit = getCircuitState(provider);

  circuit.lastSuccess = Date.now();
  circuit.totalSuccesses++;
  circuit.successes++;

  if (circuit.state === CIRCUIT_STATES.HALF_OPEN) {
    circuit.halfOpenSuccesses++;

    // Check if we should close the circuit
    if (circuit.halfOpenSuccesses >= CIRCUIT_CONFIG.successThreshold) {
      console.log(`[Circuit] ${provider}: HALF_OPEN -> CLOSED (recovered after ${circuit.halfOpenSuccesses} successes)`);
      circuit.state = CIRCUIT_STATES.CLOSED;
      circuit.failures = 0;
      circuit.halfOpenCalls = 0;
      circuit.halfOpenSuccesses = 0;
      circuit.lastStateChange = Date.now();
    }
  } else if (circuit.state === CIRCUIT_STATES.CLOSED) {
    // Reset failure count on success in CLOSED state
    circuit.failures = 0;
  }
}

/**
 * Record a failed call
 * @param {string} provider - Provider key
 * @param {string} error - Error message
 */
export function recordFailure(provider, error = '') {
  const circuit = getCircuitState(provider);

  circuit.failures++;
  circuit.totalFailures++;
  circuit.lastFailure = Date.now();
  circuit.recentFailures.push(Date.now());

  // Clean old failures
  cleanOldFailures(circuit);

  if (circuit.state === CIRCUIT_STATES.HALF_OPEN) {
    // Any failure in half-open immediately opens the circuit
    console.log(`[Circuit] ${provider}: HALF_OPEN -> OPEN (failure in recovery: ${error})`);
    circuit.state = CIRCUIT_STATES.OPEN;
    circuit.lastStateChange = Date.now();
    circuit.halfOpenCalls = 0;
    circuit.halfOpenSuccesses = 0;

  } else if (circuit.state === CIRCUIT_STATES.CLOSED) {
    // Check if we should open the circuit
    if (circuit.failures >= CIRCUIT_CONFIG.failureThreshold) {
      console.log(`[Circuit] ${provider}: CLOSED -> OPEN (${circuit.failures} consecutive failures)`);
      circuit.state = CIRCUIT_STATES.OPEN;
      circuit.lastStateChange = Date.now();
    } else {
      console.log(`[Circuit] ${provider}: failure ${circuit.failures}/${CIRCUIT_CONFIG.failureThreshold} (error: ${error})`);
    }
  }
}

/**
 * Get all circuit states
 * @returns {object} Map of provider -> circuit state
 */
export function getAllCircuitStates() {
  const states = {};

  for (const [provider, circuit] of Object.entries(circuitState)) {
    cleanOldFailures(circuit);

    states[provider] = {
      state: circuit.state,
      failures: circuit.failures,
      recentFailures: circuit.recentFailures.length,
      lastFailure: circuit.lastFailure,
      lastSuccess: circuit.lastSuccess,
      lastStateChange: circuit.lastStateChange,
      totalFailures: circuit.totalFailures,
      totalSuccesses: circuit.totalSuccesses,
      healthScore: calculateHealthScore(circuit)
    };
  }

  return states;
}

/**
 * Calculate health score for a provider (0-100)
 */
function calculateHealthScore(circuit) {
  const total = circuit.totalSuccesses + circuit.totalFailures;
  if (total === 0) return 100;  // No data = assume healthy

  const successRate = circuit.totalSuccesses / total;
  const recentFailuresPenalty = circuit.recentFailures.length * 5;
  const statePenalty = circuit.state === CIRCUIT_STATES.OPEN ? 50 :
                       circuit.state === CIRCUIT_STATES.HALF_OPEN ? 25 : 0;

  const score = Math.max(0, Math.min(100,
    successRate * 100 - recentFailuresPenalty - statePenalty
  ));

  return Math.round(score);
}

/**
 * Force reset a circuit to CLOSED state
 * @param {string} provider - Provider key
 */
export function resetCircuit(provider) {
  const circuit = getCircuitState(provider);

  console.log(`[Circuit] ${provider}: FORCE RESET to CLOSED`);
  circuit.state = CIRCUIT_STATES.CLOSED;
  circuit.failures = 0;
  circuit.halfOpenCalls = 0;
  circuit.halfOpenSuccesses = 0;
  circuit.lastStateChange = Date.now();
  circuit.recentFailures = [];

  return circuit;
}

/**
 * Reset all circuits
 */
export function resetAllCircuits() {
  for (const provider of Object.keys(circuitState)) {
    resetCircuit(provider);
  }
  console.log('[Circuit] All circuits reset');
  return { reset: true };
}

/**
 * Get configuration
 */
export function getConfig() {
  return { ...CIRCUIT_CONFIG };
}

/**
 * Update configuration
 */
export function updateConfig(newConfig) {
  Object.assign(CIRCUIT_CONFIG, newConfig);
  console.log('[Circuit] Config updated:', CIRCUIT_CONFIG);
  return CIRCUIT_CONFIG;
}

export default {
  canCall,
  recordSuccess,
  recordFailure,
  getCircuitState,
  getAllCircuitStates,
  resetCircuit,
  resetAllCircuits,
  getConfig,
  updateConfig,
  CIRCUIT_STATES
};
