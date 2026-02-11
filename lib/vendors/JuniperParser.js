/**
 * JuniperParser - Parser LLDP per switch/router Juniper (Junos)
 *
 * STUB: Comandi documentati, parsing non ancora implementato.
 * Implementare parseLldpOutput() quando disponibile hardware per test.
 */

import VendorParser from './VendorParser.js';

export default class JuniperParser extends VendorParser {
  // ============================================
  // Identificazione
  // ============================================

  static vendorId = 'juniper';
  static vendorNames = ['Juniper', 'Juniper Networks'];
  static enterpriseIds = ['2636'];
  static isImplemented = false;  // STUB

  // ============================================
  // Comandi SSH
  // ============================================

  getLldpCommand() {
    return 'show lldp neighbors';
  }

  getLldpDetailCommand() {
    return 'show lldp neighbors detail';
  }

  getCdpCommand() {
    // Junos non supporta CDP nativamente
    return null;
  }

  getDisablePagingCommand() {
    return 'set cli screen-length 0';
  }

  getPromptPattern() {
    // Junos: user@hostname> o user@hostname#
    return /[\w\-]+@[\w\-\.]+[>#]\s*$/;
  }

  // ============================================
  // Parsing - NON IMPLEMENTATO
  // ============================================

  /**
   * Parsa output 'show lldp neighbors'
   *
   * Formato atteso Junos (breve):
   * ------------------------------------------------
   * Local Interface    Parent Interface    Chassis Id          Port info          System Name
   * ge-0/0/1           -                   00:11:22:33:44:55   ge-0/0/2           spine-01
   * ge-0/0/2           -                   00:11:22:33:44:66   ge-0/0/1           spine-02
   * ------------------------------------------------
   *
   * Formato 'show lldp neighbors detail':
   * ------------------------------------------------
   * LLDP Neighbor Information:
   * Local Interface   : ge-0/0/1
   * Parent Interface  : -
   * Chassis ID        : 00:11:22:33:44:55
   * Port ID           : ge-0/0/2
   * Port Description  : uplink to leaf
   * System Name       : spine-01
   * System Description: Juniper Networks, Inc. qfx5100-48s...
   * System Capabilities:
   *     Supported: Bridge Router
   *     Enabled  : Bridge Router
   * Management Address: 10.0.0.1
   * ------------------------------------------------
   *
   * @param {string} output - Output del comando
   * @returns {NormalizedNeighbor[]}
   * @throws {Error} Non ancora implementato
   */
  parseLldpOutput(output) {
    throw new Error(
      `JuniperParser.parseLldpOutput() non ancora implementato. ` +
      `Formato atteso documentato nel sorgente. ` +
      `Contribuisci: https://github.com/your-repo/netmap`
    );
  }

  // ============================================
  // Normalizzazione interfacce Juniper
  // ============================================

  /**
   * Normalizza nomi interfaccia Juniper
   * Junos usa formato: ge-0/0/1, xe-0/0/1, et-0/0/1, ae0
   * @param {string} name - Nome interfaccia
   * @returns {string} Nome normalizzato (invariato per Junos)
   */
  normalizeInterfaceName(name) {
    if (!name) return name;

    // Junos usa già nomi consistenti, solo pulizia
    return name.trim();
  }
}
