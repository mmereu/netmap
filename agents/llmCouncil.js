/**
 * LLM Council - Multi-Model Consensus System (v2.0)
 *
 * Implementazione ispirata a karpathy/llm-council:
 * - Stage 1: Query parallela a multipli provider
 * - Stage 2: Voting/Consensus semplificato (no peer review per performance)
 * - Stage 3: Best response selection o merge
 *
 * Provider (tutti gratuiti):
 * - Ollama: Llama 3.2 3B (LOCAL - zero latency, zero cost) - LOCAL-FAST
 * - Cerebras: Llama 3.3 70B (24M token/day, 450-1800 tok/s) - FAST
 * - Groq: Llama 3.3 70B (6K req/day, 300 tok/s) - BALANCED
 * - Google AI: Gemini 2.0 Flash (1M token/min) - KNOWLEDGE
 * - SambaNova: DeepSeek-V3 (free tier) - REASONING
 * - OpenRouter: Multi-model routing (free credits) - VERSATILE
 *
 * @author NetMap Team
 * @version 2.1.0
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import nodeFetch from 'node-fetch';

// Forza IPv4 per connessioni cloud
dns.setDefaultResultOrder('ipv4first');

// HTTP Agent per connessioni locali (Ollama)
const localHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  timeout: 60000
});

// =============================================================================
// COUNCIL CONFIGURATION - 6 PROVIDER (1 LOCAL + 5 CLOUD)
// =============================================================================

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

const COUNCIL_MEMBERS = {
  ollama: {
    name: 'Ollama Local',
    model: 'llama3.2:1b',
    baseUrl: `${OLLAMA_BASE_URL}/api/chat`,
    apiKey: 'local',  // No API key needed for local
    timeout: 90000,   // 90s for first model load (cold start) (warm loads are <1s)
    specialty: 'local-fast',
    tier: 0,  // Tier 0 = Local, always available, zero latency
    isLocal: true
  },
  cerebras: {
    name: 'Cerebras',
    model: 'llama-3.3-70b',
    baseUrl: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: process.env.CEREBRAS_API_KEY || '',
    timeout: 15000,
    specialty: 'fast-reasoning',
    tier: 1  // Primary tier - always queried first
  },
  groq: {
    name: 'Groq',
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: process.env.GROQ_API_KEY || '',
    timeout: 15000,
    specialty: 'balanced',
    tier: 1
  },
  google: {
    name: 'Google AI',
    model: 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: process.env.GOOGLE_AI_KEY || 'AIzaSyAQJEGO1U5g5vKrGdudY22b3mWN8qXaPXA',
    timeout: 15000,
    specialty: 'knowledge',
    tier: 1
  },
  sambanova: {
    name: 'SambaNova',
    model: 'DeepSeek-V3-0324',
    baseUrl: 'https://api.sambanova.ai/v1/chat/completions',
    apiKey: process.env.SAMBANOVA_API_KEY || '',
    timeout: 20000,
    specialty: 'deep-reasoning',
    tier: 2  // Secondary tier - used for extended consensus
  },
  openrouter: {
    name: 'OpenRouter',
    model: 'google/gemini-2.0-flash-001',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    timeout: 20000,
    specialty: 'versatile',
    tier: 2,
    extraHeaders: {
      'HTTP-Referer': 'https://netmap.local',
      'X-Title': 'NetMap AI Council'
    }
  }
};

// Connection pools per ogni provider
const connectionPools = {};
for (const [key, config] of Object.entries(COUNCIL_MEMBERS)) {
  connectionPools[key] = new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 5,
    maxFreeSockets: 2,
    timeout: config.timeout
  });
}

// Provider health tracking
const providerHealth = {};
for (const key of Object.keys(COUNCIL_MEMBERS)) {
  providerHealth[key] = {
    failures: 0,
    lastFailure: null,
    lastSuccess: null,
    avgLatency: 0,
    totalCalls: 0
  };
}

// =============================================================================
// COUNCIL TYPES
// =============================================================================

export const COUNCIL_TYPES = {
  FULL: 'full',           // All 6 providers (1 local + 5 cloud)
  FAST: 'fast',           // 2 fastest cloud (Cerebras + Groq)
  ADAPTIVE: 'adaptive',   // Start with 3, add more if low consensus
  TIER1: 'tier1',         // Only tier 1 cloud (3 providers)
  EXTENDED: 'extended',   // Tier 1 + 1 tier 2 for tiebreaking
  LOCAL: 'local',         // Only local Ollama (fastest, zero cost)
  HYBRID: 'hybrid'        // Local + 2 fastest cloud for validation
};

// =============================================================================
// COUNCIL SYSTEM PROMPT
// =============================================================================

const COUNCIL_SYSTEM_PROMPT = `Sei un membro del NetMap AI Council, un sistema di consenso multi-modello per la gestione della rete.
Il tuo compito è rispondere alle domande sulla rete in modo preciso e conciso.

Capacità:
- Ricerca MAC address (qualsiasi formato: AA:BB:CC:DD:EE:FF, AABB.CCDD.EEFF, aa-bb-cc-dd-ee-ff)
- Identificazione device e switch
- Analisi topologia di rete
- Troubleshooting connettività

Per ricerche MAC, estrai:
- MAC address (qualsiasi formato)
- Network/CIDR se specificato
- VLAN se menzionata

Rispondi in italiano con informazioni concrete.
Se non hai abbastanza informazioni, indica chiaramente cosa manca.`;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function queryMember(memberKey, messages, options = {}) {
  const member = COUNCIL_MEMBERS[memberKey];

  // For local Ollama, just check if it's configured (no API key needed)
  if (!member || (!member.isLocal && !member.apiKey)) {
    return {
      provider: memberKey,
      error: `Provider ${memberKey} non configurato`,
      response: null
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), member.timeout);

  try {
    const startTime = Date.now();

    let response;
    let content;

    if (member.isLocal) {
      // Ollama API format (different from OpenAI)
      // Use explicit HTTP agent for local connections
      response = await nodeFetch(member.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: member.model,
          messages: [
            { role: 'system', content: COUNCIL_SYSTEM_PROMPT },
            ...messages
          ],
          stream: false,
          keep_alive: -1,  // Keep model loaded indefinitely
          options: {
            temperature: options.temperature || 0.3
          }
        }),
        signal: controller.signal,
        agent: localHttpAgent
      });

      clearTimeout(timeout);
      const elapsed = Date.now() - startTime;
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      content = data.message?.content || '';

      // Update health tracking
      providerHealth[memberKey].lastSuccess = Date.now();
      providerHealth[memberKey].totalCalls++;
      providerHealth[memberKey].avgLatency =
        (providerHealth[memberKey].avgLatency * (providerHealth[memberKey].totalCalls - 1) + elapsed)
        / providerHealth[memberKey].totalCalls;

      return {
        provider: memberKey,
        name: member.name,
        model: member.model,
        specialty: member.specialty,
        response: content,
        elapsed,
        tokens: data.eval_count || 0,
        error: null
      };
    }

    // OpenAI-compatible API format (Cerebras, Groq, Google, SambaNova, OpenRouter)
    const headers = {
      'Authorization': `Bearer ${member.apiKey}`,
      'Content-Type': 'application/json',
      ...(member.extraHeaders || {})
    };

    response = await nodeFetch(member.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: member.model,
        messages: [
          { role: 'system', content: COUNCIL_SYSTEM_PROMPT },
          ...messages
        ],
        max_tokens: options.maxTokens || 1024,
        temperature: options.temperature || 0.3
      }),
      signal: controller.signal,
      agent: connectionPools[memberKey]
    });

    clearTimeout(timeout);

    const elapsed = Date.now() - startTime;
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    content = data.choices?.[0]?.message?.content || '';

    // Update health tracking
    providerHealth[memberKey].lastSuccess = Date.now();
    providerHealth[memberKey].totalCalls++;
    providerHealth[memberKey].avgLatency =
      (providerHealth[memberKey].avgLatency * (providerHealth[memberKey].totalCalls - 1) + elapsed)
      / providerHealth[memberKey].totalCalls;

    return {
      provider: memberKey,
      name: member.name,
      model: member.model,
      specialty: member.specialty,
      response: content,
      elapsed,
      tokens: data.usage?.total_tokens || 0,
      error: null
    };

  } catch (err) {
    clearTimeout(timeout);
    console.error(`[Council] ${member.name} error:`, err.message);

    // Update health tracking
    providerHealth[memberKey].failures++;
    providerHealth[memberKey].lastFailure = Date.now();

    return {
      provider: memberKey,
      name: member.name,
      specialty: member.specialty,
      error: err.message,
      response: null
    };
  }
}

function calculateSimilarity(response1, response2) {
  if (!response1 || !response2) return 0;

  // Jaccard similarity on word tokens
  const tokens1 = new Set(response1.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokens2 = new Set(response2.toLowerCase().split(/\s+/).filter(t => t.length > 2));

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

function findConsensus(responses) {
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

  // Calculate pairwise similarities and consensus scores
  const scores = validResponses.map((r, i) => {
    let totalSimilarity = 0;
    const pairwiseSimilarities = [];

    for (let j = 0; j < validResponses.length; j++) {
      if (i !== j) {
        const sim = calculateSimilarity(r.response, validResponses[j].response);
        totalSimilarity += sim;
        pairwiseSimilarities.push({
          with: validResponses[j].name,
          similarity: sim
        });
      }
    }

    return {
      ...r,
      consensusScore: totalSimilarity / (validResponses.length - 1),
      pairwiseSimilarities
    };
  });

  scores.sort((a, b) => b.consensusScore - a.consensusScore);

  const avgSimilarity = scores.reduce((sum, s) => sum + s.consensusScore, 0) / scores.length;

  return {
    consensus: scores[0],
    confidence: avgSimilarity,
    allResponses: scores,
    details: `${validResponses.length} provider, similarity ${(avgSimilarity * 100).toFixed(1)}%`
  };
}

function mergeResponses(responses) {
  const validResponses = responses.filter(r => r.response && !r.error);

  if (validResponses.length === 0) return 'Nessun provider disponibile.';
  if (validResponses.length === 1) return validResponses[0].response;

  let merged = '**Analisi Council (risposte divergenti da ' + validResponses.length + ' modelli):**\n\n';

  validResponses.forEach((r) => {
    merged += `**${r.name}** [${r.specialty}] (${r.elapsed}ms):\n${r.response}\n\n---\n\n`;
  });

  return merged.trim();
}

function getConfiguredProviders() {
  return Object.entries(COUNCIL_MEMBERS)
    .filter(([_, config]) => config.isLocal || !!config.apiKey)  // Local is always configured
    .map(([key, config]) => ({
      key,
      name: config.name,
      tier: config.tier,
      specialty: config.specialty,
      isLocal: config.isLocal || false
    }));
}

function selectProvidersForType(type) {
  const configured = getConfiguredProviders();

  switch (type) {
    case COUNCIL_TYPES.LOCAL:
      // Only local Ollama
      return configured
        .filter(p => p.isLocal)
        .map(p => p.key);

    case COUNCIL_TYPES.HYBRID:
      // Local + 2 fastest cloud for validation
      const local = configured.filter(p => p.isLocal).map(p => p.key);
      const fastCloud = configured
        .filter(p => ['cerebras', 'groq'].includes(p.key))
        .map(p => p.key);
      return [...local, ...fastCloud];

    case COUNCIL_TYPES.FAST:
      // Only fastest tier 1 cloud providers
      return configured
        .filter(p => ['cerebras', 'groq'].includes(p.key))
        .map(p => p.key);

    case COUNCIL_TYPES.TIER1:
      // All tier 1 cloud providers
      return configured
        .filter(p => p.tier === 1)
        .map(p => p.key);

    case COUNCIL_TYPES.EXTENDED:
      // Tier 1 + best tier 2
      const tier1 = configured.filter(p => p.tier === 1).map(p => p.key);
      const tier2 = configured.filter(p => p.tier === 2);
      if (tier2.length > 0) {
        // Pick healthiest tier 2 provider
        tier2.sort((a, b) =>
          (providerHealth[a.key].failures || 0) - (providerHealth[b.key].failures || 0)
        );
        tier1.push(tier2[0].key);
      }
      return tier1;

    case COUNCIL_TYPES.FULL:
      // All configured providers (local + cloud)
      return configured.map(p => p.key);

    case COUNCIL_TYPES.ADAPTIVE:
    default:
      // Start with local + tier 1, will add more if needed
      return configured
        .filter(p => p.isLocal || p.tier === 1)
        .map(p => p.key);
  }
}

// =============================================================================
// MAIN COUNCIL FUNCTIONS
// =============================================================================

export async function councilQuery(userMessage, options = {}) {
  const {
    type = COUNCIL_TYPES.FULL,
    minConfidence = 0.6,
    onProgress = null
  } = options;

  const startTime = Date.now();
  const messages = [{ role: 'user', content: userMessage }];

  if (onProgress) onProgress({ stage: 1, message: 'Interrogazione Council...' });

  let membersToQuery = selectProvidersForType(type);

  console.log(`[Council] Stage 1: Query a ${membersToQuery.length} provider (${type}): ${membersToQuery.join(', ')}`);

  // Stage 1: Parallel query to selected providers
  const queryPromises = membersToQuery.map(key => queryMember(key, messages));
  let responses = await Promise.all(queryPromises);

  const successCount = responses.filter(r => !r.error).length;
  console.log(`[Council] Stage 1 complete: ${successCount}/${membersToQuery.length} risposte`);

  if (onProgress) onProgress({
    stage: 2,
    message: `${successCount} risposte ricevute, calcolo consenso...`
  });

  // Stage 2: Calculate consensus
  let consensus = findConsensus(responses);

  // Adaptive: add more providers if consensus is low
  if (type === COUNCIL_TYPES.ADAPTIVE && consensus.confidence < minConfidence) {
    const allConfigured = getConfiguredProviders();
    const tier2Available = allConfigured
      .filter(p => p.tier === 2 && !membersToQuery.includes(p.key))
      .map(p => p.key);

    if (tier2Available.length > 0) {
      console.log(`[Council] Adaptive: confidence ${(consensus.confidence * 100).toFixed(1)}% < ${minConfidence * 100}%, adding tier 2: ${tier2Available.join(', ')}`);

      if (onProgress) onProgress({ stage: 2.5, message: `Aggiunta ${tier2Available.length} provider tier 2 per consenso...` });

      const additionalPromises = tier2Available.map(key => queryMember(key, messages));
      const additionalResponses = await Promise.all(additionalPromises);

      responses = [...responses, ...additionalResponses];
      membersToQuery = [...membersToQuery, ...tier2Available];

      consensus = findConsensus(responses);
      console.log(`[Council] Adaptive recalculated: confidence ${(consensus.confidence * 100).toFixed(1)}%`);
    }
  }

  const elapsed = Date.now() - startTime;

  if (onProgress) onProgress({ stage: 3, message: 'Preparazione risposta finale...' });

  // Stage 3: Prepare final response
  let finalResponse;
  let responseType;

  if (consensus.confidence >= minConfidence) {
    finalResponse = consensus.consensus.response;
    responseType = 'consensus';
  } else if (consensus.confidence >= 0.3) {
    finalResponse = consensus.consensus.response +
      `\n\n_[Council: confidence ${(consensus.confidence * 100).toFixed(0)}%, risposta da ${consensus.consensus.name} (${consensus.consensus.specialty})]_`;
    responseType = 'low-consensus';
  } else {
    finalResponse = mergeResponses(responses);
    responseType = 'divergent';
  }

  const result = {
    response: finalResponse,
    responseType,
    confidence: consensus.confidence,
    councilType: type,
    providers: {
      queried: membersToQuery.length,
      successful: successCount,
      details: responses.map(r => ({
        name: r.name || r.provider,
        specialty: r.specialty,
        success: !r.error,
        elapsed: r.elapsed,
        tokens: r.tokens,
        error: r.error
      }))
    },
    elapsed,
    debug: {
      allResponses: consensus.allResponses,
      consensusDetails: consensus.details
    }
  };

  console.log(`[Council] Complete: ${responseType}, confidence ${(consensus.confidence * 100).toFixed(1)}%, ${elapsed}ms`);

  return result;
}

export async function councilChat(message, history = [], options = {}) {
  const result = await councilQuery(message, options);

  return {
    response: result.response,
    responseType: result.responseType,
    agent: `NetMap Council (${result.councilType})`,
    confidence: result.confidence,
    councilType: result.councilType,
    providers: result.providers,
    elapsed: result.elapsed
  };
}

export async function testCouncil() {
  console.log('[Council] Testing all providers...');

  const testMessage = 'Rispondi solo "OK" per confermare che funzioni.';
  const messages = [{ role: 'user', content: testMessage }];

  const results = {};
  let passCount = 0;
  const totalConfigured = getConfiguredProviders().length;

  for (const [key, config] of Object.entries(COUNCIL_MEMBERS)) {
    // Local providers don't need API key, cloud providers do
    const isConfigured = config.isLocal || !!config.apiKey;

    if (!isConfigured) {
      results[key] = {
        name: config.name,
        model: config.model,
        specialty: config.specialty,
        tier: config.tier,
        isLocal: config.isLocal || false,
        success: false,
        error: 'API key not configured'
      };
      continue;
    }

    const result = await queryMember(key, messages);
    const success = !result.error;

    results[key] = {
      name: config.name,
      model: config.model,
      specialty: config.specialty,
      tier: config.tier,
      isLocal: config.isLocal || false,
      success,
      elapsed: result.elapsed,
      error: result.error
    };

    if (success) passCount++;
    const typeLabel = config.isLocal ? '(LOCAL)' : '(CLOUD)';
    console.log(`[Council] ${config.name} ${typeLabel}: ${result.error ? 'FAIL - ' + result.error : 'OK - ' + result.elapsed + 'ms'}`);
  }

  return {
    status: passCount === totalConfigured ? 'all_pass' : passCount > 0 ? 'partial' : 'all_fail',
    summary: `${passCount}/${totalConfigured} providers operational`,
    results
  };
}

export function getCouncilStatus() {
  const configured = getConfiguredProviders();

  const status = {
    status: configured.length >= 3 ? 'operational' : configured.length > 0 ? 'degraded' : 'offline',
    councilTypes: Object.values(COUNCIL_TYPES),
    members: {},
    available: configured.length,
    total: Object.keys(COUNCIL_MEMBERS).length,
    byTier: {
      tier0_local: configured.filter(p => p.tier === 0).length,
      tier1_cloud: configured.filter(p => p.tier === 1).length,
      tier2_cloud: configured.filter(p => p.tier === 2).length
    },
    localProviders: configured.filter(p => p.isLocal).length,
    cloudProviders: configured.filter(p => !p.isLocal).length,
    health: {}
  };

  for (const [key, config] of Object.entries(COUNCIL_MEMBERS)) {
    // Local providers don't need API key, cloud providers do
    const isConfigured = config.isLocal || !!config.apiKey;

    status.members[key] = {
      name: config.name,
      model: config.model,
      configured: isConfigured,
      specialty: config.specialty,
      tier: config.tier,
      isLocal: config.isLocal || false
    };

    if (isConfigured) {
      status.health[key] = {
        failures: providerHealth[key].failures,
        avgLatency: Math.round(providerHealth[key].avgLatency),
        totalCalls: providerHealth[key].totalCalls
      };
    }
  }

  return status;
}

export function getProviderHealth() {
  return { ...providerHealth };
}

export default {
  councilQuery,
  councilChat,
  testCouncil,
  getCouncilStatus,
  getProviderHealth,
  COUNCIL_TYPES,
  COUNCIL_MEMBERS
};
