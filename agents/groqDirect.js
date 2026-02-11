/**
 * Multi-Provider LLM API - Direct Integration
 * Implementazione ottimizzata per MAC search con tool calling nativo
 *
 * v3.0 - PROVIDER DIRETTI (no OpenRouter middleman):
 * - Google AI Studio: Gemini 2.0 Flash (1M token/min FREE)
 * - Groq: Llama 3.3 70B (300 tok/s, velocissimo)
 * - OpenRouter: Fallback finale
 */

import dns from 'node:dns';
import https from 'node:https';
import nodeFetch from 'node-fetch';

// Forza DNS a risolvere IPv4 prima (critico per server senza IPv6)
dns.setDefaultResultOrder('ipv4first');

// Cache per IP funzionanti (hostname -> last working IP)
const workingIpCache = new Map();

// DNS pre-cache per evitare lookup lenti
const dnsCache = new Map();

/**
 * Pre-resolve DNS e cache risultati
 */
async function preResolveDns(hostname) {
  return new Promise((resolve) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        dnsCache.set(hostname, { addresses, timestamp: Date.now() });
        console.log(`[DNS-Cache] ${hostname} -> ${addresses.join(', ')}`);
      }
      resolve(addresses || []);
    });
  });
}

/**
 * Custom DNS lookup con cache e rotazione IP
 * Usa round-robin per distribuire load e evitare IP bloccati
 */
const ipRotationIndex = new Map(); // hostname -> last used index

function createCachedLookup() {
  return (hostname, options, callback) => {
    // Check cache (valid for 5 minutes)
    const cached = dnsCache.get(hostname);
    if (cached && (Date.now() - cached.timestamp) < 300000) {
      const addresses = cached.addresses;
      // Round-robin: usa IP diverso ogni volta
      const lastIdx = ipRotationIndex.get(hostname) || 0;
      const nextIdx = (lastIdx + 1) % addresses.length;
      ipRotationIndex.set(hostname, nextIdx);
      const ip = addresses[nextIdx];
      console.log(`[DNS] ${hostname} -> ${ip} (${nextIdx + 1}/${addresses.length})`);
      return callback(null, ip, 4);
    }

    // Fallback to resolve
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        return dns.lookup(hostname, { ...options, family: 4 }, callback);
      }
      dnsCache.set(hostname, { addresses, timestamp: Date.now() });
      ipRotationIndex.set(hostname, 0);
      console.log(`[DNS] ${hostname} resolved: ${addresses.join(', ')}`);
      callback(null, addresses[0], 4);
    });
  };
}

// =============================================================================
// CONNECTION POOL - Agent dedicati per ogni provider con keep-alive aggressivo
// =============================================================================
const connectionPools = {
  groq: new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 30000,      // Keep connection alive for 30s
    maxSockets: 10,             // Max 10 concurrent connections
    maxFreeSockets: 5,          // Keep 5 idle connections ready
    timeout: 60000,
    scheduling: 'fifo',
    lookup: createCachedLookup()
  }),
  google: new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 60000,
    scheduling: 'fifo',
    lookup: createCachedLookup()
  }),
  openrouter: new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    maxFreeSockets: 5,
    timeout: 60000,
    scheduling: 'fifo',
    lookup: createCachedLookup()
  })
};

// Flag per warmup completato
let connectionsWarmed = false;

/**
 * Warmup connessioni all'avvio - scalda pool PRINCIPALE con richieste reali
 * NIENTE AbortController - lascia completare naturalmente
 */
