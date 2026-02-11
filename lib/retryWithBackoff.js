/**
 * Retry with Exponential Backoff for LLM Council
 *
 * Gestisce retry automatici con backoff esponenziale per chiamate API.
 * Include jitter per evitare thundering herd.
 *
 * @version 1.0.0
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000,     // 1 secondo
  maxDelay: 30000,        // 30 secondi max
  backoffMultiplier: 2,   // Raddoppia ogni retry
  jitterFactor: 0.2,      // ±20% jitter
  retryableErrors: [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
    'socket hang up',
    'timeout',
    'rate limit',
    '429',
    '500',
    '502',
    '503',
    '504'
  ],
  nonRetryableErrors: [
    '400',
    '401',
    '403',
    '404',
    'invalid_api_key',
    'model_not_found'
  ]
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt (0-indexed)
 * @param {object} config - Configuration
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, config) {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  let delay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);

  // Cap at maxDelay
  delay = Math.min(delay, config.maxDelay);

  // Add jitter (±jitterFactor)
  const jitterRange = delay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  delay = Math.round(delay + jitter);

  return Math.max(delay, 0);
}

/**
 * Check if error is retryable
 * @param {Error|string} error - Error to check
 * @param {object} config - Configuration
 * @returns {boolean} True if error is retryable
 */
function isRetryableError(error, config) {
  const errorStr = String(error.message || error.code || error).toLowerCase();

  // Check non-retryable first
  for (const pattern of config.nonRetryableErrors) {
    if (errorStr.includes(pattern.toLowerCase())) {
      return false;
    }
  }

  // Check retryable patterns
  for (const pattern of config.retryableErrors) {
    if (errorStr.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  // Default: retry on network errors
  return error.code?.startsWith('E') || false;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Execute a function with retry and exponential backoff
 *
 * @param {Function} fn - Async function to execute
 * @param {object} options - Options
 * @param {number} options.maxRetries - Maximum retry attempts
 * @param {number} options.initialDelay - Initial delay in ms
 * @param {number} options.maxDelay - Maximum delay in ms
 * @param {number} options.backoffMultiplier - Backoff multiplier
 * @param {number} options.jitterFactor - Jitter factor (0-1)
 * @param {string[]} options.retryableErrors - Patterns for retryable errors
 * @param {string[]} options.nonRetryableErrors - Patterns for non-retryable errors
 * @param {string} options.operationName - Name for logging
 * @param {Function} options.onRetry - Callback on retry (attempt, error, delay)
 *
 * @returns {Promise<any>} Result of the function
 * @throws {Error} Last error if all retries exhausted
 */
export async function retryWithBackoff(fn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const operationName = config.operationName || 'operation';

  let lastError = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      // Execute the function
      const result = await fn();
      return result;

    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt >= config.maxRetries) {
        console.error(`[Retry] ${operationName}: All ${config.maxRetries + 1} attempts failed`);
        throw error;
      }

      // Check if error is retryable
      if (!isRetryableError(error, config)) {
        console.error(`[Retry] ${operationName}: Non-retryable error: ${error.message}`);
        throw error;
      }

      // Calculate delay
      const delay = calculateDelay(attempt, config);

      console.warn(
        `[Retry] ${operationName}: Attempt ${attempt + 1}/${config.maxRetries + 1} failed: ${error.message}. ` +
        `Retrying in ${delay}ms...`
      );

      // Call onRetry callback if provided
      if (config.onRetry) {
        try {
          await config.onRetry(attempt, error, delay);
        } catch (callbackError) {
          console.error(`[Retry] onRetry callback error:`, callbackError);
        }
      }

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should never reach here, but just in case
  throw lastError || new Error(`${operationName} failed after ${config.maxRetries + 1} attempts`);
}

/**
 * Create a retryable version of an async function
 *
 * @param {Function} fn - Async function to wrap
 * @param {object} options - Default retry options
 * @returns {Function} Wrapped function with retry capability
 */
export function createRetryable(fn, options = {}) {
  return async function(...args) {
    return retryWithBackoff(() => fn(...args), options);
  };
}

/**
 * Retry with circuit breaker integration
 *
 * @param {Function} fn - Async function to execute
 * @param {string} provider - Provider name for circuit breaker
 * @param {object} circuitBreaker - Circuit breaker module
 * @param {object} options - Retry options
 * @returns {Promise<any>} Result
 */
export async function retryWithCircuitBreaker(fn, provider, circuitBreaker, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  // Check circuit breaker first
  if (!circuitBreaker.canCall(provider)) {
    const error = new Error(`Circuit breaker OPEN for ${provider}`);
    error.code = 'CIRCUIT_OPEN';
    throw error;
  }

  try {
    const startTime = Date.now();
    const result = await retryWithBackoff(fn, {
      ...config,
      operationName: `${provider}`,
      onRetry: async (attempt, error, delay) => {
        // Don't record failures for retryable errors until last attempt
        if (attempt >= config.maxRetries - 1) {
          // Will be handled after throw
        }
        // Call original onRetry if provided
        if (options.onRetry) {
          await options.onRetry(attempt, error, delay);
        }
      }
    });

    // Record success
    const latency = Date.now() - startTime;
    circuitBreaker.recordSuccess(provider, latency);

    return result;

  } catch (error) {
    // Record failure
    circuitBreaker.recordFailure(provider, error.message);
    throw error;
  }
}

/**
 * Batch retry multiple operations with concurrency limit
 *
 * @param {Array<{fn: Function, id: string}>} operations - Operations to execute
 * @param {object} options - Options including concurrency limit
 * @returns {Promise<Array<{id: string, result?: any, error?: Error}>>} Results
 */
export async function batchRetry(operations, options = {}) {
  const { concurrency = 3, ...retryOptions } = options;
  const results = [];
  const queue = [...operations];
  const executing = new Set();

  const executeOne = async (op) => {
    try {
      const result = await retryWithBackoff(op.fn, {
        ...retryOptions,
        operationName: op.id
      });
      return { id: op.id, result };
    } catch (error) {
      return { id: op.id, error };
    }
  };

  while (queue.length > 0 || executing.size > 0) {
    // Fill up to concurrency limit
    while (queue.length > 0 && executing.size < concurrency) {
      const op = queue.shift();
      const promise = executeOne(op).then(result => {
        executing.delete(promise);
        results.push(result);
      });
      executing.add(promise);
    }

    // Wait for at least one to complete
    if (executing.size > 0) {
      await Promise.race(executing);
    }
  }

  return results;
}

/**
 * Get default configuration
 */
export function getDefaultConfig() {
  return { ...DEFAULT_CONFIG };
}

export default {
  retryWithBackoff,
  createRetryable,
  retryWithCircuitBreaker,
  batchRetry,
  getDefaultConfig
};
