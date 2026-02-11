/**
 * MAC Address Utilities
 * Centralized functions for MAC address normalization, validation, and formatting.
 * Replaces 15+ duplicate implementations across the codebase.
 */

/**
 * Normalize a MAC address to lowercase hex without separators.
 * Handles all common formats: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff, aabb-ccdd-eeff
 * @param {string} mac - MAC address in any format
 * @returns {string|null} - 12-char lowercase hex string, or null if invalid
 */
export function normalizeMac(mac) {
  if (!mac || typeof mac !== 'string') return null;
  const clean = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return clean.length === 12 ? clean : null;
}

/**
 * Check if a MAC address is valid.
 * @param {string} mac - MAC address in any format
 * @returns {boolean} - true if valid MAC address
 */
export function isValidMac(mac) {
  return normalizeMac(mac) !== null;
}

/**
 * Format a MAC address with specified separator.
 * @param {string} mac - MAC address in any format
 * @param {string} separator - Separator to use (default: ':')
 * @param {number} groupSize - Number of chars per group (default: 2)
 * @returns {string|null} - Formatted MAC address, or null if invalid
 * @example formatMac('aabbccddeeff') => 'aa:bb:cc:dd:ee:ff'
 * @example formatMac('aabbccddeeff', '-') => 'aa-bb-cc-dd-ee-ff'
 * @example formatMac('aabbccddeeff', '.', 4) => 'aabb.ccdd.eeff'
 * @example formatMac('aabbccddeeff', '-', 4) => 'aabb-ccdd-eeff' (Huawei format)
 */
export function formatMac(mac, separator = ':', groupSize = 2) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;

  const regex = new RegExp(`.{1,${groupSize}}`, 'g');
  return normalized.match(regex).join(separator);
}

/**
 * Format MAC in standard colon-separated format (aa:bb:cc:dd:ee:ff)
 * @param {string} mac - MAC address in any format
 * @returns {string|null} - Formatted MAC address, or null if invalid
 */
export function formatMacColon(mac) {
  return formatMac(mac, ':', 2);
}

/**
 * Format MAC in Huawei format (aabb-ccdd-eeff)
 * @param {string} mac - MAC address in any format
 * @returns {string|null} - Formatted MAC address, or null if invalid
 */
export function formatMacHuawei(mac) {
  return formatMac(mac, '-', 4);
}

/**
 * Format MAC in Cisco format (aabb.ccdd.eeff)
 * @param {string} mac - MAC address in any format
 * @returns {string|null} - Formatted MAC address, or null if invalid
 */
export function formatMacCisco(mac) {
  return formatMac(mac, '.', 4);
}

/**
 * Compare two MAC addresses for equality (format-independent).
 * @param {string} mac1 - First MAC address
 * @param {string} mac2 - Second MAC address
 * @returns {boolean} - true if MACs are equal
 */
export function compareMac(mac1, mac2) {
  const n1 = normalizeMac(mac1);
  const n2 = normalizeMac(mac2);
  return n1 !== null && n2 !== null && n1 === n2;
}

/**
 * Extract OUI (first 6 hex chars) from MAC address.
 * @param {string} mac - MAC address in any format
 * @returns {string|null} - 6-char lowercase OUI, or null if invalid
 */
export function extractOui(mac) {
  const normalized = normalizeMac(mac);
  return normalized ? normalized.substring(0, 6) : null;
}

/**
 * Check if MAC is a broadcast address (ff:ff:ff:ff:ff:ff).
 * @param {string} mac - MAC address in any format
 * @returns {boolean}
 */
export function isBroadcast(mac) {
  return normalizeMac(mac) === 'ffffffffffff';
}

/**
 * Check if MAC is a multicast address (first byte has LSB set).
 * @param {string} mac - MAC address in any format
 * @returns {boolean}
 */
export function isMulticast(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return false;
  const firstByte = parseInt(normalized.substring(0, 2), 16);
  return (firstByte & 0x01) === 1;
}

/**
 * Check if MAC is a unicast address (not broadcast or multicast).
 * @param {string} mac - MAC address in any format
 * @returns {boolean}
 */
export function isUnicast(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return false;
  return !isBroadcast(mac) && !isMulticast(mac);
}

/**
 * Create a SQL LIKE pattern for MAC search.
 * @param {string} mac - MAC address (can be partial)
 * @returns {string} - SQL LIKE pattern with wildcards
 */
export function createMacSearchPattern(mac) {
  if (!mac || typeof mac !== 'string') return '%';
  const clean = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return `%${clean}%`;
}

/**
 * Parse MAC address from various string formats, being lenient.
 * Useful for user input that might have extra characters.
 * @param {string} input - User input containing MAC address
 * @returns {string|null} - Normalized MAC or null if not found
 */
export function parseMacFromInput(input) {
  if (!input || typeof input !== 'string') return null;

  // Try to extract hex characters
  const hexChars = input.replace(/[^0-9a-fA-F]/g, '').toLowerCase();

  // If we got exactly 12 hex chars, it's a valid MAC
  if (hexChars.length === 12) {
    return hexChars;
  }

  // If we got more than 12, try to find a MAC within
  if (hexChars.length > 12) {
    // Take first 12 hex chars
    return hexChars.substring(0, 12);
  }

  return null;
}

export default {
  normalizeMac,
  isValidMac,
  formatMac,
  formatMacColon,
  formatMacHuawei,
  formatMacCisco,
  compareMac,
  extractOui,
  isBroadcast,
  isMulticast,
  isUnicast,
  createMacSearchPattern,
  parseMacFromInput
};