async function warmupConnections() {
  if (connectionsWarmed) return;

  console.log('[Pool] Warming up MAIN connection pools...');

  // FASE 1: Pre-resolve DNS
  await Promise.all([
    preResolveDns('api.groq.com'),
    preResolveDns('generativelanguage.googleapis.com'),
    preResolveDns('openrouter.ai')
  ]);

  // FASE 2: Warmup sul POOL PRINCIPALE (senza AbortController!)
  // Retry con IP rotation se primo fallisce
  const warmupMainPool = async (name, url, options = {}, maxRetries = 3) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const start = Date.now();
      try {
        // USA IL POOL PRINCIPALE - timeout 180s per prima connessione lenta
        const response = await nodeFetch(url, {
          ...options,
          agent: connectionPools[name],
          timeout: 180000  // 3 minuti - prima connessione Groq è MOLTO lenta
        });
        await response.text();
        const elapsed = Date.now() - start;
        console.log(`[Pool] ${name} MAIN pool warmed in ${elapsed}ms (attempt ${attempt})`);
        return true;
      } catch (e) {
        console.log(`[Pool] ${name} warmup attempt ${attempt}/${maxRetries}: ${e.message}`);
        // IP rotation automatica al prossimo tentativo (grazie al lookup modificato)
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000)); // wait 1s before retry
        }
      }
    }
    console.log(`[Pool] ${name} warmup failed after ${maxRetries} attempts - pool still usable`);
    return false;
  };

  // Warmup sequenziale per Groq (il più critico) - se fallisce passa avanti
  await warmupMainPool('groq', 'https://api.groq.com/openai/v1/models', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${PROVIDERS.groq.apiKey}` }
  });

  // Gli altri in parallelo
  await Promise.allSettled([
    warmupMainPool('google',
      `https://generativelanguage.googleapis.com/v1beta/models?key=${PROVIDERS.google.apiKey}`,
      { method: 'GET' }
    ),
    warmupMainPool('openrouter', 'https://openrouter.ai/api/v1/models', {
      method: 'GET'
    })
  ]);

  connectionsWarmed = true;
  console.log('[Pool] Warmup complete - MAIN pools ready');
}

// Avvia warmup automaticamente dopo 1 secondo dall'import
setTimeout(warmupConnections, 1000);

/**
 * Get agent per provider specifico
 */
function getAgentForProvider(providerName) {
  return connectionPools[providerName] || connectionPools.groq;
}

// Wrapper fetch che usa connection pool per provider
async function fetchIPv4(url, options = {}, providerName = 'groq') {
  const { signal, ...restOptions } = options;
  const agent = getAgentForProvider(providerName);

  try {
    const response = await nodeFetch(url, {
      ...restOptions,
      signal,
      agent
    });
    return response;
  } catch (firstError) {
    if (firstError.name === 'AbortError' || firstError.type === 'aborted') {
      throw firstError;
    }

    console.log(`[Fetch] First attempt failed: ${firstError.message}`);

    // Retry con nuovo agent (forza nuova connessione)
    const retryAgent = new https.Agent({
      family: 4,
      keepAlive: true,
      timeout: 60000,
      lookup: createCachedLookup()
    });

    try {
      const response = await nodeFetch(url, {
        ...restOptions,
        agent: retryAgent
      });
      return response;
    } catch (retryError) {
      console.log(`[Fetch] Retry also failed: ${retryError.message}`);
      throw firstError;
    }
  }
}

// =============================================================================
// PROVIDER CONFIGURATION - Direct API endpoints
// =============================================================================
const PROVIDERS = {
  google: {
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    // SECURITY: API key MUST be set via environment variable
    apiKey: process.env.GOOGLE_AI_KEY || null,
    headers: {}
  },
  groq: {
    name: 'Groq',
    // Diretto - CF Gateway bloccato da firewall aziendale
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    // SECURITY: API key MUST be set via environment variable
    apiKey: process.env.GROQ_API_KEY || null,
    headers: {}
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: process.env.OPENROUTER_API_KEY,
    headers: {
      'HTTP-Referer': 'https://netmap.local',
      'X-Title': 'NetMap AI Assistant'
    }
  }
};

