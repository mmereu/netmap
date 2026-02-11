/**
 * LLM Council Response Cache
 *
 * LRU Cache per risposte Council con TTL configurabile.
 * Riduce latency e costi caching risposte frequenti.
 *
 * @version 1.0.0
 */

import { LRUCache } from 'lru-cache';
import crypto from 'crypto';

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================

const CACHE_CONFIG = {
  max: 500,                    // Max 500 entries
  ttl: 1000 * 60 * 15,         // 15 minuti TTL
  updateAgeOnGet: true,        // Refresh TTL on access
  allowStale: false            // Don't serve stale entries
};

// =============================================================================
// CACHE INSTANCE
// =============================================================================

const responseCache = new LRUCache({
  max: CACHE_CONFIG.max,
  ttl: CACHE_CONFIG.ttl,
  updateAgeOnGet: CACHE_CONFIG.updateAgeOnGet,
  allowStale: CACHE_CONFIG.allowStale
});

// Statistics tracking
const stats = {
  hits: 0,
  misses: 0,
  sets: 0,
  clears: 0
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generate cache key from message and council type
 */
function getCacheKey(message, type) {
  // Normalize: lowercase, trim, collapse whitespace
  const normalized = message.toLowerCase().trim().replace(/\s+/g, ' ');
  return crypto.createHash('md5').update(`${type}:${normalized}`).digest('hex');
}

/**
 * Check if a response should be cached
 * Don't cache error responses or very short responses
 */
function isCacheable(response) {
  if (!response) return false;
  if (response.error) return false;
  if (response.responseType === 'divergent') return false;  // Low quality
  if (response.confidence < 0.4) return false;  // Too low confidence
  return true;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get cached response if available
 * @param {string} message - User message
 * @param {string} type - Council type
 * @returns {object|null} Cached response or null
 */
export function getCachedResponse(message, type) {
  const key = getCacheKey(message, type);
  const cached = responseCache.get(key);

  if (cached) {
    stats.hits++;
    console.log(`[Cache] HIT for key ${key.substring(0, 8)}... (hits: ${stats.hits})`);
    return {
      ...cached,
      fromCache: true,
      cacheAge: Date.now() - cached.cachedAt
    };
  }

  stats.misses++;
  return null;
}

/**
 * Store response in cache
 * @param {string} message - User message
 * @param {string} type - Council type
 * @param {object} response - Council response
 */
export function setCachedResponse(message, type, response) {
  if (!isCacheable(response)) {
    console.log(`[Cache] SKIP - response not cacheable`);
    return false;
  }

  const key = getCacheKey(message, type);

  responseCache.set(key, {
    ...response,
    originalMessage: message,
    cachedAt: Date.now()
  });

  stats.sets++;
  console.log(`[Cache] SET key ${key.substring(0, 8)}... (size: ${responseCache.size})`);
  return true;
}

/**
 * Find similar cached response using fuzzy matching
 * Used as fallback when exact match not found
 * @param {string} message - User message
 * @returns {object|null} Similar cached response or null
 */
export function findSimilarCachedResponse(message) {
  const normalizedQuery = message.toLowerCase().trim();
  const queryWords = new Set(normalizedQuery.split(/\s+/).filter(w => w.length > 3));

  if (queryWords.size < 2) return null;  // Too short for fuzzy matching

  let bestMatch = null;
  let bestScore = 0;

  // Iterate through cache entries
  for (const [key, entry] of responseCache.entries()) {
    if (!entry.originalMessage) continue;

    const entryWords = new Set(
      entry.originalMessage.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );

    // Jaccard similarity
    const intersection = new Set([...queryWords].filter(x => entryWords.has(x)));
    const union = new Set([...queryWords, ...entryWords]);
    const similarity = intersection.size / union.size;

    if (similarity > 0.7 && similarity > bestScore) {  // >70% similar
      bestScore = similarity;
      bestMatch = entry;
    }
  }

  if (bestMatch) {
    console.log(`[Cache] FUZZY HIT with score ${(bestScore * 100).toFixed(1)}%`);
    return { ...bestMatch, fromCache: true, fuzzyMatch: true, fuzzyScore: bestScore };
  }

  return null;
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  const hitRate = stats.hits + stats.misses > 0
    ? stats.hits / (stats.hits + stats.misses)
    : 0;

  return {
    size: responseCache.size,
    max: CACHE_CONFIG.max,
    hits: stats.hits,
    misses: stats.misses,
    sets: stats.sets,
    hitRate: hitRate,
    hitRatePercent: (hitRate * 100).toFixed(1) + '%',
    ttlMinutes: CACHE_CONFIG.ttl / 60000
  };
}

/**
 * Clear all cached responses
 */
export function clearCache() {
  const previousSize = responseCache.size;
  responseCache.clear();
  stats.clears++;
  console.log('[Cache] CLEARED');
  return { cleared: true, previousSize };
}

/**
 * Delete specific cache entry
 */
export function deleteCacheEntry(message, type) {
  const key = getCacheKey(message, type);
  const deleted = responseCache.delete(key);
  if (deleted) {
    console.log(`[Cache] DELETE key ${key.substring(0, 8)}...`);
  }
  return deleted;
}

/**
 * Prune expired entries manually
 */
export function pruneCache() {
  const before = responseCache.size;
  responseCache.purgeStale();
  const after = responseCache.size;
  console.log(`[Cache] PRUNED ${before - after} stale entries`);
  return { pruned: before - after, remaining: after };
}

export default {
  getCachedResponse,
  setCachedResponse,
  findSimilarCachedResponse,
  getCacheStats,
  clearCache,
  deleteCacheEntry,
  pruneCache
};
