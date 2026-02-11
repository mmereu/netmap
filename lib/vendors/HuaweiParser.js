/**
 * HuaweiParser - Parser LLDP per switch Huawei (VRP) e H3C (Comware)
 *
 * Questo parser wrappa le funzioni esistenti in huaweiLldpParser.js
 * per mantenere retrocompatibilità e riutilizzare codice testato.
 */

import VendorParser from './VendorParser.js';
import {
  parseHuaweiLldpNeighbors,
  normalizeInterfaceName as huaweiNormalizeInterface,
  convertToNeDiLinks
} from '../huaweiLldpParser.js';

export default class HuaweiParser extends VendorParser {
  // ============================================
  // Identificazione
  // ============================================

  static vendorId = 'huawei';
  static vendorNames = ['Huawei', 'H3C', 'HuaweiTech'];
  static enterpriseIds = ['2011', '25506'];  // 2011=Huawei, 25506=H3C
  static isImplemented = true;

  // ============================================
  // Comandi SSH
  // ============================================

  getLldpCommand() {
    return 'display lldp neighbor';
  }

  getLldpDetailCommand() {
    return 'display lldp neighbor brief';
  }

  getCdpCommand() {
    // Huawei non supporta CDP nativamente
    return null;
  }

  getDisablePagingCommand() {
    return 'screen-length 0 temporary';
  }

  getPromptPattern() {
    // Huawei: <hostname> o [hostname]
    return /<[\w\-_]+>|\[[\w\-_]+\]/;
  }

  // ============================================
  // Parsing - delega al parser esistente
  // ============================================

  /**
   * Parsa output LLDP Huawei usando il parser esistente
   * @param {string} output - Output del comando 'display lldp neighbor'
   * @returns {NormalizedNeighbor[]} Neighbors normalizzati
   */
  parseLldpOutput(output) {
    // Usa il parser esistente (già testato e funzionante)
    const rawNeighbors = parseHuaweiLldpNeighbors(output);

    // Normalizza nel formato comune
    return rawNeighbors.map(raw => this.normalizeNeighbor(raw));
  }

  /**
   * Normalizza neighbor Huawei nel formato comune
   * @param {Object} raw - Neighbor dal parser originale
   * @returns {NormalizedNeighbor}
   */
  normalizeNeighbor(raw) {
    return {
      localPort: this.normalizeInterfaceName(raw.localPort),
      remoteDevice: raw.remoteSysname || raw.sysName || raw.chassisId || 'unknown',
      remotePort: raw.remotePort || raw.portId || null,
      remotePortDescr: raw.portDescr || null,
      chassisId: this._normalizeChassisId(raw.chassisId),
      managementIp: raw.mgmtAddr || null,
      systemDescr: raw.sysDescr || null,
      capabilities: this._parseCapabilities(raw.sysDescr)
    };
  }

  /**
   * Normalizza nome interfaccia Huawei
   * @param {string} name - Nome interfaccia (es. 'GE0/0/1')
   * @returns {string} Nome normalizzato (es. 'GigabitEthernet0/0/1')
   */
  normalizeInterfaceName(name) {
    return huaweiNormalizeInterface(name);
  }

  // ============================================
  // Utility compatibilità NeDi
  // ============================================

  /**
   * Converte neighbors nel formato link NeDi
   * Mantiene compatibilità con codice esistente
   * @param {Object[]} neighbors - Array di neighbors (raw o normalizzati)
   * @param {string} deviceName - Nome device locale
   * @returns {Object[]} Links nel formato NeDi
   */
  convertToNeDiLinks(neighbors, deviceName) {
    return convertToNeDiLinks(neighbors, deviceName);
  }

  // ============================================
  // Metodi privati
  // ============================================

  /**
   * Normalizza chassis ID (MAC address) in formato standard
   * Huawei usa formato xxxx-xxxx-xxxx, convertiamo in xx:xx:xx:xx:xx:xx
   * @private
   */
  _normalizeChassisId(chassisId) {
    if (!chassisId) return null;

    // Già in formato standard?
    if (/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(chassisId)) {
      return chassisId.toLowerCase();
    }

    // Formato Huawei xxxx-xxxx-xxxx
    const huaweiMatch = chassisId.match(/^([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})$/i);
    if (huaweiMatch) {
      const hex = huaweiMatch[1] + huaweiMatch[2] + huaweiMatch[3];
      return hex.match(/.{2}/g).join(':').toLowerCase();
    }

    // Formato senza separatori
    const plainMatch = chassisId.match(/^([0-9a-f]{12})$/i);
    if (plainMatch) {
      return plainMatch[1].match(/.{2}/g).join(':').toLowerCase();
    }

    return chassisId;
  }

  /**
   * Estrae capabilities da system description
   * @private
   */
  _parseCapabilities(sysDescr) {
    if (!sysDescr) return [];

    const caps = [];
    const lower = sysDescr.toLowerCase();

    if (/bridge|switch|s\d{4}|ce\d{4}/i.test(lower)) {
      caps.push('bridge');
    }
    if (/router|ne\d{2}/i.test(lower)) {
      caps.push('router');
    }
    if (/wlan|wireless|ap|access.?point/i.test(lower)) {
      caps.push('wlan-access-point');
    }
    if (/phone|voip/i.test(lower)) {
      caps.push('telephone');
    }

    return caps;
  }
}