// =============================================================================
// MODEL CHAIN - Fallback strategy: Groq → Google → OpenRouter
// Groq: velocissimo 300 tok/s, tool calling eccellente
// Google: backup (ha problemi IPv6 su questo server)
// =============================================================================
const MODEL_CHAIN = [
  {
    provider: 'groq',
    id: 'llama-3.3-70b-versatile',
    name: 'Llama 3.3 70B',
    maxRetries: 2,
    timeout: 60000 // Aumentato a 60s
  },
  {
    provider: 'google',
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    maxRetries: 1,
    timeout: 60000 // Aumentato a 60s
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-2.0-flash-001',
    name: 'Gemini via OpenRouter',
    maxRetries: 1,
    timeout: 60000 // Aumentato a 60s
  }
];

// Tool definition per search_mac
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_mac',
      description: 'Cerca un MAC address nella rete. Trova switch e porta dove è connesso. Se il MAC non è nel database, serve specificare la rete per attivare la ricerca SSH.',
      parameters: {
        type: 'object',
        properties: {
          mac: {
            type: 'string',
            description: 'MAC address da cercare. Accetta TUTTI i formati: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aaaa-bbbb-cccc (Huawei), aabb.ccdd.eeff (Cisco), aabbccddeeff. L\'API normalizza automaticamente.'
          },
          network: {
            type: 'string',
            description: 'Rete CIDR dove cercare (es: 10.3.0.0/16). Opzionale ma necessario per ricerca SSH se MAC non in database.'
          }
        },
        required: ['mac']
      }
    }
  }
];

const SYSTEM_PROMPT = `Sei un assistente di rete specializzato nella ricerca di MAC address.
Quando l'utente chiede di trovare un MAC address, usa SEMPRE il tool search_mac.

CRITICO - LISTA DI MAC ADDRESS:
- Se l'utente fornisce MULTIPLI MAC address, DEVI generare UNA chiamata search_mac per OGNUNO
- NON inventare MAI risultati - usa SOLO i risultati dei tool calls
- NON dire "NON TROVATO" se non hai fatto il tool call per quel MAC
- Se non riesci a generare tool calls per tutti i MAC, rispondi SOLO con i risultati che hai
- MAI rispondere per un MAC senza aver fatto il tool call corrispondente

FORMATI MAC ACCETTATI (tutti validi, l'API normalizza automaticamente):
- Standard: aa:bb:cc:dd:ee:ff
- Windows: aa-bb-cc-dd-ee-ff
- Huawei: aaaa-bbbb-cccc (es: 00e6-0e71-2440)
- Cisco: aabb.ccdd.eeff
- Raw: aabbccddeeff
NON rifiutare mai un MAC per il formato - passa sempre al tool search_mac.

IMPORTANTE - Quando il MAC viene TROVATO:
- DEVI riportare TUTTI i dettagli restituiti dal tool: Switch, IP, Porta, VLAN
- NON riassumere, NON omettere informazioni
- Formatta la risposta in modo chiaro con i campi separati
- Rispondi SOLO con il risultato della ricerca CORRENTE (ultima richiesta)
- NON ripetere risultati di ricerche precedenti nella conversazione

IMPORTANTE - Gestione Network:
- Se l'utente HA GIÀ SPECIFICATO una rete nella richiesta (es: "cerca su 192.168.6.0/24"), USA QUELLA RETE per tutte le chiamate search_mac
- Riconosci formati network: 10.X.Y.0/24, 192.168.X.0/24, "network X", "rete X", "su X"

CRITICO - Quando il MAC NON viene trovato:
- Se HAI GIÀ USATO una rete nel tool (network era specificato), rispondi SOLO: "MAC X non trovato nella rete Y. Il dispositivo potrebbe essere spento o non connesso."
- MAI chiedere "In quale rete cercare?" se la rete ERA GIÀ SPECIFICATA nel messaggio utente o nel tool call
- Chiedi la rete SOLO se l'utente NON ha MAI specificato una rete E il tool NON aveva il parametro network

Rispondi in italiano.`;

/**
 * Sleep con jitter per evitare thundering herd
 */
