/**
 * Semantic Similarity using Ollama Embeddings
 *
 * Usa nomic-embed-text per calcolare similarity semantica
 * tra risposte dei provider LLM Council.
 *
 * @version 1.0.0
 */

import nodeFetch from 'node-fetch';

// =============================================================================
// CONFIGURATION
// =============================================================================

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';  // 137M params, ~50ms per embedding
const EMBEDDING_TIMEOUT = 30000;  // 10s timeout

// Cache embeddings per sessione per evitare ricalcoli
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 100;

// =============================================================================
// SPECIALTY WEIGHTS - Pesi per tipo di query
// =============================================================================

export const SPECIALTY_WEIGHTS = {
  'factual': {
    google: 1.3,      // Gemini eccelle su fatti
    cerebras: 1.0,
    groq: 1.0,
    sambanova: 1.1,   // DeepSeek buono su reasoning
    openrouter: 1.0,
    ollama: 0.7       // Modello piccolo, meno affidabile
  },
  'reasoning': {
    google: 1.0,
    cerebras: 1.2,    // Fast reasoning
    groq: 1.1,
    sambanova: 1.4,   // DeepSeek-V3 eccelle
    openrouter: 1.0,
    ollama: 0.6
  },
  'network': {        // Query specifiche NetMap
    google: 1.1,
    cerebras: 1.1,
    groq: 1.1,
    sambanova: 1.2,
    openrouter: 1.0,
    ollama: 0.8       // Conosce il contesto locale
  },
  'default': {
    google: 1.0,
    cerebras: 1.0,
    groq: 1.0,
    sambanova: 1.0,
    openrouter: 1.0,
    ollama: 0.8
  }
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate embedding for text using Ollama
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
export async function getEmbedding(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text for embedding');
  }

  // Check cache first
  const cacheKey = text.substring(0, 200);  // Use first 200 chars as key
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT);

  try {
    const response = await nodeFetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text.substring(0, 8000)  // Limit text length
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama embedding error: ${err}`);
    }

    const data = await response.json();
    const embedding = data.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('Invalid embedding response');
    }

    // Cache the embedding
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
      // Remove oldest entry
      const firstKey = embeddingCache.keys().next().value;
      embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embedding);

    return embedding;

  } catch (err) {
    clearTimeout(timeout);
    console.error('[Semantic] Embedding error:', err.message);
    throw err;
  }
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Cosine similarity (0-1)
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Calculate semantic similarity between two responses
 * @param {string} response1 - First response
 * @param {string} response2 - Second response
 * @returns {Promise<number>} Similarity score (0-1)
 */
export async function calculateSemanticSimilarity(response1, response2) {
  if (!response1 || !response2) return 0;

  try {
    const [emb1, emb2] = await Promise.all([
      getEmbedding(response1),
      getEmbedding(response2)
    ]);

    return cosineSimilarity(emb1, emb2);

  } catch (err) {
    console.error('[Semantic] Similarity calculation failed:', err.message);
    // Fallback to Jaccard similarity
    return calculateJaccardSimilarity(response1, response2);
  }
}

/**
 * Fallback Jaccard similarity (token-based)
 */
export function calculateJaccardSimilarity(response1, response2) {
  if (!response1 || !response2) return 0;

  const tokens1 = new Set(response1.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokens2 = new Set(response2.toLowerCase().split(/\s+/).filter(t => t.length > 2));

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Classify query type for weighted consensus
 * @param {string} query - User query
 * @returns {string} Query type
 */
export function classifyQuery(query) {
  const lowerQuery = query.toLowerCase();

  // Network-specific queries
  if (/mac|switch|vlan|device|topolog|interfac|port|router|gateway|subnet|ip\s*address/i.test(lowerQuery)) {
    return 'network';
  }

  // Reasoning queries
  if (/perché|come funziona|spiega|analizza|ragiona|confronta|differenza|why|how|explain/i.test(lowerQuery)) {
    return 'reasoning';
  }

  // Factual queries
  if (/cos'è|definisci|quando|dove|chi|quale|what is|define|when|where|who|which/i.test(lowerQuery)) {
    return 'factual';
  }

  return 'default';
}

/**
 * Calculate weighted consensus score for a response
 * @param {object} response - Provider response
 * @param {object[]} allResponses - All provider responses
 * @param {string} queryType - Type of query
 * @returns {Promise<number>} Weighted consensus score
 */
export async function calculateWeightedConsensusScore(response, allResponses, queryType) {
  const weights = SPECIALTY_WEIGHTS[queryType] || SPECIALTY_WEIGHTS.default;
  const validResponses = allResponses.filter(r => r.response && !r.error && r !== response);

  if (validResponses.length === 0) return 0.5;

  let weightedSimilarity = 0;
  let totalWeight = 0;

  for (const other of validResponses) {
    try {
      const similarity = await calculateSemanticSimilarity(response.response, other.response);
      const otherWeight = weights[other.provider] || 1.0;

      weightedSimilarity += similarity * otherWeight;
      totalWeight += otherWeight;
    } catch (err) {
      console.error(`[Semantic] Error comparing with ${other.provider}:`, err.message);
    }
  }

  if (totalWeight === 0) return 0.5;

  const providerWeight = weights[response.provider] || 1.0;
  const consensusScore = (weightedSimilarity / totalWeight) * providerWeight;

  return consensusScore;
}

/**
 * Find consensus using semantic similarity
 * @param {object[]} responses - Provider responses
 * @param {string} queryType - Type of query
 * @returns {Promise<object>} Consensus result
 */
export async function findSemanticConsensus(responses, queryType) {
  const validResponses = responses.filter(r => r.response && !r.error);

  if (validResponses.length === 0) {
    return { consensus: null, confidence: 0, details: 'Nessuna risposta valida' };
  }

  if (validResponses.length === 1) {
    return {
      consensus: validResponses[0],
      confidence: 0.5,
      details: 'Solo 1 provider ha risposto'
    };
  }

  // Calculate weighted consensus scores for each response
  const scoredResponses = await Promise.all(
    validResponses.map(async (r) => {
      const consensusScore = await calculateWeightedConsensusScore(r, validResponses, queryType);
      return { ...r, consensusScore };
    })
  );

  // Sort by consensus score
  scoredResponses.sort((a, b) => b.consensusScore - a.consensusScore);

  // Calculate average confidence
  const avgScore = scoredResponses.reduce((sum, s) => sum + s.consensusScore, 0) / scoredResponses.length;

  return {
    consensus: scoredResponses[0],
    confidence: avgScore,
    allResponses: scoredResponses,
    queryType,
    details: `${validResponses.length} provider, semantic similarity ${(avgScore * 100).toFixed(1)}%`
  };
}

/**
 * Clear embedding cache
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
  console.log('[Semantic] Embedding cache cleared');
}

/**
 * Get cache stats
 */
export function getEmbeddingCacheStats() {
  return {
    size: embeddingCache.size,
    maxSize: MAX_CACHE_SIZE
  };
}

/**
 * Check if embedding model is available
 */
export async function checkEmbeddingModel() {
  try {
    const response = await nodeFetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) return { available: false, error: 'Ollama not responding' };

    const data = await response.json();
    const models = data.models || [];

    const hasModel = models.some(m =>
      m.name === EMBEDDING_MODEL || m.name.startsWith(EMBEDDING_MODEL + ':')
    );

    return {
      available: hasModel,
      model: EMBEDDING_MODEL,
      installedModels: models.map(m => m.name)
    };

  } catch (err) {
    return { available: false, error: err.message };
  }
}

export default {
  getEmbedding,
  cosineSimilarity,
  calculateSemanticSimilarity,
  calculateJaccardSimilarity,
  classifyQuery,
  calculateWeightedConsensusScore,
  findSemanticConsensus,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
  checkEmbeddingModel,
  SPECIALTY_WEIGHTS
};
