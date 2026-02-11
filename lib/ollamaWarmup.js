/**
 * Ollama Model Warm-up and Health Monitoring
 *
 * Mantiene i modelli Ollama caldi in memoria per ridurre latency.
 * Monitoring attivo con health checks periodici.
 *
 * @version 1.0.0
 */

import nodeFetch from 'node-fetch';

// =============================================================================
// CONFIGURATION
// =============================================================================

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const WARMUP_INTERVAL = 1000 * 60 * 5;  // 5 minuti
const HEALTH_CHECK_INTERVAL = 1000 * 30;  // 30 secondi
const REQUEST_TIMEOUT = 15000;  // 15s timeout

// Modelli da mantenere caldi
const MODELS_TO_WARM = [
  'llama3.2:1b',      // Chat model (principale)
  'nomic-embed-text'  // Embedding model
];

// =============================================================================
// STATE
// =============================================================================

const modelStatus = new Map();
let warmupTimer = null;
let healthCheckTimer = null;
let isInitialized = false;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Make a request with timeout
 */
async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await nodeFetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Check if Ollama server is reachable
 */
async function checkOllamaServer() {
  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`, {}, 5000);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get list of installed models
 */
async function getInstalledModels() {
  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return [];

    const data = await response.json();
    return (data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Warm up a single model by generating a short response
 */
async function warmupModel(modelName) {
  const startTime = Date.now();

  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: 'Hi',
        stream: false,
        options: {
          num_predict: 1  // Solo 1 token per warmup veloce
        },
        keep_alive: -1  // Mantieni in memoria indefinitamente
      })
    }, REQUEST_TIMEOUT);

    const latency = Date.now() - startTime;

    if (response.ok) {
      modelStatus.set(modelName, {
        status: 'ready',
        lastWarmup: Date.now(),
        latency,
        error: null
      });
      console.log(`[Warmup] ${modelName}: ready (${latency}ms)`);
      return { success: true, latency };
    } else {
      const error = await response.text();
      modelStatus.set(modelName, {
        status: 'error',
        lastWarmup: Date.now(),
        latency,
        error
      });
      console.error(`[Warmup] ${modelName}: error - ${error}`);
      return { success: false, error };
    }

  } catch (err) {
    const latency = Date.now() - startTime;
    modelStatus.set(modelName, {
      status: 'error',
      lastWarmup: Date.now(),
      latency,
      error: err.message
    });
    console.error(`[Warmup] ${modelName}: failed - ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Warm up embedding model specifically
 */
async function warmupEmbeddingModel(modelName) {
  const startTime = Date.now();

  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: 'warmup test',
        keep_alive: -1
      })
    }, REQUEST_TIMEOUT);

    const latency = Date.now() - startTime;

    if (response.ok) {
      modelStatus.set(modelName, {
        status: 'ready',
        lastWarmup: Date.now(),
        latency,
        error: null,
        type: 'embedding'
      });
      console.log(`[Warmup] ${modelName} (embedding): ready (${latency}ms)`);
      return { success: true, latency };
    } else {
      const error = await response.text();
      modelStatus.set(modelName, {
        status: 'error',
        lastWarmup: Date.now(),
        latency,
        error,
        type: 'embedding'
      });
      return { success: false, error };
    }

  } catch (err) {
    modelStatus.set(modelName, {
      status: 'error',
      lastWarmup: Date.now(),
      latency: Date.now() - startTime,
      error: err.message,
      type: 'embedding'
    });
    return { success: false, error: err.message };
  }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize warmup system and warm all models
 */
