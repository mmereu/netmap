/**
 * LLM Council v3.0 - Multi-Model Consensus System
 *
 * Sistema di consenso multi-modello con:
 * - 6 provider LLM (1 locale + 5 cloud)
 * - Semantic similarity con embeddings
 * - Circuit breaker per resilienza
 * - Response caching per performance
 * - Early exit optimization
 * - Tool calling support
 * - SSH diagnostic integration
 *
 * @version 3.0.0
 */

import nodeFetch from 'node-fetch';

// Import dei moduli Council
import { getCachedResponse, setCachedResponse, findSimilarCachedResponse, getCacheStats } from '../lib/councilCache.js';
import { canCall, recordSuccess, recordFailure, getAllCircuitStates, CIRCUIT_STATES } from '../lib/circuitBreaker.js';
import { initializeWarmup, getStatus as getWarmupStatus, isModelReady } from '../lib/ollamaWarmup.js';
import { retryWithBackoff, retryWithCircuitBreaker } from '../lib/retryWithBackoff.js';
import { calculateSemanticSimilarity, classifyQuery, findSemanticConsensus, SPECIALTY_WEIGHTS, checkEmbeddingModel } from '../lib/semanticSimilarity.js';
import { createEarlyExitController } from '../lib/earlyExit.js';
import { createSystemPrompt, extractEntities, detectQueryIntent, createConversationContext } from '../lib/councilContext.js';
import { getToolDefinitions, createToolContext, isToolAllowed } from '../lib/councilTools.js';
import { executeTool, formatToolResult } from '../lib/toolExecutor.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // API Keys from environment
  GOOGLE_AI_KEY: process.env.GOOGLE_AI_KEY,
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',

  // Timeouts
  CLOUD_TIMEOUT: 30000,     // 30s for cloud providers
  OLLAMA_TIMEOUT: 90000,    // 90s for local Ollama
  TOTAL_TIMEOUT: 45000,     // 45s max total

  // Council settings
  MIN_RESPONSES: 2,         // Minimum responses for consensus
  CONSENSUS_THRESHOLD: 0.7, // Minimum confidence for consensus
  CACHE_ENABLED: true,
  EARLY_EXIT_ENABLED: false,

  // Models per provider
  MODELS: {
    ollama: 'llama3.2:1b',
    cerebras: 'llama-3.3-70b',
    groq: 'llama-3.3-70b-versatile',
    google: 'gemini-2.0-flash-exp',
    sambanova: 'DeepSeek-V3',
    openrouter: 'deepseek/deepseek-chat'
  }
};

// =============================================================================
// COUNCIL TYPES
// =============================================================================

export const COUNCIL_TYPES = {
  FAST: {
    name: 'fast',
    description: 'Risposta veloce (3 provider più veloci)',
    providers: ['cerebras', 'groq', 'google'],
    timeout: 30000
  },
  BALANCED: {
    name: 'balanced',
    description: 'Bilanciato (4 provider)',
    providers: ['cerebras', 'groq', 'google', 'sambanova'],
    timeout: 30000
  },
  QUALITY: {
    name: 'quality',
    description: 'Alta qualità (tutti i provider)',
    providers: ['cerebras', 'groq', 'google', 'sambanova', 'openrouter', 'ollama'],
    timeout: 60000
  },
  LOCAL_FIRST: {
    name: 'local_first',
    description: 'Priorità al modello locale',
    providers: ['ollama', 'cerebras', 'groq'],
    timeout: 60000
  }
};

// =============================================================================
// PROVIDER IMPLEMENTATIONS
// =============================================================================

