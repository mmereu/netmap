/**
 * CiscoParser - Parser LLDP/CDP per switch Cisco (IOS, IOS-XE, NX-OS)
 *
 * STUB: Comandi documentati, parsing non ancora implementato.
 * Implementare parseLldpOutput() e parseCdpOutput() quando disponibile hardware per test.
 */

import VendorParser from './VendorParser.js';

export default class CiscoParser extends VendorParser {
  // ============================================
  // Identificazione
  // ============================================

  static vendorId = 'cisco';
  static vendorNames = ['Cisco', 'Cisco Systems'];
  static enterpriseIds = ['9'];
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

  /**
   * Cisco supporta CDP (Cisco Discovery Protocol)
   * CDP è spesso più affidabile di LLDP su dispositivi Cisco
   */
  getCdpCommand() {
    return 'show cdp neighbors detail';
  }

  getDisablePagingCommand() {
    return 'terminal length 0';
  }

  getPromptPattern() {
    // Cisco: hostname# o hostname>
    return /[\w\-\.]+[#>]\s*$/;
  }

  // ============================================
  // Parsing - NON IMPLEMENTATO
  // ============================================

  /**
   * Parsa output 'show lldp neighbors detail'
   *
   * Formato atteso IOS-XE:
   * ------------------------------------------------
   * Local Intf: Gi0/1
   * Chassis id: 0011.2233.4455
   * Port id: Gi0/2
   * Port Description: uplink to core
   * System Name: neighbor-switch
   * System Description:
   *     Cisco IOS Software, C3750E Software...
   * Time remaining: 108 seconds
   * System Capabilities: B,R
   *     Enabled Capabilities: B,R
   * Management Addresses:
   *     IP: 192.168.1.2
   * ------------------------------------------------
   *
   * @param {string} output - Output del comando
   * @returns {NormalizedNeighbor[]}
   * @throws {Error} Non ancora implementato
   */
  parseLldpOutput(output) {
    throw new Error(
      `CiscoParser.parseLldpOutput() non ancora implementato. ` +
      `Formato atteso documentato nel sorgente. ` +
      `Contribuisci: https://github.com/your-repo/netmap`
    );
  }

  /**
   * Parsa output 'show cdp neighbors detail'
   *
   * Formato atteso:
   * ------------------------------------------------
   * Device ID: neighbor-switch.domain.com
   * Entry address(es):
   *     IP address: 192.168.1.2
   * Platform: cisco WS-C3750X-48P, Capabilities: Switch IGMP
   * Interface: GigabitEthernet0/1, Port ID (outgoing port): GigabitEthernet0/2
   * Holdtime: 155 sec
   * Version:
   *     Cisco IOS Software, C3750E Software...
   * ------------------------------------------------
   *
   * @param {string} output - Output del comando
   * @returns {NormalizedNeighbor[]}
   * @throws {Error} Non ancora implementato
   */
  parseCdpOutput(output) {
    throw new Error(
      `CiscoParser.parseCdpOutput() non ancora implementato. ` +
      `Formato atteso documentato nel sorgente.`
    );
  }

  // ============================================
  // Normalizzazione interfacce Cisco
  // ============================================

  /**
   * Normalizza nomi interfaccia Cisco
   * @param {string} name - Nome abbreviato (es. 'Gi0/1', 'Te1/0/1')
   * @returns {string} Nome esteso
   */
  normalizeInterfaceName(name) {
    if (!name) return name;

    const mappings = [
      { pattern: /^Gi(\d)/i, replacement: 'GigabitEthernet$1' },
      { pattern: /^Te(\d)/i, replacement: 'TenGigabitEthernet$1' },
      { pattern: /^Fa(\d)/i, replacement: 'FastEthernet$1' },
      { pattern: /^Eth(\d)/i, replacement: 'Ethernet$1' },
      { pattern: /^Po(\d)/i, replacement: 'Port-channel$1' },
      { pattern: /^Vl(\d)/i, replacement: 'Vlan$1' },
      { pattern: /^Lo(\d)/i, replacement: 'Loopback$1' },
      { pattern: /^Twe(\d)/i, replacement: 'TwentyFiveGigE$1' },
      { pattern: /^Fo(\d)/i, replacement: 'FortyGigabitEthernet$1' },
      { pattern: /^Hu(\d)/i, replacement: 'HundredGigE$1' }
    ];

    for (const { pattern, replacement } of mappings) {
      if (pattern.test(name)) {
        return name.replace(pattern, replacement);
      }
    }

    return name;
  }
}