export async function initializeWarmup() {
  if (isInitialized) {
    console.log('[Warmup] Already initialized');
    return getStatus();
  }

  console.log('[Warmup] Initializing Ollama warmup system...');

  // Check Ollama server
  const serverOk = await checkOllamaServer();
  if (!serverOk) {
    console.error('[Warmup] Ollama server not reachable at', OLLAMA_BASE_URL);
    return { success: false, error: 'Ollama server not reachable' };
  }

  // Get installed models
  const installedModels = await getInstalledModels();
  console.log('[Warmup] Installed models:', installedModels);

  // Warm up each model
  const results = [];
  for (const model of MODELS_TO_WARM) {
    // Check if model is installed
    const isInstalled = installedModels.some(m =>
      m === model || m.startsWith(model + ':')
    );

    if (!isInstalled) {
      console.warn(`[Warmup] Model ${model} not installed, skipping`);
      modelStatus.set(model, {
        status: 'not_installed',
        lastWarmup: null,
        latency: null,
        error: 'Model not installed'
      });
      results.push({ model, success: false, error: 'not installed' });
      continue;
    }

    // Warm up based on model type
    let result;
    if (model.includes('embed')) {
      result = await warmupEmbeddingModel(model);
    } else {
      result = await warmupModel(model);
    }
    results.push({ model, ...result });
  }

  // Start periodic warmup
  startPeriodicWarmup();

  // Start health checks
  startHealthChecks();

  isInitialized = true;
  console.log('[Warmup] Initialization complete');

  return {
    success: true,
    models: results,
    serverUrl: OLLAMA_BASE_URL
  };
}

/**
 * Start periodic warmup timer
 */
export function startPeriodicWarmup() {
  if (warmupTimer) {
    clearInterval(warmupTimer);
  }

  warmupTimer = setInterval(async () => {
    console.log('[Warmup] Periodic warmup cycle starting...');

    for (const model of MODELS_TO_WARM) {
      const status = modelStatus.get(model);
      if (status?.status === 'not_installed') continue;

      if (model.includes('embed')) {
        await warmupEmbeddingModel(model);
      } else {
        await warmupModel(model);
      }
    }
  }, WARMUP_INTERVAL);

  console.log(`[Warmup] Periodic warmup scheduled every ${WARMUP_INTERVAL / 1000}s`);
}

/**
 * Start health check timer
 */
export function startHealthChecks() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  healthCheckTimer = setInterval(async () => {
    const serverOk = await checkOllamaServer();

    if (!serverOk) {
      console.warn('[Warmup] Health check: Ollama server not responding');
      // Mark all models as unhealthy
      for (const model of MODELS_TO_WARM) {
        const current = modelStatus.get(model);
        if (current && current.status !== 'not_installed') {
          modelStatus.set(model, {
            ...current,
            status: 'server_down'
          });
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL);

  console.log(`[Warmup] Health checks scheduled every ${HEALTH_CHECK_INTERVAL / 1000}s`);
}

/**
 * Stop all timers
 */
export function stopWarmup() {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  isInitialized = false;
  console.log('[Warmup] Stopped');
}

/**
 * Force warmup of a specific model
 */
export async function forceWarmup(modelName) {
  if (modelName.includes('embed')) {
    return warmupEmbeddingModel(modelName);
  }
  return warmupModel(modelName);
}

/**
 * Get status of all models
 */
export function getStatus() {
  const status = {};

  for (const [model, data] of modelStatus.entries()) {
    status[model] = { ...data };
  }

  return {
    initialized: isInitialized,
    serverUrl: OLLAMA_BASE_URL,
    models: status,
    warmupInterval: WARMUP_INTERVAL / 1000,
    healthCheckInterval: HEALTH_CHECK_INTERVAL / 1000
  };
}

/**
 * Check if a specific model is ready
 */
export function isModelReady(modelName) {
  const status = modelStatus.get(modelName);
  return status?.status === 'ready';
}

/**
 * Get model latency
 */
export function getModelLatency(modelName) {
  const status = modelStatus.get(modelName);
  return status?.latency || null;
}

/**
 * Pull a model if not installed
 */
export async function pullModel(modelName) {
  console.log(`[Warmup] Pulling model ${modelName}...`);

  try {
    const response = await fetchWithTimeout(`${OLLAMA_BASE_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: modelName,
        stream: false
      })
    }, 300000);  // 5 min timeout for pull

    if (response.ok) {
      console.log(`[Warmup] Model ${modelName} pulled successfully`);
      return { success: true };
    } else {
      const error = await response.text();
      return { success: false, error };
    }

  } catch (err) {
    return { success: false, error: err.message };
  }
}

export default {
  initializeWarmup,
  startPeriodicWarmup,
  startHealthChecks,
  stopWarmup,
  forceWarmup,
  getStatus,
  isModelReady,
  getModelLatency,
  pullModel,
  MODELS_TO_WARM
};