function sleep(ms) {
  const jitter = Math.random() * 0.3 * ms;
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

/**
 * Calcola delay per exponential backoff
 */
function getBackoffDelay(attempt) {
  const baseDelay = 1000;
  const maxDelay = 30000;
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}

/**
 * Valida formato MAC address
 * Accetta: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aaaa-bbbb-cccc, aabb.ccdd.eeff, aabbccddeeff
 */
function isValidMac(mac) {
  if (!mac || typeof mac !== 'string') return false;
  const patterns = [
    /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/,     // aa:bb:cc:dd:ee:ff o aa-bb-cc-dd-ee-ff
    /^([0-9a-fA-F]{4}-){2}[0-9a-fA-F]{4}$/,         // aaaa-bbbb-cccc (Huawei)
    /^([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/,        // aabb.ccdd.eeff (Cisco)
    /^[0-9a-fA-F]{12}$/                              // aabbccddeeff (raw)
  ];
  return patterns.some(p => p.test(mac));
}

/**
 * Valida formato network CIDR
 * Accetta: 10.0.0.0/8, 192.168.1.0/24, etc.
 */
function isValidNetwork(network) {
  if (!network || typeof network !== 'string') return false;
  const cidrPattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
  const match = network.match(cidrPattern);
  if (!match) return false;

  // Valida ogni ottetto (0-255)
  for (let i = 1; i <= 4; i++) {
    const octet = parseInt(match[i], 10);
    if (octet < 0 || octet > 255) return false;
  }

  // Valida prefix length (0-32)
  const prefix = parseInt(match[5], 10);
  if (prefix < 0 || prefix > 32) return false;

  return true;
}

/**
 * Esegue il tool search_mac chiamando l'API locale
 */
async function executeSearchMac(mac, network = null) {
  // Input validation - SECURITY FIX
  if (!isValidMac(mac)) {
    return `Errore: formato MAC address non valido: ${mac}. Formati accettati: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aaaa-bbbb-cccc, aabb.ccdd.eeff`;
  }

  if (network && !isValidNetwork(network)) {
    return `Errore: formato network CIDR non valido: ${network}. Formato atteso: X.X.X.X/Y (es: 10.0.0.0/16)`;
  }

  try {
    const body = { mac };
    if (network) body.network = network;

    // Timeout 150s per chiamata locale (SSH trace può essere lungo)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 150000);

    const response = await fetch('http://localhost:4000/api/search/mac/hybrid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const result = await response.json();

    if (result.error) {
      return `Errore: ${result.error}`;
    }

    if (!result.found) {
      if (network) {
        return `MAC ${mac} NON TROVATO nemmeno via SSH nella rete ${network}. Il dispositivo potrebbe essere spento o non connesso.`;
      }
      return `MAC ${mac} NON TROVATO nel database locale. Per cercarlo in tempo reale sugli switch via SSH, specifica la rete (es: 10.3.0.0/16).`;
    }

    const ep = result.endpoint || {};
    const switchName = ep.device || ep.sysName || 'N/A';
    const switchIp = ep.deviceIp || ep.ip || 'N/A';
    const portName = ep.ifName || 'N/A';
    const vlanId = ep.vlan || 'N/A';

    let responseText = `MAC ${mac} TROVATO!
Switch: ${switchName}
IP Switch: ${switchIp}
Porta: ${portName}
VLAN: ${vlanId}
Fonte: ${result.source || 'database'}
Tempo: ${result.elapsed || 'N/A'}`;

    if (ep.lldpNeighbor) {
      responseText += `\n\nDispositivo connesso (LLDP):
Nome: ${ep.lldpNeighbor}`;
      if (ep.neighborIp) responseText += `\nIP: ${ep.neighborIp}`;
      if (ep.neighborDescription) responseText += `\nDescrizione: ${ep.neighborDescription}`;
      if (ep.neighborPort) responseText += `\nPorta remota: ${ep.neighborPort}`;
      if (ep.neighborType) responseText += `\nTipo: ${ep.neighborType}`;
    }

    return responseText;
  } catch (err) {
    return `Errore nella ricerca: ${err.message}`;
  }
}

/**
 * Chiamata API generica per qualsiasi provider OpenAI-compatible
 * v3.0: Supporta Google AI Studio, Groq, OpenRouter
 */
async function callProvider(providerName, body, timeoutMs = 30000) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Provider sconosciuto: ${providerName}`);
  }

  if (!provider.apiKey) {
    throw new Error(`API key mancante per ${provider.name}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      ...provider.headers
    };

    const response = await fetchIPv4(provider.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }, providerName);

    clearTimeout(timeout);

    // Parse rate limit headers
    const rateLimitInfo = {
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset'),
      limit: response.headers.get('x-ratelimit-limit')
    };

    const data = await response.text();

    if (!response.ok) {
      const error = new Error(`${provider.name} API error: ${response.status} - ${data}`);
      error.status = response.status;
      error.rateLimitInfo = rateLimitInfo;
      throw error;
    }

    try {
      const parsed = JSON.parse(data);
      parsed._rateLimitInfo = rateLimitInfo;
      return parsed;
    } catch (e) {
      throw new Error(`Invalid JSON response: ${e.message}`);
    }
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw new Error(`Network error: ${e.message}`);
  }
}

