/**
 * Vendor Parser Registry
 *
 * Gestisce registrazione e lookup dei parser vendor-specific.
 * Supporta lookup per:
 * - Vendor ID (es. 'huawei')
 * - Vendor Name (es. 'Huawei', case-insensitive)
 * - Enterprise ID SNMP (es. '2011')
 */

import HuaweiParser from './HuaweiParser.js';
import CiscoParser from './CiscoParser.js';
import AristaParser from './AristaParser.js';
import JuniperParser from './JuniperParser.js';

// ============================================
// Registry
// ============================================

/**
 * Lista di tutti i parser registrati
 * Aggiungere nuovi parser qui
 */
const PARSERS = [
  HuaweiParser,
  CiscoParser,
  AristaParser,
  JuniperParser
];

// Cache per lookup veloci (popolate all'import)
const parserByVendorId = new Map();
const parserByEnterprise = new Map();
const parserByVendorName = new Map();

// Popola cache
for (const Parser of PARSERS) {
  // By vendor ID
  parserByVendorId.set(Parser.vendorId, Parser);

  // By enterprise ID (può essere multiplo)
  for (const id of Parser.enterpriseIds) {
    parserByEnterprise.set(id, Parser);
  }

  // By vendor name (case-insensitive)
  for (const name of Parser.vendorNames) {
    parserByVendorName.set(name.toLowerCase(), Parser);
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Ottiene classe parser dal vendor name
 * @param {string} vendorName - Nome vendor (es. 'Huawei', 'cisco')
 * @returns {typeof VendorParser|null} Classe parser o null
 *
 * @example
 * const Parser = getParserByVendor('Huawei');
 * const parser = new Parser();
 * const neighbors = parser.parseLldpOutput(output);
 */
export function getParserByVendor(vendorName) {
  if (!vendorName) return null;
  return parserByVendorName.get(vendorName.toLowerCase()) || null;
}

/**
 * Ottiene classe parser dall'Enterprise ID SNMP
 * L'Enterprise ID è estratto da sysObjectID: 1.3.6.1.4.1.<enterpriseId>...
 *
 * @param {string|number} enterpriseId - Enterprise ID (es. '2011', 9)
 * @returns {typeof VendorParser|null} Classe parser o null
 *
 * @example
 * const enterpriseId = extractEnterpriseId('1.3.6.1.4.1.2011.2.23.69');
 * const Parser = getParserByEnterpriseId(enterpriseId); // HuaweiParser
 */
export function getParserByEnterpriseId(enterpriseId) {
  if (!enterpriseId) return null;
  return parserByEnterprise.get(String(enterpriseId)) || null;
}

/**
 * Ottiene classe parser dal vendor ID
 * @param {string} vendorId - Vendor ID (es. 'huawei', 'cisco')
 * @returns {typeof VendorParser|null} Classe parser o null
 */
export function getParserByVendorId(vendorId) {
  if (!vendorId) return null;
  return parserByVendorId.get(vendorId.toLowerCase()) || null;
}

/**
 * Crea istanza parser per un device
 * Prova in ordine: vendor name, enterprise ID da sysObjectID
 *
 * @param {Object} device - Device object dal database
 * @param {string} [device.vendor] - Vendor name
 * @param {string} [device.sysobjectid] - SNMP sysObjectID
 * @returns {VendorParser|null} Istanza parser o null
 *
 * @example
 * const parser = createParserForDevice({ vendor: 'Huawei', ip: '10.0.0.1' });
 * if (parser && parser.constructor.isImplemented) {
 *   const neighbors = parser.parseLldpOutput(output);
 * }
 */
export function createParserForDevice(device) {
  if (!device) return null;

  // Priorità 1: vendor name
  if (device.vendor) {
    const Parser = getParserByVendor(device.vendor);
    if (Parser) return new Parser();
  }

  // Priorità 2: enterprise ID da sysObjectID
  if (device.sysobjectid) {
    const enterpriseId = extractEnterpriseId(device.sysobjectid);
    if (enterpriseId) {
      const Parser = getParserByEnterpriseId(enterpriseId);
      if (Parser) return new Parser();
    }
  }

  return null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Estrae Enterprise ID da sysObjectID OID
 * @param {string} sysObjectId - OID completo (es. '1.3.6.1.4.1.2011.2.23.69')
 * @returns {string|null} Enterprise ID (es. '2011') o null
 *
 * @example
 * extractEnterpriseId('1.3.6.1.4.1.2011.2.23.69'); // '2011'
 * extractEnterpriseId('1.3.6.1.4.1.9.1.516');      // '9'
 */
export function extractEnterpriseId(sysObjectId) {
  if (!sysObjectId) return null;

  // Pattern: 1.3.6.1.4.1.<enterpriseId>...
  const match = sysObjectId.match(/^1\.3\.6\.1\.4\.1\.(\d+)/);
  return match ? match[1] : null;
}

/**
 * Lista tutti i vendor supportati
 * @returns {VendorInfo[]} Array di informazioni vendor
 *
 * @example
 * const vendors = getSupportedVendors();
 * // [
 * //   { id: 'huawei', names: ['Huawei', 'H3C'], enterpriseIds: ['2011', '25506'], implemented: true },
 * //   { id: 'cisco', names: ['Cisco'], enterpriseIds: ['9'], implemented: false },
 * //   ...
 * // ]
 */
export function getSupportedVendors() {
  return PARSERS.map(Parser => ({
    id: Parser.vendorId,
    names: Parser.vendorNames,
    enterpriseIds: Parser.enterpriseIds,
    implemented: Parser.isImplemented
  }));
}

/**
 * Verifica se un vendor è supportato (anche come stub)
 * @param {string} vendorName - Nome vendor
 * @returns {boolean}
 */
export function isVendorSupported(vendorName) {
  return getParserByVendor(vendorName) !== null;
}

/**
 * Verifica se un vendor ha parser completamente implementato
 * @param {string} vendorName - Nome vendor
 * @returns {boolean}
 */
export function isVendorImplemented(vendorName) {
  const Parser = getParserByVendor(vendorName);
  return Parser?.isImplemented === true;
}

// ============================================
// Exports
// ============================================

// Re-export parser classes per uso diretto
export { default as VendorParser } from './VendorParser.js';
export { default as HuaweiParser } from './HuaweiParser.js';
export { default as CiscoParser } from './CiscoParser.js';
export { default as AristaParser } from './AristaParser.js';
export { default as JuniperParser } from './JuniperParser.js';

/**
 * @typedef {Object} VendorInfo
 * @property {string} id - Vendor ID univoco
 * @property {string[]} names - Nomi alternativi
 * @property {string[]} enterpriseIds - Enterprise ID SNMP
 * @property {boolean} implemented - Se parser è completo
 */
