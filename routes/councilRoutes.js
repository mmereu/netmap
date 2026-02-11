/**
 * Council API Routes v3.0
 *
 * Endpoints per il sistema LLM Council multi-modello
 *
 * POST /api/council/chat     - Chat con consenso multi-provider
 * POST /api/council/query    - Query diretta al council
 * GET  /api/council/status   - Stato del council e provider
 * POST /api/council/test     - Test tutti i provider
 * GET  /api/council/metrics  - Metriche dettagliate
 * GET  /api/council/leaderboard - Provider ranking
 * GET  /api/council/cache/stats - Statistiche cache
 * POST /api/council/cache/clear - Pulisci cache
 * GET  /api/council/circuits - Stato circuit breakers
 * POST /api/council/ssh/execute - Esegui comando SSH
 */

import { Router } from 'express';

// Try to import v3 first, fallback to v2
let councilModule;
let isV3 = false;
try {
  councilModule = await import('../agents/llmCouncilV3.js');
  isV3 = true;
  console.log('[Council Routes] Loaded LLM Council v3.0');
} catch (err) {
  councilModule = await import('../agents/llmCouncil.js');
  console.log('[Council Routes] Loaded LLM Council v2.x (v3 not available)');
}

const {
  queryCouncil,
  queryCouncilWithTools,
  getCouncilStatus,
  initializeCouncil,
  healthCheck,
  COUNCIL_TYPES
} = councilModule;

// Alias for backwards compatibility
const councilQuery = queryCouncil;

// Import v3 modules (optional)
let cacheModule, circuitModule, metricsModule, sshModule, warmupModule;
try {
  cacheModule = await import('../lib/councilCache.js');
  circuitModule = await import('../lib/circuitBreaker.js');
  metricsModule = await import('../lib/councilMetrics.js');
  sshModule = await import('../lib/sshDiagnosticExecutor.js');
  warmupModule = await import('../lib/ollamaWarmup.js');
} catch (err) {
  console.log('[Council Routes] V3 modules not fully available:', err.message);
}

const router = Router();

/**
 * POST /api/council/chat
 *
 * Chat con il sistema Council. Interroga multipli LLM e trova consenso.
 *
 * Body:
 *   {
 *     "message": "Domanda...",
 *     "type": "full" | "fast" | "adaptive",
 *     "minConfidence": 0.6
 *   }
 *
 * Response:
 *   {
 *     "response": "Risposta consensuale...",
 *     "confidence": 0.85,
 *     "responseType": "consensus" | "low-consensus" | "divergent",
 *     "providers": { queried: 3, successful: 3, details: [...] },
 *     "elapsed": 1234
 *   }
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, type, minConfidence } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const options = {};
    if (type && Object.values(COUNCIL_TYPES).includes(type)) {
      options.type = type;
    }
    if (typeof minConfidence === 'number') {
      options.minConfidence = minConfidence;
    }

    console.log(`[Council API] Chat request: type=${options.type || 'full'}`);

    const result = await councilQuery(message, options);

    res.json({
      response: result.response,
      confidence: result.confidence,
      responseType: result.responseType,
      councilType: result.councilType,
      providers: result.providers,
      elapsed: result.elapsed
    });

  } catch (error) {
    console.error('Council chat error:', error);
    res.status(500).json({
      error: 'Council processing failed',
      message: error.message
    });
  }
});

/**
 * POST /api/council/query
 *
 * Query diretta (alias per /chat con più opzioni debug)
 */
router.post('/query', async (req, res) => {
  try {
    const { message, type, minConfidence, debug } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const options = {
      type: type || COUNCIL_TYPES.FULL,
      minConfidence: minConfidence || 0.6
    };

    const result = await councilQuery(message, options);

    const response = {
      response: result.response,
      confidence: result.confidence,
      responseType: result.responseType,
      councilType: result.councilType,
      providers: result.providers,
      elapsed: result.elapsed
    };

    // Include debug info if requested
    if (debug) {
      response.debug = result.debug;
    }

    res.json(response);

  } catch (error) {
    console.error('Council query error:', error);
    res.status(500).json({
      error: 'Council query failed',
      message: error.message
    });
  }
});

/**
 * GET /api/council/status
 *
 * Stato del council: provider configurati, disponibilità
 */
router.get('/status', (req, res) => {
  try {
    const status = getCouncilStatus();

    res.json({
      status: status.available > 0 ? 'operational' : 'no_providers',
      councilTypes: Object.values(COUNCIL_TYPES),
      ...status
    });

  } catch (error) {
    console.error('Council status error:', error);
    res.status(500).json({
      error: 'Failed to get council status',
      message: error.message
    });
  }
});

