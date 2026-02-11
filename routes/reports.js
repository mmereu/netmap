/**
 * Reports Routes
 *
 * Endpoints for generating reports on network data.
 * Requires database context for data access.
 */

import { Router } from 'express';
import { createRouteModule } from './index.js';

/**
 * Create reports router with database context
 * @param {Object} context - Shared context
 * @param {Object} context.db - Database instance
 * @returns {Router} - Express router
 */
export default createRouteModule((context) => {
  const router = Router();
  const { db } = context;

  /**
   * GET /api/reports/summary
   * Get a summary of network statistics
   */
  router.get('/summary', (req, res) => {
    try {
      const summary = {
        devices: {
          total: db?.getDevicesCount?.() || 0,
          up: db?.getDevicesByStatus?.('up')?.length || 0,
          down: db?.getDevicesByStatus?.('down')?.length || 0
        },
        links: {
          total: db?.getLinksCount?.() || 0
        },
        lastUpdated: new Date().toISOString()
      };

      res.json(summary);
    } catch (err) {
      console.error('[Reports] Summary error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/reports/port-usage
   * Get port usage statistics across all devices
   * Note: This is a placeholder - actual implementation is in server.js
   */
  router.get('/port-usage-new', (req, res) => {
    try {
      // Placeholder - actual implementation to be migrated from server.js
      res.json({
        message: 'Port usage report - migrated endpoint',
        note: 'Full implementation pending migration from server.js'
      });
    } catch (err) {
      console.error('[Reports] Port usage error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
});
