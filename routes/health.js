/**
 * Health & Utility Routes
 *
 * Endpoints for health checks, debugging, and utility operations.
 * These are simple, stateless endpoints that don't require database access.
 */

import { Router } from 'express';

const router = Router();

/**
 * GET /api/health
 * Health check endpoint for monitoring and load balancers
 */
router.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

/**
 * GET /api/debug/info
 * Debug information (development only)
 */
router.get('/api/debug/info', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT
    }
  });
});

export default router;