/**
 * POST /api/council/test
 *
 * Testa tutti i provider del council
 */
router.post('/test', async (req, res) => {
  try {
    console.log('[Council API] Running provider tests...');

    const results = await testCouncil();

    const successCount = Object.values(results).filter(r => r.success).length;
    const totalCount = Object.keys(results).length;

    res.json({
      status: successCount === totalCount ? 'all_pass' : 'partial',
      summary: `${successCount}/${totalCount} providers operational`,
      results
    });

  } catch (error) {
    console.error('Council test error:', error);
    res.status(500).json({
      error: 'Council test failed',
      message: error.message
    });
  }
});

// =============================================================================
// V3 ENDPOINTS - Metrics, Cache, Circuit Breakers, SSH
// =============================================================================

/**
 * GET /api/council/metrics
 * Get all metrics (v3 only)
 */
router.get('/metrics', (req, res) => {
  if (!metricsModule) {
    return res.status(501).json({ error: 'Metrics not available in this version' });
  }
  try {
    const metrics = metricsModule.getMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/metrics/summary
 * Get metrics summary
 */
router.get('/metrics/summary', (req, res) => {
  if (!metricsModule) {
    return res.status(501).json({ error: 'Metrics not available' });
  }
  try {
    res.json(metricsModule.getMetricsSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/council/metrics/reset
 * Reset metrics
 */
router.post('/metrics/reset', (req, res) => {
  if (!metricsModule) {
    return res.status(501).json({ error: 'Metrics not available' });
  }
  try {
    res.json(metricsModule.resetMetrics());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/leaderboard
 * Provider leaderboard
 */
router.get('/leaderboard', (req, res) => {
  if (!metricsModule) {
    return res.status(501).json({ error: 'Metrics not available' });
  }
  try {
    res.json(metricsModule.getProviderLeaderboard());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/cache/stats
 * Cache statistics
 */
router.get('/cache/stats', (req, res) => {
  if (!cacheModule) {
    return res.status(501).json({ error: 'Cache not available' });
  }
  try {
    res.json(cacheModule.getCacheStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/council/cache/clear
 * Clear cache
 */
router.post('/cache/clear', (req, res) => {
  if (!cacheModule) {
    return res.status(501).json({ error: 'Cache not available' });
  }
  try {
    res.json(cacheModule.clearCache());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/circuits
 * Circuit breaker states
 */
router.get('/circuits', (req, res) => {
  if (!circuitModule) {
    return res.status(501).json({ error: 'Circuit breakers not available' });
  }
  try {
    res.json(circuitModule.getAllCircuitStates());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/council/circuits/:provider/reset
 * Reset specific circuit
 */
router.post('/circuits/:provider/reset', (req, res) => {
  if (!circuitModule) {
    return res.status(501).json({ error: 'Circuit breakers not available' });
  }
  try {
    res.json(circuitModule.resetCircuit(req.params.provider));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/warmup/status
 * Warmup status
 */
router.get('/warmup/status', (req, res) => {
  if (!warmupModule) {
    return res.status(501).json({ error: 'Warmup not available' });
  }
  try {
    res.json(warmupModule.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/council/ssh/execute
 * Execute SSH diagnostic command
 */
router.post('/ssh/execute', async (req, res) => {
  if (!sshModule) {
    return res.status(501).json({ error: 'SSH executor not available' });
  }
  try {
    const { device, command } = req.body;
    if (!device || !command) {
      return res.status(400).json({ error: 'Device and command required' });
    }
    const result = await sshModule.executeCommand(device, command);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/ssh/history
 * SSH execution history
 */
router.get('/ssh/history', (req, res) => {
  if (!sshModule) {
    return res.status(501).json({ error: 'SSH executor not available' });
  }
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(sshModule.getExecutionHistory(limit));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/ssh/stats
 * SSH execution stats
 */
router.get('/ssh/stats', (req, res) => {
  if (!sshModule) {
    return res.status(501).json({ error: 'SSH executor not available' });
  }
  try {
    res.json(sshModule.getExecutionStats());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/council/health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    if (healthCheck) {
      const health = await healthCheck();
      res.status(health.healthy ? 200 : 503).json(health);
    } else {
      res.json({ healthy: true, version: isV3 ? '3.0' : '2.x' });
    }
  } catch (error) {
    res.status(503).json({ healthy: false, error: error.message });
  }
});

/**
 * POST /api/council/initialize
 * Initialize council
 */
router.post('/initialize', async (req, res) => {
  try {
    if (initializeCouncil) {
      const result = await initializeCouncil();
      res.json({ success: true, ...result });
    } else {
      res.json({ success: true, message: 'Initialize not required for this version' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
