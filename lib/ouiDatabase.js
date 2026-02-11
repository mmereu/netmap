/**
 * OUI (Organizationally Unique Identifier) Database Module
 * Provides vendor lookup by MAC address using IEEE OUI Registry data.
 *
 * @module ouiDatabase
 *
 * ## Data Source
 * - Registry: IEEE OUI Registry (https://standards-oui.ieee.org/oui/oui.csv)
 * - Generated: 2025-12-07
 * - Total entries: 38,504
 *
 * ## Lazy Loading
 * The OUI database (~1.4MB, 38,504 entries) is NOT loaded at module import time.
 * Instead, it is loaded from `ouiData.json` on first use, providing:
 * - Faster server startup when OUI lookups are not needed
 * - Reduced memory footprint when feature is unused
 * - Thread-safe concurrent access during initialization
 *
 * ## API Changes (Breaking)
 * - `lookupOui()` is now async and returns a Promise
 * - Callers must use `await lookupOui(mac)` instead of `lookupOui(mac)`
 * - `OUI_DATABASE` export removed; use `getOuiDatabase()` instead
 *
 * ## Usage Examples
 * ```javascript
 * import { lookupOui, preloadDatabase, isDatabaseLoaded } from './ouiDatabase.js';
 *
 * // Basic lookup (lazy loads on first call)
 * const result = await lookupOui('00:00:0c:ab:cd:ef');
 * // { oui: '00:00:0C', vendor: 'Cisco Systems, Inc', found: true }
 *
 * // Optional: Preload at server startup to avoid first-request latency
 * await preloadDatabase();
 *
 * // Check if already loaded
 * if (isDatabaseLoaded()) { ... }
 * ```
 *
 * @exports lookupOui - Async function to lookup vendor by MAC/OUI
 * @exports preloadDatabase - Async function to preload database early
 * @exports isDatabaseLoaded - Sync function to check if loaded
 * @exports getOuiDatabase - Async function to get raw database object
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Module-level cache for the OUI database
let ouiDatabase = null;

// Loading promise for thread-safe initialization
let loadingPromise = null;

/**
 * Get the path to the ouiData.json file.
 * @private
 * @returns {string} Absolute path to ouiData.json
 */
function getDataFilePath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, 'ouiData.json');
}

/**
 * Load the OUI database from the JSON file.
 *
 * This function is thread-safe: concurrent calls will share the same loading
 * promise, ensuring the database is loaded exactly once even with parallel requests.
 *
 * @private
 * @async
 * @returns {Promise<Object<string, string>>} The loaded OUI database (OUI -> vendor name)
 * @throws {Error} If the JSON file cannot be read or parsed
 */
async function loadDatabase() {
  // Return cached database if already loaded
  if (ouiDatabase !== null) {
    return ouiDatabase;
  }

  // If already loading, return the existing promise
  if (loadingPromise !== null) {
    return loadingPromise;
  }

  // Start loading and cache the promise
  loadingPromise = (async () => {
    try {
      const dataPath = getDataFilePath();
      const jsonData = await readFile(dataPath, 'utf-8');
      ouiDatabase = JSON.parse(jsonData);
      return ouiDatabase;
    } catch (error) {
      // Reset loading promise on error so retry is possible
      loadingPromise = null;
      throw new Error(`Failed to load OUI database: ${error.message}`);
    }
  })();

  return loadingPromise;
}

/**
 * Preload the OUI database before first use.
 *
 * Call this at server startup if you want to avoid first-request latency.
 * Subsequent calls are no-ops if the database is already loaded.
 *
 * @async
 * @returns {Promise<void>} Resolves when database is loaded
 * @throws {Error} If the database file cannot be read or parsed
 * @example
 * // In server.js startup
 * import { preloadDatabase } from './lib/ouiDatabase.js';
 * await preloadDatabase();
 * console.log('OUI database ready');
 */
async function preloadDatabase() {
  await loadDatabase();
}

/**
 * Check if the OUI database is currently loaded in memory.
 *
 * Use this to check loading status without triggering a load.
 *
 * @returns {boolean} True if database is already loaded, false otherwise
 * @example
 * if (!isDatabaseLoaded()) {
 *   console.log('OUI database not yet loaded');
 * }
 */
function isDatabaseLoaded() {
  return ouiDatabase !== null;
}

/**
 * Lookup vendor by MAC address or OUI prefix.
 *
 * This is the main function for OUI lookups. It automatically loads the database
 * on first call (lazy loading) and caches it for subsequent calls.
 *
 * **Note:** This function is async and must be awaited. This is a breaking change
 * from the previous synchronous version.
 *
 * @async
 * @param {string} mac - MAC address or OUI prefix. Accepts various formats:
 *   - Full MAC: '00:00:0c:ab:cd:ef', '00-00-0c-ab-cd-ef', '00000cabcdef'
 *   - OUI only: '00:00:0c', '00000c'
 *   - Case insensitive: '00:00:0C' or '00:00:0c'
 * @returns {Promise<{oui: string, vendor: string, found: boolean}>} Lookup result:
 *   - `oui`: Formatted OUI string (e.g., '00:00:0C')
 *   - `vendor`: Vendor name or 'Unknown Vendor' or 'Invalid OUI'
 *   - `found`: true if vendor was found in database
 * @throws {Error} If database cannot be loaded
 * @example
 * // Lookup by full MAC address
 * const result = await lookupOui('00:00:0c:ab:cd:ef');
 * // { oui: '00:00:0C', vendor: 'Cisco Systems, Inc', found: true }
 *
 * @example
 * // Lookup by OUI prefix
 * const result = await lookupOui('00000c');
 * // { oui: '00:00:0C', vendor: 'Cisco Systems, Inc', found: true }
 *
 * @example
 * // Unknown OUI
 * const result = await lookupOui('ffffff');
 * // { oui: 'FF:FF:FF', vendor: 'Unknown Vendor', found: false }
 *
 * @example
 * // Invalid input (less than 6 hex chars)
 * const result = await lookupOui('00:00');
 * // { oui: '0000', vendor: 'Invalid OUI', found: false }
 */
async function lookupOui(mac) {
  // Ensure database is loaded
  const db = await loadDatabase();

  const cleanOui = mac.replace(/[^0-9a-f]/gi, '').toLowerCase().substring(0, 6);

  if (cleanOui.length < 6) {
    return { oui: cleanOui, vendor: 'Invalid OUI', found: false };
  }

  const vendor = db[cleanOui] || 'Unknown Vendor';
  const formattedOui = cleanOui.match(/.{2}/g).join(':').toUpperCase();

  return {
    oui: formattedOui,
    vendor: vendor,
    found: vendor !== 'Unknown Vendor'
  };
}

/**
 * Get the raw OUI database object (lazy-loaded).
 *
 * Returns the complete OUI database as an object mapping 6-character lowercase
 * OUI strings to vendor names. Prefer using `lookupOui()` for individual lookups.
 *
 * This replaces the previous `OUI_DATABASE` direct export, which is no longer
 * available due to lazy loading.
 *
 * @async
 * @returns {Promise<Object<string, string>>} OUI database object mapping OUI -> vendor name
 * @throws {Error} If database cannot be loaded
 * @example
 * const db = await getOuiDatabase();
 * console.log(Object.keys(db).length); // 38504
 * console.log(db['00000c']); // 'Cisco Systems, Inc'
 */
async function getOuiDatabase() {
  return await loadDatabase();
}

export { lookupOui, preloadDatabase, isDatabaseLoaded, getOuiDatabase };
