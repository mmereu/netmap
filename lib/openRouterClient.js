/**
 * OpenRouter Client per MiMo-V2-Flash
 *
 * Client dedicato per interagire con Xiaomi MiMo-V2-Flash via OpenRouter API.
 * Supporta streaming, reasoning mode, e retry automatico.
 *
 * @example
 * import { queryMiMo, queryMiMoStream } from './lib/openRouterClient.js';
 *
 * // Query semplice
 * const result = await queryMiMo('Analizza questa topologia di rete');
 * console.log(result.content);
 *
 * // Query con streaming
 * await queryMiMoStream('Spiega LLDP', chunk => process.stdout.write(chunk));
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'xiaomi/mimo-v2-flash:free';

// Configurazione di default
const DEFAULT_CONFIG = {
  maxTokens: 4096,
  temperature: 0.7,
  topP: 0.95,
  includeReasoning: false, // Abilita per vedere il processo di ragionamento
};

/**
 * Ottiene l'API key da environment
 */
function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY non configurata. Aggiungi a /etc/environment');
  }
  return key;
}

/**
 * Query sincrona a MiMo-V2-Flash
 *
 * @param {string} prompt - Il prompt/domanda
 * @param {Object} options - Opzioni
 * @param {string} options.systemPrompt - System prompt personalizzato
 * @param {number} options.maxTokens - Max token output (default: 4096)
 * @param {number} options.temperature - Temperatura (default: 0.7)
 * @param {boolean} options.includeReasoning - Mostra processo di ragionamento
 * @param {Array} options.history - Storia conversazione [{role, content}]
 * @returns {Promise<{content: string, reasoning: string|null, usage: Object, model: string}>}
 */
export async function queryMiMo(prompt, options = {}) {
  const apiKey = getApiKey();

  const config = { ...DEFAULT_CONFIG, ...options };

  // Costruisci messaggi
  const messages = [];

  // System prompt
  if (config.systemPrompt) {
    messages.push({ role: 'system', content: config.systemPrompt });
  } else {
    messages.push({
      role: 'system',
      content: `Sei MiMo, un assistente AI esperto di reti sviluppato da Xiaomi, integrato in NetMap.
Aiuti gli utenti a:
- Tracciare MAC address e dispositivi nella rete
- Analizzare topologie di rete
- Diagnosticare problemi di connettività
- Spiegare concetti di networking

Rispondi sempre in italiano, in modo chiaro e conciso.
Usa terminologia tecnica appropriata ma spiega i concetti quando necessario.`
    });
  }

  // Storia conversazione
  if (config.history && Array.isArray(config.history)) {
    messages.push(...config.history);
  }

  // Messaggio utente
  messages.push({ role: 'user', content: prompt });

  // Prepara request body
  const body = {
    model: DEFAULT_MODEL,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    top_p: config.topP,
    stream: false,
  };

  // Abilita reasoning se richiesto
  if (config.includeReasoning) {
    body.include_reasoning = true;
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://localhost',
        'X-Title': 'NetMap AI Agent'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || `HTTP ${response.status}`;

      // Rate limit handling
      if (response.status === 429) {
        throw new Error(`Rate limit raggiunto: ${errorMsg}. Riprova tra qualche minuto.`);
      }

      throw new Error(`OpenRouter API Error: ${errorMsg}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error('Risposta vuota da MiMo');
    }

    return {
      content: choice.message?.content || '',
      reasoning: choice.message?.reasoning || null,
      usage: data.usage || {},
      model: data.model || DEFAULT_MODEL,
      provider: data.provider || 'Xiaomi',
      finishReason: choice.finish_reason
    };

  } catch (error) {
    // Network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Errore di rete: impossibile raggiungere OpenRouter');
    }
    throw error;
  }
}

/**
 * Query con streaming a MiMo-V2-Flash
 *
 * @param {string} prompt - Il prompt/domanda
 * @param {Function} onChunk - Callback per ogni chunk di testo (chunk) => void
 * @param {Object} options - Stesse opzioni di queryMiMo
 * @returns {Promise<{content: string, usage: Object}>}
 */
export async function queryMiMoStream(prompt, onChunk, options = {}) {
  const apiKey = getApiKey();

  const config = { ...DEFAULT_CONFIG, ...options };

  // Costruisci messaggi
  const messages = [];

  if (config.systemPrompt) {
    messages.push({ role: 'system', content: config.systemPrompt });
  } else {
    messages.push({
      role: 'system',
      content: 'Sei MiMo, un assistente AI esperto di reti. Rispondi in italiano.'
    });
  }

  if (config.history && Array.isArray(config.history)) {
    messages.push(...config.history);
  }

  messages.push({ role: 'user', content: prompt });

  const body = {
    model: DEFAULT_MODEL,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    top_p: config.topP,
    stream: true,
  };

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'https://localhost',
      'X-Title': 'NetMap AI Agent'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`OpenRouter Error: ${errorData.error?.message || response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let usage = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

    for (const line of lines) {
      const data = line.slice(6); // Rimuovi "data: "

      if (data === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || '';

        if (content) {
          fullContent += content;
          if (typeof onChunk === 'function') {
            onChunk(content);
          }
        }

        // Cattura usage finale
        if (parsed.usage) {
          usage = parsed.usage;
        }
      } catch (e) {
        // Ignora errori di parsing (chunk incompleti)
      }
    }
  }

  return {
    content: fullContent,
    usage,
    model: DEFAULT_MODEL
  };
}

/**
 * Verifica lo stato dell'API key e i limiti
 *
 * @returns {Promise<{valid: boolean, tier: string, usage: Object, limit: Object}>}
 */
export async function checkApiStatus() {
  const apiKey = getApiKey();

  try {
    const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    return {
      valid: true,
      tier: data.data?.is_free_tier ? 'free' : 'paid',
      usage: {
        daily: data.data?.usage_daily || 0,
        weekly: data.data?.usage_weekly || 0,
        monthly: data.data?.usage_monthly || 0
      },
      limit: data.data?.limit || null,
      rateLimit: data.data?.rate_limit || null
    };

  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Crea un client OpenAI-compatible per uso con @openai/agents SDK
 *
 * @returns {Object} Client compatibile con OpenAI SDK
 */
export function createOpenAICompatibleClient() {
  const apiKey = getApiKey();

  // Importa dinamicamente OpenAI SDK
  return import('openai').then(({ default: OpenAI }) => {
    return new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://localhost',
        'X-Title': 'NetMap AI Agent'
      }
    });
  });
}

// Export default per compatibilità CommonJS
export default {
  queryMiMo,
  queryMiMoStream,
  checkApiStatus,
  createOpenAICompatibleClient,
  DEFAULT_MODEL
};
