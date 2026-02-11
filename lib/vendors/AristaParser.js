/**
 * AristaParser - Parser LLDP per switch Arista (EOS)
 *
 * STUB: Comandi documentati, parsing non ancora implementato.
 * Implementare parseLldpOutput() quando disponibile hardware per test.
 */

import VendorParser from './VendorParser.js';

export default class AristaParser extends VendorParser {
  // ============================================
  // Identificazione
  // ============================================

  static vendorId = 'arista';
  static vendorNames = ['Arista', 'Arista Networks'];
  static enterpriseIds = ['30065'];
  static isImplemented = false;  // STUB

  // ============================================
  // Comandi SSH
  // ============================================

  getLldpCommand() {
    return 'show lldp neighbors detail';
  }

  getLldpDetailCommand() {
    return 'show lldp neighbors detail';
  }

  getCdpCommand() {
    // Arista supporta CDP ma LLDP è preferito
    return null;
  }

  getDisablePagingCommand() {
    return 'terminal length 0';
  }

  getPromptPattern() {
    // Arista EOS: hostname# o hostname>
    return /[\w\-\.]+[#>]\s*$/;
  }

  // ============================================
  // Parsing - NON IMPLEMENTATO
  // ============================================

  /**
   * Parsa output 'show lldp neighbors detail'
   *
   * Formato atteso Arista EOS:
   * ------------------------------------------------
   * Interface Ethernet1 detected 1 LLDP neighbors:
   *   Neighbor 0011.2233.4455/"Ethernet2", age 45 seconds
   *   Discovered 12:34:56 ago; Last changed 12:34:56 ago
   *   - Chassis ID type: MAC address (4)
   *     Chassis ID     : 0011.2233.4455
   *   - Port ID type: Interface name (5)
   *     Port ID        : "Ethernet2"
   *   - Time To Live: 120 seconds
   *   - Port Description: "uplink"
   *   - System Name: "spine-01"
   *   - System Description: "Arista Networks EOS version 4.28.0F..."
   *   - System Capabilities : Bridge, Router
   *     Enabled Capabilities: Bridge, Router
   *   - Management Address Subtype: IPv4
   *     Management Address        : 10.0.0.1
   * ------------------------------------------------
   *
   * @param {string} output - Output del comando
   * @returns {NormalizedNeighbor[]}
   * @throws {Error} Non ancora implementato
   */
  parseLldpOutput(output) {
    throw new Error(
      `AristaParser.parseLldpOutput() non ancora implementato. ` +
      `Formato atteso documentato nel sorgente. ` +
      `Contribuisci: https://github.com/your-repo/netmap`
    );
  }

  // ============================================
  // Normalizzazione interfacce Arista
  // ============================================

  /**
   * Normalizza nomi interfaccia Arista
   * Arista usa nomi semplici: Ethernet1, Ethernet1/1, Port-Channel1
   * @param {string} name - Nome interfaccia
   * @returns {string} Nome normalizzato
   */
  normalizeInterfaceName(name) {
    if (!name) return name;

    const mappings = [
      { pattern: /^Et(\d)/i, replacement: 'Ethernet$1' },
      { pattern: /^Eth(\d)/i, replacement: 'Ethernet$1' },
      { pattern: /^Po(\d)/i, replacement: 'Port-Channel$1' },
      { pattern: /^Vl(\d)/i, replacement: 'Vlan$1' },
      { pattern: /^Lo(\d)/i, replacement: 'Loopback$1' },
      { pattern: /^Ma(\d)/i, replacement: 'Management$1' }
    ];

    for (const { pattern, replacement } of mappings) {
      if (pattern.test(name)) {
        return name.replace(pattern, replacement);
      }
    }

    return name;
  }
}