/**
 * Prova un modello con retry e exponential backoff
 * v3.0: Usa provider dal model config
 */
async function tryModelWithRetry(model, requestBody) {
  let lastError;

  for (let attempt = 0; attempt < model.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt);
        console.log(`[AI] ${model.name}: retry ${attempt}/${model.maxRetries}, attendo ${delay}ms`);
        await sleep(delay);
      }

      const data = await callProvider(model.provider, {
        model: model.id,
        ...requestBody
      }, model.timeout);

      if (data._rateLimitInfo?.remaining) {
        console.log(`[AI] ${model.name}: rate limit remaining = ${data._rateLimitInfo.remaining}`);
      }

      return { data, model };

    } catch (err) {
      lastError = err;
      const status = err.status || 0;

      // 429 = Rate limit, 5xx = Server error - riprova
      if (status === 429 || (status >= 500 && status < 600)) {
        console.log(`[AI] ${model.name} attempt ${attempt + 1}: ${err.message} (retryable)`);
        continue;
      }

      console.log(`[AI] ${model.name}: errore non recuperabile: ${err.message}`);
      break;
    }
  }

  throw lastError;
}

/**
 * Pulisce la history per evitare "tool call validation failed"
 * - Limita a ultimi MAX_HISTORY_MESSAGES
 * - Rimuove tool_calls dai vecchi messaggi assistant
 * - Rimuove messaggi tool orfani (senza tool_call corrispondente)
 */
function sanitizeHistory(history, maxMessages = 10) {
  if (!history || history.length === 0) return [];

  // Prendi solo gli ultimi N messaggi
  const recent = history.slice(-maxMessages);

  // Pulisci tool_calls e messaggi tool
  const cleaned = [];
  for (const msg of recent) {
    if (msg.role === 'tool') {
      // Salta messaggi tool - non servono per contesto futuro
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls) {
      // Rimuovi tool_calls dai messaggi assistant
      cleaned.push({
        role: 'assistant',
        content: msg.content || ''
      });
    } else {
      cleaned.push(msg);
    }
  }

  return cleaned;
}

/**
 * Parsa le tool calls dal formato testuale generato da alcuni modelli
 * Formati supportati:
 * - <function=search_mac>{"mac":"...","network":"..."}</function>
 * - <function=search_mac({"mac":"...","network":"..."})></function>
 */
