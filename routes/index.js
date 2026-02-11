/**
 * Routes Index
 *
 * Centralized route registration for NetMap API.
 * Routes are organized by domain for better maintainability.
 *
 * Migration Strategy:
 * 1. New routes should be added to domain-specific modules
 * 2. Existing routes can be migrated gradually
 * 3. Each module exports a router that can be mounted in server.js
 *
 * Usage in server.js:
 *   import { registerRoutes } from './routes/index.js';
 *   registerRoutes(app, { db, nedi });
 */

import { Router } from 'express';

// Import route modules as they are created
import healthRoutes from './health.js';
import reportsRoutes from './reports.js';

/**
 * Route module registry
 * Add new route modules here as they are extracted from server.js
 */
const routeModules = [
  { path: '/', module: healthRoutes, name: 'health' },
  { path: '/api/reports', module: reportsRoutes, name: 'reports' }
];

/**
 * Register all route modules on the Express app
 * @param {Express} app - Express application
 * @param {Object} context - Shared context (db, nedi, etc.)
 */
export function registerRoutes(app, context = {}) {
  const registeredRoutes = [];

  for (const { path, module, name } of routeModules) {
    try {
      // Create router if module exports a factory function
      const router = typeof module === 'function' ? module(context) : module;

      app.use(path, router);
      registeredRoutes.push({ name, path, status: 'ok' });
    } catch (err) {
      console.error(`[Routes] Failed to register ${name}:`, err.message);
      registeredRoutes.push({ name, path, status: 'error', error: err.message });
    }
  }

  return registeredRoutes;
}

/**
 * Create a route module with shared context
 * Helper for creating route modules that need access to db, nedi, etc.
 *
 * @param {Function} setupFn - Function that receives context and returns router
 * @returns {Function} - Factory function for the route module
 *
 * @example
 * // In routes/devices.js:
 * export default createRouteModule((context) => {
 *   const router = Router();
 *   const { db } = context;
 *
 *   router.get('/', (req, res) => {
 *     const devices = db.getAllDevices();
 *     res.json(devices);
 *   });
 *
 *   return router;
 * });
 */
export function createRouteModule(setupFn) {
  return setupFn;
}

/**
 * Get list of available route modules
 */
export function getRouteModules() {
  return routeModules.map(({ path, name }) => ({ path, name }));
}

export default {
  registerRoutes,
  createRouteModule,
  getRouteModules
};
