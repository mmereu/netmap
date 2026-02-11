/**
 * Agent API Routes
 *
 * Endpoints per interagire con il sistema multi-agent AI
 *
 * POST /api/agent/chat     - Chat con il sistema (usa triage automatico)
 * POST /api/agent/query    - Query diretta a un agente specifico
 * GET  /api/agent/status   - Stato del sistema agenti
 */

import { Router } from 'express';
import { chat, queryAgent, initAgents } from '../agents/index.js';
import { chatWithGroq } from '../agents/groqDirect.js';
import { queryMiMo, queryMiMoStream, checkApiStatus } from '../lib/openRouterClient.js';

const router = Router();

// Sessioni di chat in-memory con history
// Struttura: Map<sessionId, { history: Message[], lastAccess: number }>
const sessions = new Map();

// Configurazione sessioni
const SESSION_CONFIG = {
  maxHistory: 10,        // Max messaggi per sessione
  maxAge: 3600000,       // 1 ora TTL
  cleanupInterval: 300000 // Cleanup ogni 5 minuti
};

// Provider API key mapping
const PROVIDER_KEYS = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  mimo: 'OPENROUTER_API_KEY'
};

// Cleanup periodico sessioni scadute
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, session] of sessions) {
    if (now - session.lastAccess > SESSION_CONFIG.maxAge) {
      sessions.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Sessions] Cleaned ${cleaned} expired sessions, ${sessions.size} active`);
  }
}, SESSION_CONFIG.cleanupInterval);

/**
 * Ottiene o crea una sessione
 */
function getOrCreateSession(sessionId) {
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      history: [],
      lastAccess: Date.now()
    });
  }

  const session = sessions.get(sessionId);
  session.lastAccess = Date.now();
  return { sessionId, session };
}

/**
 * Aggiunge un messaggio alla history della sessione
 */
function addToHistory(session, role, content) {
  session.history.push({ role, content });

  // Mantieni solo gli ultimi N messaggi
  if (session.history.length > SESSION_CONFIG.maxHistory) {
    session.history = session.history.slice(-SESSION_CONFIG.maxHistory);
  }
}

// Middleware per inizializzare provider AI con fallback intelligente
router.use((req, res, next) => {
  // Skip per endpoint mimo (hanno il proprio handling)
  if (req.path.startsWith('/mimo')) {
    return next();
  }

  let provider = process.env.AI_PROVIDER || 'groq';
  let apiKey = process.env[PROVIDER_KEYS[provider]];

  // Fallback chain: groq -> mimo -> openai
  if (!apiKey) {
    const fallbackOrder = ['groq', 'mimo', 'openai'];
    for (const fallback of fallbackOrder) {
      const key = process.env[PROVIDER_KEYS[fallback]];
      if (key) {
        provider = fallback;
        apiKey = key;
        console.log(`[AI] Provider ${process.env.AI_PROVIDER || 'groq'} non disponibile, fallback a ${provider}`);
        break;
      }
    }
  }

  if (!apiKey) {
    return res.status(500).json({
      error: 'No AI provider configured',
      hint: 'Set GROQ_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY',
      availableProviders: Object.keys(PROVIDER_KEYS)
    });
  }

  try {
    initAgents({ provider, apiKey });
    // Salva il provider usato per riferimento
    req.aiProvider = provider;
  } catch (e) {
    // Already initialized, ignore
  }
  next();
});

/**
 * POST /api/agent/chat
 *
 * Chat con il sistema multi-agent. Il triage agent smista automaticamente
 * la richiesta allo specialista appropriato.
 *
 * Body:
 *   {
 *     "message": "Dove si trova MAC aa:bb:cc:dd:ee:ff?",
 *     "sessionId": "optional-session-id-for-history"
 *   }
 *
 * Response:
 *   {
 *     "response": "Il MAC aa:bb:cc:dd:ee:ff è stato trovato...",
 *     "agent": "MAC Tracker",
 *     "sessionId": "session-id"
 *   }
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Ottieni o crea sessione con history
    const { sessionId: sid, session } = getOrCreateSession(sessionId);

    // Aggiungi messaggio utente alla history
    addToHistory(session, 'user', message);

    // Esegui chat CON history per contesto multi-turn
    // La history viene sanitizzata in chatWithGroq per evitare tool validation errors
    const result = await chatWithGroq(message, session.history);

    // Aggiungi risposta assistant alla history
    addToHistory(session, 'assistant', result.response);

    res.json({
      response: result.response,
      agent: result.agent,
      sessionId: sid,
      historyLength: session.history.length
    });

  } catch (error) {
    console.error('Agent chat error:', error);
    res.status(500).json({
      error: 'Agent processing failed',
      message: error.message
    });
  }
});

/**
 * POST /api/agent/query
 *
 * Query diretta (alias per /chat)
 */
router.post('/query', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const result = await chatWithGroq(message, []);
    res.json({
      response: result.response,
      agent: result.agent
    });
  } catch (error) {
    console.error('Agent query error:', error);
    res.status(500).json({
      error: 'Agent query failed',
      message: error.message
    });
  }
});

/**
 * GET /api/agent/status
 *
 * Stato del sistema agenti
 */
router.get('/status', (req, res) => {
  const configuredProviders = [];
  for (const [name, envVar] of Object.entries(PROVIDER_KEYS)) {
    if (process.env[envVar]) {
      configuredProviders.push(name);
    }
  }

  res.json({
    status: configuredProviders.length > 0 ? 'ready' : 'no_api_key',
    currentProvider: process.env.AI_PROVIDER || 'groq',
    availableProviders: Object.keys(PROVIDER_KEYS),
    configuredProviders,
    agents: [
      { name: 'NetMap Assistant', role: 'triage', description: 'Smista richieste agli specialisti' },
      { name: 'MAC Tracker', role: 'specialist', description: 'Ricerca MAC address' },
      { name: 'Device Specialist', role: 'specialist', description: 'Info dispositivi' },
      { name: 'Network Discovery', role: 'specialist', description: 'Inventario rete' },
      { name: 'Network Troubleshooter', role: 'specialist', description: 'Diagnosi problemi' }
    ],
    activeSessions: sessions.size,
    implementation: 'groqDirect + openRouter'
  });
});

/**
 * DELETE /api/agent/session/:sessionId
 *
 * Elimina una sessione di chat
 */
router.delete('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const deleted = sessions.delete(sessionId);

  res.json({
    success: deleted,
    message: deleted ? 'Session deleted' : 'Session not found'
  });
});

// ============================================================
// MiMo-V2-Flash Endpoints (via OpenRouter)
// ============================================================

/**
 * POST /api/agent/mimo
 *
 * Query diretta a MiMo-V2-Flash (Xiaomi 309B model)
 * Usa questo per task complessi che richiedono reasoning avanzato.
 *
 * Body:
 *   {
 *     "message": "Analizza questa topologia di rete...",
 *     "includeReasoning": false,  // opzionale: mostra processo di pensiero
 *     "temperature": 0.7,         // opzionale
 *     "maxTokens": 4096           // opzionale
 *   }
 *
 * Response:
 *   {
 *     "response": "...",
 *     "reasoning": null,  // presente se includeReasoning=true
 *     "model": "xiaomi/mimo-v2-flash:free",
 *     "usage": { prompt_tokens, completion_tokens, total_tokens }
 *   }
 */
router.post('/mimo', async (req, res) => {
  try {
    const { message, includeReasoning, temperature, maxTokens, systemPrompt } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await queryMiMo(message, {
      includeReasoning: includeReasoning || false,
      temperature: temperature || 0.7,
      maxTokens: maxTokens || 4096,
      systemPrompt
    });

    res.json({
      response: result.content,
      reasoning: result.reasoning,
      model: result.model,
      provider: result.provider,
      usage: result.usage
    });

  } catch (error) {
    console.error('MiMo query error:', error);

    // Specific error handling
    if (error.message.includes('Rate limit')) {
      return res.status(429).json({
        error: 'Rate limit reached',
        message: error.message,
        hint: 'Acquista $10 di crediti su OpenRouter per 1000 req/giorno'
      });
    }

    if (error.message.includes('API key')) {
      return res.status(500).json({
        error: 'Configuration error',
        message: 'OPENROUTER_API_KEY non configurata'
      });
    }

    res.status(500).json({
      error: 'MiMo query failed',
      message: error.message
    });
  }
});

/**
 * GET /api/agent/mimo/stream
 *
 * Query con streaming a MiMo-V2-Flash (Server-Sent Events)
 *
 * Query params:
 *   ?message=<encoded message>
 *   &temperature=0.7 (optional)
 *
 * Response: SSE stream
 */
router.get('/mimo/stream', async (req, res) => {
  const { message, temperature } = req.query;

  if (!message) {
    return res.status(400).json({ error: 'Message query param is required' });
  }

  // Setup SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    await queryMiMoStream(
      decodeURIComponent(message),
      (chunk) => {
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      },
      { temperature: parseFloat(temperature) || 0.7 }
    );

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/agent/mimo/status
 *
 * Stato del servizio MiMo (API key, limiti, usage)
 */
router.get('/mimo/status', async (req, res) => {
  try {
    const status = await checkApiStatus();

    res.json({
      service: 'MiMo-V2-Flash',
      provider: 'OpenRouter',
      model: 'xiaomi/mimo-v2-flash:free',
      contextWindow: '256K tokens',
      maxOutput: '65K tokens',
      ...status
    });

  } catch (error) {
    res.status(500).json({
      error: 'Status check failed',
      message: error.message
    });
  }
});

export default router;
