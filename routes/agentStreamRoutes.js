import { Router } from 'express';
import { chatWithGroq } from '../agents/groqDirect.js';
import fs from 'fs';

const router = Router();

// Sessioni di chat in-memory con history (condivisa con agentRoutes)
// Struttura: Map<sessionId, { history: Message[], lastAccess: number }>
const sessions = new Map();

const SESSION_CONFIG = {
  maxHistory: 10,
  maxAge: 3600000
};

function getOrCreateSession(sessionId) {
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { history: [], lastAccess: Date.now() });
  }
  const session = sessions.get(sessionId);
  session.lastAccess = Date.now();
  return { sessionId, session };
}

function addToHistory(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > SESSION_CONFIG.maxHistory) {
    session.history = session.history.slice(-SESSION_CONFIG.maxHistory);
  }
}

function logDebug(msg) {
  try {
    fs.appendFileSync('/tmp/debug_agent.log', new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

/**
 * POST /api/agent/stream
 * 
 * Endpoint SSE (Server-Sent Events) per chat con feedback in tempo reale.
 * Permette al frontend di mostrare lo stato di avanzamento ("Thinking...", "Scanning switch...", etc.)
 * utile per operazioni lunghe come le trace SSH.
 */
router.post('/stream', async (req, res) => {
  logDebug('Request received');

  // Track connection state
  let clientConnected = true;
  let abortController = new AbortController();

  // SECURITY FIX: Handle client disconnect to prevent resource leaks
  // IMPORTANT: Use res.on('close') not req.on('close') for SSE!
  // req.on('close') fires when POST body is received, not when client disconnects from stream
  res.on('close', () => {
    logDebug('Response closed (client disconnected)');
    clientConnected = false;
    abortController.abort();
  });

  res.on('error', (err) => {
    logDebug('Response error: ' + err.message);
    clientConnected = false;
    abortController.abort();
  });

  // Helper per scrittura sicura (verifica che client sia ancora connesso)
  const safeWrite = (data) => {
    if (clientConnected && res.writable) {
      try {
        res.write(data);
        return true;
      } catch (e) {
        logDebug('Write error: ' + e.message);
        clientConnected = false;
        return false;
      }
    }
    return false;
  };

  // SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Importante per Nginx/Reverse Proxy
  });

  const { message, sessionId } = req.body;

  if (!message) {
    safeWrite(`data: ${JSON.stringify({ type: 'error', message: 'Message is required' })}\n\n`);
    res.end();
    return;
  }

  // Ottieni o crea sessione con history
  const { sessionId: sid, session } = getOrCreateSession(sessionId);

  // Aggiungi messaggio utente alla history
  addToHistory(session, 'user', message);

  // Send initial session info
  safeWrite(`data: ${JSON.stringify({ type: 'session', sessionId: sid })}\n\n`);

  try {
    // Esegui chat CON history per contesto multi-turn
    const result = await chatWithGroq(message, session.history, (progress) => {
      // Invia eventi di progresso al client (se ancora connesso)
      if (!clientConnected) {
        throw new Error('Client disconnected');
      }
      safeWrite(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
    });

    // Aggiungi risposta assistant alla history
    addToHistory(session, 'assistant', result.response);

    // Invia risultato finale (se client ancora connesso)
    if (clientConnected) {
      safeWrite(`data: ${JSON.stringify({
        type: 'complete',
        response: result.response,
        agent: result.agent,
        provider: result.provider,
        model: result.model,
        historyLength: session.history.length
      })}\n\n`);
    }

  } catch (error) {
    // Non loggare errori di client disconnesso come errori
    if (error.message === 'Client disconnected' || !clientConnected) {
      logDebug('Request aborted: client disconnected');
    } else {
      console.error('Stream Error:', error);
      logDebug('Error: ' + error.message + '\n' + error.stack);
      safeWrite(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    }
  } finally {
    logDebug('End request');
    if (res.writable) {
      res.end();
    }
  }
});

export default router;