function parseTextToolCalls(content) {
  const toolCalls = [];

  // Pattern 1: <function=name>{"mac":"...","network":"..."}</function>
  const pattern1 = /<function=(\w+)>(\{"mac":"[^"]+","network":"[^"]+"\})<\/function>/g;
  let match;
  while ((match = pattern1.exec(content)) !== null) {
    try {
      JSON.parse(match[2]); // Validate JSON
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 2: <function=name({"mac":"...","network":"..."})>
  const pattern2 = /<function=(\w+)\((\{"mac":"[^"]+","network":"[^"]+"\})\)>/g;
  while ((match = pattern2.exec(content)) !== null) {
    try {
      JSON.parse(match[2]); // Validate JSON
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 3: Solo MAC senza network - <function=name>{"mac":"..."}</function>
  const pattern3 = /<function=(\w+)>(\{"mac":"[^"]+"\})<\/function>/g;
  while ((match = pattern3.exec(content)) !== null) {
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 4: Formato con virgola - <function=name,{"mac":"...","network":"..."}</function>
  const pattern4 = /<function=(\w+),(\{[^}]+\})<\/function>/g;
  while ((match = pattern4.exec(content)) !== null) {
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 5: Formato generico con qualsiasi JSON - <function=name>{"...":"..."}</function>
  const pattern5 = /<function=(\w+)>(\{[^}]+\})<\/function>/g;
  while ((match = pattern5.exec(content)) !== null) {
    // Skip se già trovato con pattern più specifici
    const alreadyFound = toolCalls.some(tc => tc.function.arguments === match[2]);
    if (alreadyFound) continue;
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 6: Square bracket format - <function=name[]{...}</function>
  const pattern6 = /<function=(\w+)\[\](\{[^}]+\})<\/function>/g;
  while ((match = pattern6.exec(content)) !== null) {
    const alreadyFound = toolCalls.some(tc => tc.function.arguments === match[2]);
    if (alreadyFound) continue;
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 7: Formato senza closing tag - <function=name>{"...":"..."} (end of string or space)
  const pattern7 = /<function=(\w+)>(\{[^}]+\})(?:\s|$)/g;
  while ((match = pattern7.exec(content)) !== null) {
    const alreadyFound = toolCalls.some(tc => tc.function.arguments === match[2]);
    if (alreadyFound) continue;
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 8: Spazio tra nome e JSON - <function=name {"...":"..."}</function>
  const pattern8 = /<function=(\w+)\s+(\{[^}]+\})<\/function>/g;
  while ((match = pattern8.exec(content)) !== null) {
    const alreadyFound = toolCalls.some(tc => tc.function.arguments === match[2]);
    if (alreadyFound) continue;
    try {
      JSON.parse(match[2]);
      toolCalls.push({
        id: `text-tool-${toolCalls.length}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: match[2]
        }
      });
    } catch (e) {
      console.warn('[AI] Failed to parse text tool call:', match[0], e.message);
    }
  }

  // Pattern 9: Array format - <function=name [{...} {...} ...]
  // L'LLM genera array con oggetti separati da spazi invece che virgole
  const pattern9 = /<function=(\w+)\s+\[([\s\S]*?)\](?:\s|$)/g;
  while ((match = pattern9.exec(content)) !== null) {
    const funcName = match[1];
    const arrayContent = match[2];
    // Parsa oggetti JSON separati da spazi o newline
    const jsonObjects = arrayContent.match(/\{[^}]+\}/g);
    if (jsonObjects) {
      for (const jsonStr of jsonObjects) {
        const alreadyFound = toolCalls.some(tc => tc.function.arguments === jsonStr);
        if (alreadyFound) continue;
        try {
          JSON.parse(jsonStr);
          toolCalls.push({
            id: `text-tool-${toolCalls.length}`,
            type: 'function',
            function: {
              name: funcName,
              arguments: jsonStr
            }
          });
        } catch (e) {
          console.warn('[AI] Failed to parse array tool call:', jsonStr, e.message);
        }
      }
    }
  }

  console.log(`[AI] parseTextToolCalls found ${toolCalls.length} calls in content length ${content.length}`);
  return toolCalls;
}

/**
 * Estrae MAC addresses direttamente dal messaggio utente
 * Formati supportati: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aaaa-bbbb-cccc, aabb.ccdd.eeff
 */
function extractMacsFromMessage(message) {
  const macPatterns = [
    /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/g,           // aa:bb:cc:dd:ee:ff o aa-bb-cc-dd-ee-ff
    /([0-9a-fA-F]{4}-){2}[0-9a-fA-F]{4}/g,               // aaaa-bbbb-cccc (Huawei)
    /([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}/g,              // aabb.ccdd.eeff (Cisco)
  ];

  const macs = new Set();
  for (const pattern of macPatterns) {
    const matches = message.match(pattern);
    if (matches) {
      matches.forEach(m => macs.add(m.toLowerCase()));
    }
  }
  return Array.from(macs);
}

/**
 * Estrae network/CIDR dal messaggio utente
 */
function extractNetworkFromMessage(message) {
  // Pattern per CIDR: 192.168.6.0/24, 192.168.1.0/16, etc.
  const cidrPattern = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2})\b/;
  const match = message.match(cidrPattern);
  return match ? match[1] : null;
}

/**
 * Rimuove le tool calls testuali dal contenuto per non mostrarle all'utente
 * Usa gli stessi pattern di parseTextToolCalls
 */
function stripTextToolCalls(content) {
  if (!content) return content;

  let cleaned = content;

  // Rimuovi tutti i pattern di tool calls
  const patterns = [
    /<function=\w+>(\{[^}]+\})<\/function>/g,                    // Pattern 1,3,5
    /<function=\w+\((\{[^}]+\})\)>/g,                            // Pattern 2
    /<function=\w+,(\{[^}]+\})<\/function>/g,                    // Pattern 4
    /<function=\w+\[\](\{[^}]+\})<\/function>/g,                 // Pattern 6
    /<function=\w+>(\{[^}]+\})(?:\s|$)/g,                        // Pattern 7
    /<function=\w+\s+(\{[^}]+\})<\/function>/g,                  // Pattern 8
    /<function=\w+\s+\[[\s\S]*?\](?:\s|$)/g,                     // Pattern 9 - array format
    /<function=\w+[>\[\s].*?(?:<\/function>|$)/gs,               // Catch-all più aggressivo
  ];

  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Rimuovi righe vuote multiple
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * Chat con LLM usando tool calling nativo
 * v3.0: Multi-provider con fallback automatico
 * v3.1: Sanitizzazione history per evitare Groq tool validation errors
 * v3.2: Supporto parsing tool calls testuali
 */
export async function chatWithGroq(message, history = [], onProgress = null) {
  // Pulisci history per evitare "tool call validation failed"
  const cleanHistory = sanitizeHistory(history);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...cleanHistory,
    { role: 'user', content: message }
  ];

  const requestBody = {
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 2048
  };

  let data;
  let usedModel;
  let usedFallback = false;

  if (onProgress) onProgress({ type: 'thinking', message: 'Analisi della richiesta...' });

  for (let i = 0; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];

    try {
      console.log(`[AI] Provo ${model.name} (${model.provider}/${model.id})`);
      const result = await tryModelWithRetry(model, requestBody);
      data = result.data;
      usedModel = result.model;
      usedFallback = i > 0;
      break;
    } catch (err) {
      console.log(`[AI] ${model.name} fallito definitivamente: ${err.message}`);
      if (i === MODEL_CHAIN.length - 1) {
        throw new Error(`Tutti i modelli hanno fallito. Ultimo errore: ${err.message}`);
      }
    }
  }

  const assistantMessage = data.choices?.[0]?.message;

  if (!assistantMessage) {
    console.log(`[AI] Risposta raw:`, JSON.stringify(data).substring(0, 500));
    throw new Error('Risposta LLM vuota');
  }

  // Controlla se ci sono tool_calls strutturate O nel formato testuale
  let toolCalls = assistantMessage.tool_calls || [];

  // Se non ci sono tool_calls strutturate, prova a parsare dal testo
  // Formati: <function=search_mac>{"mac":"..."}}</function> o <function=search_mac({"mac":"..."})></function>
  if (toolCalls.length === 0 && assistantMessage.content) {
    const textToolCalls = parseTextToolCalls(assistantMessage.content);
    if (textToolCalls.length > 0) {
      console.log(`[AI] Parsed ${textToolCalls.length} tool calls from TEXT format`);
      toolCalls = textToolCalls;
    }
  }

  // FALLBACK: Estrai MAC direttamente dal messaggio utente e aggiungi quelli mancanti
  const userMacs = extractMacsFromMessage(message);
  const userNetwork = extractNetworkFromMessage(message);
  console.log(`[AI] Extracted from user message: ${userMacs.length} MACs, network=${userNetwork}`);

  if (userMacs.length > 0) {
    // Trova MAC già coperti dalle tool calls
    const coveredMacs = new Set();
    for (const tc of toolCalls) {
      if (tc.function?.name === 'search_mac') {
        try {
          const args = JSON.parse(tc.function.arguments);
          if (args.mac) coveredMacs.add(args.mac.toLowerCase());
        } catch (e) {}
      }
    }

    // Aggiungi tool calls per MAC mancanti
    const missingMacs = userMacs.filter(mac => !coveredMacs.has(mac));
    if (missingMacs.length > 0) {
      console.log(`[AI] Adding ${missingMacs.length} missing MAC tool calls (found ${userMacs.length} in message, ${coveredMacs.size} covered)`);
      for (const mac of missingMacs) {
        const args = { mac };
        if (userNetwork) args.network = userNetwork;
        toolCalls.push({
          id: `fallback-${toolCalls.length}`,
          type: 'function',
          function: {
            name: 'search_mac',
            arguments: JSON.stringify(args)
          }
        });
      }
    }
  }

  if (toolCalls.length === 0) {
    // Pulisci eventuali tool calls raw non riconosciute
    const cleanedContent = stripTextToolCalls(assistantMessage.content);
    return {
      response: cleanedContent,
      agent: 'NetMap Assistant',
      provider: usedModel.provider,
      model: usedModel.id,
      modelName: usedModel.name,
      fallback: usedFallback,
      history: [...messages, assistantMessage]
    };
  }

  console.log(`[AI] Processing ${toolCalls.length} tool calls`);

  // Esegui tool calls in PARALLEL
  const toolPromises = toolCalls.map(async (toolCall) => {
    if (toolCall.function.name === 'search_mac') {
      const args = JSON.parse(toolCall.function.arguments);
      
      if (onProgress) {
        onProgress({ 
          type: 'tool_start', 
          tool: 'search_mac', 
          args, 
          message: `Ricerca ${args.mac}...` 
        });
      }

      const result = await executeSearchMac(args.mac, args.network);

      if (onProgress) {
        onProgress({ 
          type: 'tool_end', 
          tool: 'search_mac', 
          message: `Trovato ${args.mac}: ${result.includes('TROVATO!') ? 'SI' : 'NO'}` 
        });
      }

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: result
      };
    }
    return null;
  });

  const toolResultsRaw = await Promise.all(toolPromises);
  const toolResults = toolResultsRaw.filter(r => r !== null);

  // Seconda chiamata con i risultati
  if (onProgress) onProgress({ type: 'thinking', message: 'Generazione risposta finale...' });

  // Sanitizza assistantMessage: Gemini non accetta content: null
  const sanitizedAssistantMessage = {
    ...assistantMessage,
    content: assistantMessage.content || ''
  };

  const messagesWithTools = [
    ...messages,
    sanitizedAssistantMessage,
    ...toolResults
  ];

  const finalData = await callProvider(usedModel.provider, {
    model: usedModel.id,
    messages: messagesWithTools,
    max_tokens: 2048
  }, usedModel.timeout);

  const finalMessage = finalData.choices?.[0]?.message?.content;

  // Rimuovi eventuali tool calls raw dalla risposta finale
  const cleanedResponse = stripTextToolCalls(finalMessage) || 'Nessuna risposta';

  return {
    response: cleanedResponse,
    agent: 'MAC Tracker',
    provider: usedModel.provider,
    model: usedModel.id,
    modelName: usedModel.name,
    fallback: usedFallback,
    history: messagesWithTools
  };
}

export default { chatWithGroq };
