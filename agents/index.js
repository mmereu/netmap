/**
 * NetMap AI Agents System
 *
 * Sistema multi-agent per la gestione della rete basato su OpenAI Agents SDK.
 *
 * Architettura:
 *                     ┌──────────────────┐
 *                     │   Triage Agent   │
 *                     │   (Entry Point)  │
 *                     └────────┬─────────┘
 *                              │ handoffs
 *         ┌───────────────┬────┴────┬───────────────┐
 *         ▼               ▼         ▼               ▼
 *   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
 *   │   MAC     │  │  Device   │  │ Discovery │  │  Trouble  │
 *   │  Tracker  │  │ Specialist│  │   Agent   │  │  shooter  │
 *   └───────────┘  └───────────┘  └───────────┘  └───────────┘
 *
 * Uso:
 *   import { chat, triageAgent } from './agents/index.js';
 *
 *   // Uso semplice
 *   const response = await chat('Dove si trova MAC aa:bb:cc:dd:ee:ff?');
 *   console.log(response);
 *
 *   // Uso con storia conversazione
 *   const history = [];
 *   await chat('Cerca MAC 00:11:22:33:44:55', history);
 *   await chat('Mostra lo stato del dispositivo', history);
 */

import { run, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';

// Import agents
export { triageAgent } from './triageAgent.js';
export { macTrackerAgent } from './macTrackerAgent.js';
export { deviceAgent } from './deviceAgent.js';
export { discoveryAgent } from './discoveryAgent.js';
export { troubleshootAgent } from './troubleshootAgent.js';

// Import tools for direct use
export * from './tools.js';

// Import main agent for convenience
import { triageAgent } from './triageAgent.js';

// Provider configuration
const PROVIDERS = {
  openai: {
    baseURL: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini'
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile'
  },
  mimo: {
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'xiaomi/mimo-v2-flash:free',
    headers: {
      'HTTP-Referer': process.env.APP_URL || 'https://localhost',
      'X-Title': 'NetMap AI Agent'
    }
  }
};

let currentProvider = 'groq'; // Default to Groq (free & fast)
let initialized = false;

/**
 * Inizializza il sistema con il provider specificato
 * @param {Object} options - { provider: 'groq'|'openai', apiKey: string }
 */
export function initAgents(options = {}) {
  const provider = options.provider || process.env.AI_PROVIDER || 'groq';
  const config = PROVIDERS[provider];

  if (!config) {
    throw new Error(`Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const apiKey = options.apiKey || process.env[config.envKey];
  if (!apiKey) {
    throw new Error(`API key required. Set ${config.envKey} environment variable or pass apiKey option`);
  }

  // Create OpenAI-compatible client for the provider
  const clientOptions = {
    apiKey,
    baseURL: config.baseURL
  };

  // Add custom headers for providers that need them (e.g., OpenRouter/MiMo)
  if (config.headers) {
    clientOptions.defaultHeaders = config.headers;
  }

  const client = new OpenAI(clientOptions);

  setDefaultOpenAIClient(client);
  currentProvider = provider;
  initialized = true;

  console.log(`AI Agents initialized with ${provider} (model: ${config.defaultModel})`);
}

/**
 * Get current provider's default model
 */
export function getDefaultModel() {
  return PROVIDERS[currentProvider]?.defaultModel || 'llama-3.3-70b-versatile';
}

/**
 * Funzione helper per chat semplice con il sistema multi-agent
 * @param {string} message - Messaggio dell'utente
 * @param {Array} history - Storia della conversazione (opzionale, viene modificata in-place)
 * @param {Object} options - Opzioni aggiuntive { provider, apiKey, stream }
 * @returns {Promise<{response: string, agent: string, history: Array}>}
 */
export async function chat(message, history = [], options = {}) {
  // Inizializza se non già fatto
  if (!initialized) {
    const provider = options.provider || process.env.AI_PROVIDER || 'groq';
    const envKey = PROVIDERS[provider]?.envKey;
    const apiKey = options.apiKey || process.env[envKey];

    if (!apiKey) {
      throw new Error(`API key not set. Set ${envKey} environment variable or pass apiKey option`);
    }

    initAgents({ provider, apiKey });
  }

  // Aggiungi messaggio utente alla storia
  history.push({ role: 'user', content: message });

  try {
    // Esegui l'agente
    const result = await run(triageAgent, history, {
      stream: options.stream || false,
    });

    // Aggiorna storia con la risposta
    history.push(...result.newItems || []);

    return {
      response: result.finalOutput,
      agent: result.lastAgent?.name || 'NetMap Assistant',
      history: result.history,
    };
  } catch (error) {
    console.error('Agent error:', error);
    throw error;
  }
}

/**
 * Esegue una query specifica su un agente specializzato
 * @param {string} agentName - Nome dell'agente ('mac', 'device', 'discovery', 'troubleshoot')
 * @param {string} message - Messaggio/query
 * @returns {Promise<string>}
 */
export async function queryAgent(agentName, message) {
  const agents = {
    mac: (await import('./macTrackerAgent.js')).macTrackerAgent,
    device: (await import('./deviceAgent.js')).deviceAgent,
    discovery: (await import('./discoveryAgent.js')).discoveryAgent,
    troubleshoot: (await import('./troubleshootAgent.js')).troubleshootAgent,
  };

  const agent = agents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}. Valid: ${Object.keys(agents).join(', ')}`);
  }

  const result = await run(agent, message);
  return result.finalOutput;
}

// Default export
export default {
  chat,
  queryAgent,
  initAgents,
  triageAgent,
};
