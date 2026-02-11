/**
 * Early Exit Optimization for LLM Council
 *
 * Ottimizza la risposta del Council uscendo anticipatamente
 * quando si raggiunge un consenso sufficiente prima che tutti
 * i provider rispondano.
 *
 * @version 1.0.0
 */

import { calculateSemanticSimilarity } from './semanticSimilarity.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const EARLY_EXIT_CONFIG = {
  minResponses: 3,              // Minimo risposte prima di considerare early exit
  consensusThreshold: 0.85,     // Similarità minima per consenso forte
  confidenceThreshold: 0.75,    // Confidence minima per early exit
  timeoutBuffer: 2000,          // Buffer ms prima del timeout totale
  checkInterval: 500            // Intervallo check consenso
};

// =============================================================================
// EARLY EXIT CHECKER
// =============================================================================

/**
 * Create an early exit controller for a council query
 *
 * @param {object} options - Configuration options
 * @returns {object} Early exit controller
 */
export function createEarlyExitController(options = {}) {
  const config = { ...EARLY_EXIT_CONFIG, ...options };

  const state = {
    responses: [],
    startTime: Date.now(),
    exitTriggered: false,
    exitReason: null,
    consensusResponse: null,
    confidenceScore: 0
  };

  return {
    /**
     * Add a response and check for early exit condition
     * @param {object} response - Provider response
     * @returns {Promise<{shouldExit: boolean, response?: object, reason?: string}>}
     */
    async addResponse(response) {
      if (state.exitTriggered) {
        return { shouldExit: true, response: state.consensusResponse, reason: state.exitReason };
      }

      // Add to responses
      if (response && !response.error) {
        state.responses.push(response);
      }

      // Check if we have enough responses
      if (state.responses.length < config.minResponses) {
        return { shouldExit: false };
      }

      // Check for consensus
      const consensusResult = await checkConsensus(state.responses, config);

      if (consensusResult.hasConsensus) {
        state.exitTriggered = true;
        state.exitReason = consensusResult.reason;
        state.consensusResponse = consensusResult.bestResponse;
        state.confidenceScore = consensusResult.confidence;

        console.log(`[EarlyExit] Triggered: ${consensusResult.reason} (confidence: ${(consensusResult.confidence * 100).toFixed(1)}%)`);

        return {
          shouldExit: true,
          response: consensusResult.bestResponse,
          reason: consensusResult.reason,
          confidence: consensusResult.confidence,
          respondersCount: state.responses.length
        };
      }

      return { shouldExit: false };
    },

    /**
     * Get current state
     */
    getState() {
      return {
        responsesCount: state.responses.length,
        exitTriggered: state.exitTriggered,
        exitReason: state.exitReason,
        elapsedTime: Date.now() - state.startTime,
        confidenceScore: state.confidenceScore
      };
    },

    /**
     * Reset the controller
     */
    reset() {
      state.responses = [];
      state.startTime = Date.now();
      state.exitTriggered = false;
      state.exitReason = null;
      state.consensusResponse = null;
      state.confidenceScore = 0;
    },

    /**
     * Get configuration
     */
    getConfig() {
      return { ...config };
    }
  };
}

/**
 * Check if responses have reached consensus
 *
 * @param {object[]} responses - Array of provider responses
 * @param {object} config - Configuration
 * @returns {Promise<{hasConsensus: boolean, reason?: string, bestResponse?: object, confidence: number}>}
 */
async function checkConsensus(responses, config) {
  if (responses.length < 2) {
    return { hasConsensus: false, confidence: 0 };
  }

  // Calculate pairwise similarities
  const similarities = [];
  const responseSimilarities = new Map();

  for (let i = 0; i < responses.length; i++) {
    let totalSimilarity = 0;

    for (let j = 0; j < responses.length; j++) {
      if (i !== j) {
        let similarity;
        try {
          similarity = await calculateSemanticSimilarity(
            responses[i].response,
            responses[j].response
          );
        } catch {
          // Fallback to simple comparison
          similarity = simpleTextSimilarity(responses[i].response, responses[j].response);
        }
        similarities.push(similarity);
        totalSimilarity += similarity;
      }
    }

    // Average similarity of this response to others
    const avgSimilarity = totalSimilarity / (responses.length - 1);
    responseSimilarities.set(i, avgSimilarity);
  }

  // Calculate overall consensus score
  const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

  // Find best response (highest average similarity to others)
  let bestIdx = 0;
  let bestSimilarity = 0;
  for (const [idx, sim] of responseSimilarities.entries()) {
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestIdx = idx;
    }
  }

  // Check if consensus threshold met
  if (avgSimilarity >= config.consensusThreshold) {
    return {
      hasConsensus: true,
      reason: `Strong consensus (${(avgSimilarity * 100).toFixed(1)}% agreement)`,
      bestResponse: responses[bestIdx],
      confidence: avgSimilarity
    };
  }

  // Check for majority agreement (3+ responses with high similarity)
  const highSimilarityCount = [...responseSimilarities.values()].filter(
    sim => sim >= config.confidenceThreshold
  ).length;

  if (highSimilarityCount >= 3 && avgSimilarity >= config.confidenceThreshold) {
    return {
      hasConsensus: true,
      reason: `Majority consensus (${highSimilarityCount}/${responses.length} agree)`,
      bestResponse: responses[bestIdx],
      confidence: avgSimilarity
    };
  }

  return {
    hasConsensus: false,
    confidence: avgSimilarity
  };
}

/**
 * Simple text similarity fallback (Jaccard)
 */
function simpleTextSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;

  const tokens1 = new Set(text1.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokens2 = new Set(text2.toLowerCase().split(/\s+/).filter(t => t.length > 2));

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// =============================================================================
// STREAMING EARLY EXIT
// =============================================================================

/**
 * Create a streaming early exit handler for concurrent provider calls
 *
 * @param {object} options - Configuration
 * @returns {object} Streaming handler
 */
export function createStreamingEarlyExit(options = {}) {
  const config = { ...EARLY_EXIT_CONFIG, ...options };
  const controller = createEarlyExitController(config);

  let resolvePromise = null;
  let rejectPromise = null;
  let pendingProviders = 0;
  let isResolved = false;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    /**
     * Register a provider call
     */
    registerProvider() {
      pendingProviders++;
    },

    /**
     * Report a provider response
     * @param {object} response - Provider response
     */
    async reportResponse(response) {
      if (isResolved) return;

      pendingProviders--;

      const result = await controller.addResponse(response);

      if (result.shouldExit) {
        isResolved = true;
        resolvePromise({
          earlyExit: true,
          response: result.response,
          reason: result.reason,
          confidence: result.confidence,
          respondersCount: result.respondersCount
        });
        return;
      }

      // If all providers responded without early exit
      if (pendingProviders === 0) {
        isResolved = true;
        resolvePromise({
          earlyExit: false,
          responses: controller.getState().responsesCount
        });
      }
    },

    /**
     * Report a provider error
     */
    reportError(error) {
      pendingProviders--;

      // If all failed
      if (pendingProviders === 0 && !isResolved) {
        isResolved = true;
        rejectPromise(error);
      }
    },

    /**
     * Get the promise that resolves on early exit or all responses
     */
    getPromise() {
      return promise;
    },

    /**
     * Check if early exit was triggered
     */
    wasEarlyExit() {
      return controller.getState().exitTriggered;
    },

    /**
     * Get state
     */
    getState() {
      return {
        ...controller.getState(),
        pendingProviders,
        isResolved
      };
    }
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  createEarlyExitController,
  createStreamingEarlyExit,
  EARLY_EXIT_CONFIG
};