const providers = {
  /**
   * Ollama (local)
   */
  async ollama(message, systemPrompt, options = {}) {
    const response = await nodeFetch(`${CONFIG.OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.MODELS.ollama,
        prompt: message,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 2048
        },
        keep_alive: -1
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_TIMEOUT)
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const data = await response.json();
    return data.response;
  },

  /**
   * Cerebras
   */
  async cerebras(message, systemPrompt, options = {}) {
    if (!CONFIG.CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY not configured');

    const response = await nodeFetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.CEREBRAS_API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.MODELS.cerebras,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 2048,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(CONFIG.CLOUD_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cerebras error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  },

  /**
   * Groq
   */
  async groq(message, systemPrompt, options = {}) {
    if (!CONFIG.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

    const response = await nodeFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.MODELS.groq,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 2048,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(CONFIG.CLOUD_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  },

  /**
   * Google AI (Gemini)
   */
  async google(message, systemPrompt, options = {}) {
    if (!CONFIG.GOOGLE_AI_KEY) throw new Error('GOOGLE_AI_KEY not configured');

    const response = await nodeFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODELS.google}:generateContent?key=${CONFIG.GOOGLE_AI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        }),
        signal: AbortSignal.timeout(CONFIG.CLOUD_TIMEOUT)
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google AI error: ${error}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  },

  /**
   * SambaNova
   */
  async sambanova(message, systemPrompt, options = {}) {
    if (!CONFIG.SAMBANOVA_API_KEY) throw new Error('SAMBANOVA_API_KEY not configured');

    const response = await nodeFetch('https://api.sambanova.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.SAMBANOVA_API_KEY}`
      },
      body: JSON.stringify({
        model: CONFIG.MODELS.sambanova,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 2048,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(CONFIG.CLOUD_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SambaNova error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  },

  /**
   * OpenRouter
   */
  async openrouter(message, systemPrompt, options = {}) {
    if (!CONFIG.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');

    const response = await nodeFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://netmap.local',
        'X-Title': 'NetMap LLM Council'
      },
      body: JSON.stringify({
        model: CONFIG.MODELS.openrouter,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: 2048,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(CONFIG.CLOUD_TIMEOUT)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
};

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Query a single provider with circuit breaker and retry
 */
async function queryProvider(providerName, message, systemPrompt, options = {}) {
  const startTime = Date.now();

  // Check circuit breaker
  if (!canCall(providerName)) {
    return {
      provider: providerName,
      response: null,
      error: 'Circuit breaker OPEN',
      latency: 0,
      model: CONFIG.MODELS[providerName]
    };
  }

  try {
    const providerFn = providers[providerName];
    if (!providerFn) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    // Execute with retry
    const response = await retryWithBackoff(
      () => providerFn(message, systemPrompt, options),
      {
        maxRetries: 2,
        initialDelay: 1000,
        operationName: providerName
      }
    );

    const latency = Date.now() - startTime;
    recordSuccess(providerName, latency);

    return {
      provider: providerName,
      response,
      error: null,
      latency,
      model: CONFIG.MODELS[providerName]
    };

  } catch (error) {
    const latency = Date.now() - startTime;
    recordFailure(providerName, error.message);

    return {
      provider: providerName,
      response: null,
      error: error.message,
      latency,
      model: CONFIG.MODELS[providerName]
    };
  }
}

/**
 * Query the council
 */
export async function queryCouncil(message, options = {}) {
  const startTime = Date.now();
  const councilType = COUNCIL_TYPES[options.type?.toUpperCase()] || COUNCIL_TYPES.BALANCED;

  console.log(`[Council] Query type: ${councilType.name}, providers: ${councilType.providers.join(', ')}`);

  // Detect query type for weighted consensus
  const queryType = classifyQuery(message);
  console.log(`[Council] Query classification: ${queryType}`);

  // Check cache
  if (CONFIG.CACHE_ENABLED) {
    const cached = getCachedResponse(message, councilType.name);
    if (cached) {
      console.log(`[Council] Cache HIT`);
      return {
        ...cached,
        fromCache: true,
        totalLatency: Date.now() - startTime
      };
    }

    // Try fuzzy match
    const fuzzyMatch = findSimilarCachedResponse(message);
    if (fuzzyMatch) {
      console.log(`[Council] Fuzzy cache HIT (${(fuzzyMatch.fuzzyScore * 100).toFixed(1)}%)`);
      return {
        ...fuzzyMatch,
        fromCache: true,
        totalLatency: Date.now() - startTime
      };
    }
  }

  // Build system prompt with context
  const intent = detectQueryIntent(message);
  const entities = extractEntities(message);
  const systemPrompt = createSystemPrompt(intent, {
    ...entities,
    ...options.context
  }, {
    toolsEnabled: options.toolsEnabled,
    sshEnabled: options.sshEnabled
  });

  // Create early exit controller
  const earlyExit = CONFIG.EARLY_EXIT_ENABLED
    ? createEarlyExitController({ minResponses: CONFIG.MIN_RESPONSES })
    : null;

  // Query all providers in parallel
  const providerPromises = councilType.providers.map(async (providerName) => {
    const result = await queryProvider(providerName, message, systemPrompt, options);

    // Check early exit
    if (earlyExit && result.response) {
      const exitCheck = await earlyExit.addResponse(result);
      if (exitCheck.shouldExit) {
        console.log(`[Council] Early exit triggered: ${exitCheck.reason}`);
      }
    }

    return result;
  });

  // Wait for all or timeout
  const timeout = councilType.timeout || CONFIG.TOTAL_TIMEOUT;
  const responses = await Promise.race([
    Promise.all(providerPromises),
    new Promise(resolve =>
      setTimeout(() => resolve([]), timeout)
    )
  ]);

  // Filter valid responses
  const validResponses = responses.filter(r => r.response && !r.error);
  const errorResponses = responses.filter(r => r.error);

  console.log(`[Council] Valid responses: ${validResponses.length}/${responses.length}`);

  if (validResponses.length === 0) {
    return {
      response: 'Mi dispiace, nessun provider è riuscito a rispondere. Riprova tra poco.',
      confidence: 0,
      responseType: 'error',
      providers: errorResponses.map(r => ({ provider: r.provider, error: r.error })),
      totalLatency: Date.now() - startTime
    };
  }

  // Find consensus using semantic similarity
  let consensus;
  try {
    consensus = await findSemanticConsensus(validResponses, queryType);
  } catch (error) {
    console.error('[Council] Semantic consensus failed, using simple majority:', error.message);
    // Fallback to first response
    consensus = {
      consensus: validResponses[0],
      confidence: 0.5,
      details: 'Fallback to first response'
    };
  }

  // Determine response type
  let responseType = 'consensus';
  if (consensus.confidence < 0.5) {
    responseType = 'divergent';
  } else if (consensus.confidence < 0.7) {
    responseType = 'partial_consensus';
  } else if (consensus.confidence >= 0.85) {
    responseType = 'strong_consensus';
  }

  const result = {
    response: consensus.consensus?.response || validResponses[0].response,
    confidence: consensus.confidence,
    responseType,
    queryType,
    selectedProvider: consensus.consensus?.provider,
    providers: validResponses.map(r => ({
      provider: r.provider,
      model: r.model,
      latency: r.latency,
      consensusScore: r.consensusScore
    })),
    errors: errorResponses.map(r => ({
      provider: r.provider,
      error: r.error
    })),
    details: consensus.details,
    totalLatency: Date.now() - startTime
  };

  // Cache successful responses
  if (CONFIG.CACHE_ENABLED && responseType !== 'divergent') {
    setCachedResponse(message, councilType.name, result);
  }

  return result;
}

// =============================================================================
// TOOL CALLING SUPPORT
// =============================================================================

/**
 * Query council with tool calling capability
 */
export async function queryCouncilWithTools(message, options = {}) {
  const toolContext = createToolContext({
    sshEnabled: options.sshEnabled,
    permissions: options.permissions || ['network', 'database']
  });

  // First query to determine if tools are needed
  const initialResponse = await queryCouncil(message, {
    ...options,
    toolsEnabled: true
  });

  // Check if response indicates tool use needed
  const toolCallMatch = initialResponse.response.match(/\[TOOL:\s*(\w+)\s*\((.*?)\)\]/);

  if (!toolCallMatch) {
    return initialResponse;
  }

  // Execute tool
  const toolName = toolCallMatch[1];
  let toolParams;
  try {
    toolParams = JSON.parse(toolCallMatch[2] || '{}');
  } catch {
    toolParams = {};
  }

  console.log(`[Council] Tool call detected: ${toolName}`);

  const toolResult = await executeTool(toolName, toolParams, toolContext);
  const formattedResult = formatToolResult(toolName, toolResult);

  // Follow-up query with tool result
  const followUpMessage = `${message}\n\nRisultato del tool ${toolName}:\n${formattedResult}`;

  const finalResponse = await queryCouncil(followUpMessage, {
    ...options,
    context: {
      ...options.context,
      toolResult: formattedResult
    }
  });

  return {
    ...finalResponse,
    toolsUsed: [{
      tool: toolName,
      params: toolParams,
      result: toolResult
    }]
  };
}

// =============================================================================
// HEALTH & STATUS
// =============================================================================

/**
 * Get council status
 */
export function getCouncilStatus() {
  return {
    version: '3.0.0',
    config: {
      cacheEnabled: CONFIG.CACHE_ENABLED,
      earlyExitEnabled: CONFIG.EARLY_EXIT_ENABLED,
      minResponses: CONFIG.MIN_RESPONSES
    },
    providers: Object.keys(providers).map(name => ({
      name,
      model: CONFIG.MODELS[name],
      configured: name === 'ollama' || !!CONFIG[`${name.toUpperCase()}_API_KEY`]
    })),
    circuitBreakers: getAllCircuitStates(),
    cache: getCacheStats(),
    warmup: getWarmupStatus(),
    councilTypes: Object.keys(COUNCIL_TYPES)
  };
}

/**
 * Initialize the council
 */
export async function initializeCouncil() {
  console.log('[Council] Initializing v3.0...');

  // Initialize Ollama warmup
  try {
    await initializeWarmup();
  } catch (error) {
    console.error('[Council] Warmup initialization failed:', error.message);
  }

  // Check embedding model
  try {
    const embedStatus = await checkEmbeddingModel();
    if (!embedStatus.available) {
      console.warn('[Council] Embedding model not available:', embedStatus.error);
    }
  } catch (error) {
    console.error('[Council] Embedding check failed:', error.message);
  }

  console.log('[Council] Initialization complete');
  return getCouncilStatus();
}

/**
 * Health check
 */
export async function healthCheck() {
  const results = {};

  // Check each provider
  for (const [name, fn] of Object.entries(providers)) {
    if (name === 'ollama') {
      results[name] = isModelReady(CONFIG.MODELS.ollama);
    } else {
      const keyName = `${name.toUpperCase()}_API_KEY`;
      results[name] = !!CONFIG[keyName];
    }
  }

  return {
    healthy: Object.values(results).some(v => v),
    providers: results,
    circuitBreakers: getAllCircuitStates()
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  queryCouncil,
  queryCouncilWithTools,
  getCouncilStatus,
  initializeCouncil,
  healthCheck,
  COUNCIL_TYPES,
  SPECIALTY_WEIGHTS
};
