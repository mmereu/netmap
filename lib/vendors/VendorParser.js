/**
 * VendorParser - Classe base astratta per parser LLDP vendor-specific
 *
 * Ogni vendor parser deve estendere questa classe e implementare
 * i metodi richiesti per comandi SSH e parsing output.
 *
 * @abstract
 */
export default class VendorParser {
  // ============================================
  // Proprietà statiche - OVERRIDE RICHIESTO
  // ============================================

  /**
   * Identificatore univoco del vendor (es. 'huawei', 'cisco')
   * @type {string}
   */
  static vendorId = 'unknown';

  /**
   * Nomi alternativi del vendor per lookup (es. ['Huawei', 'H3C'])
   * @type {string[]}
   */
  static vendorNames = [];

  /**
   * Enterprise ID SNMP associati (es. ['2011'] per Huawei)
   * Estratti da sysObjectID: 1.3.6.1.4.1.<enterpriseId>...
   * @type {string[]}
   */
  static enterpriseIds = [];

  /**
   * Flag che indica se il parser è completamente implementato
   * I parser stub devono avere isImplemented = false
   * @type {boolean}
   */
  static isImplemented = false;

  // ============================================
  // Comandi SSH - OVERRIDE RICHIESTO
  // ============================================

  /**
   * Comando per ottenere neighbors LLDP
   * @returns {string} Comando SSH (es. 'display lldp neighbor')
   * @abstract
   */
  getLldpCommand() {
    throw new Error(`${this.constructor.name}.getLldpCommand() must be implemented`);
  }

  /**
   * Comando per ottenere neighbors LLDP con dettagli extra (opzionale)
   * @returns {string|null} Comando SSH o null se non disponibile
   */
  getLldpDetailCommand() {
    return null;
  }

  /**
   * Comando CDP (Cisco Discovery Protocol) - solo per vendor compatibili
   * @returns {string|null} Comando SSH o null se non supportato
   */
  getCdpCommand() {
    return null;
  }

  /**
   * Comando per disabilitare paging dell'output
   * @returns {string} Comando SSH (es. 'screen-length 0 temporary')
   * @abstract
   */
  getDisablePagingCommand() {
    throw new Error(`${this.constructor.name}.getDisablePagingCommand() must be implemented`);
  }

  /**
   * Pattern regex per riconoscere il prompt della CLI
   * @returns {RegExp} Pattern (es. /<[\w\-_]+>/)
   * @abstract
   */
  getPromptPattern() {
    throw new Error(`${this.constructor.name}.getPromptPattern() must be implemented`);
  }

  // ============================================
  // Parsing - OVERRIDE RICHIESTO
  // ============================================

  /**
   * Parsa output del comando LLDP e ritorna array di neighbors normalizzati
   * @param {string} output - Output raw del comando LLDP
   * @returns {NormalizedNeighbor[]} Array di neighbors normalizzati
   * @abstract
   */
  parseLldpOutput(output) {
    throw new Error(`${this.constructor.name}.parseLldpOutput() must be implemented`);
  }

  /**
   * Parsa output del comando CDP (solo Cisco)
   * @param {string} output - Output raw del comando CDP
   * @returns {NormalizedNeighbor[]} Array di neighbors normalizzati
   */
  parseCdpOutput(output) {
    throw new Error(`${this.constructor.name}.parseCdpOutput() not supported`);
  }

  // ============================================
  // Normalizzazione - OVERRIDE CONSIGLIATO
  // ============================================

  /**
   * Normalizza un neighbor raw nel formato comune
   * @param {Object} raw - Neighbor raw dal parsing
   * @returns {NormalizedNeighbor} Neighbor normalizzato
   */
  normalizeNeighbor(raw) {
    return {
      localPort: raw.localPort || null,
      remoteDevice: raw.remoteDevice || raw.sysName || null,
      remotePort: raw.remotePort || raw.portId || null,
      remotePortDescr: raw.remotePortDescr || raw.portDescr || null,
      chassisId: raw.chassisId || null,
      managementIp: raw.managementIp || raw.mgmtAddr || null,
      systemDescr: raw.systemDescr || raw.sysDescr || null,
      capabilities: raw.capabilities || []
    };
  }

  /**
   * Normalizza nome interfaccia nel formato esteso
   * @param {string} name - Nome interfaccia abbreviato (es. 'GE0/0/1')
   * @returns {string} Nome normalizzato (es. 'GigabitEthernet0/0/1')
   */
  normalizeInterfaceName(name) {
    // Default: ritorna invariato, override per vendor-specific
    return name;
  }

  // ============================================
  // Utility
  // ============================================

  /**
   * Verifica se questo parser supporta un determinato vendor name
   * @param {string} vendorName - Nome vendor da verificare
   * @returns {boolean}
   */
  static supportsVendor(vendorName) {
    if (!vendorName) return false;
    const lower = vendorName.toLowerCase();
    return this.vendorNames.some(n => n.toLowerCase() === lower);
  }

  /**
   * Verifica se questo parser supporta un determinato enterprise ID
   * @param {string} enterpriseId - Enterprise ID da verificare
   * @returns {boolean}
   */
  static supportsEnterpriseId(enterpriseId) {
    return this.enterpriseIds.includes(String(enterpriseId));
  }
}

/**
 * @typedef {Object} NormalizedNeighbor
 * @property {string|null} localPort - Porta locale normalizzata
 * @property {string|null} remoteDevice - Nome device remoto
 * @property {string|null} remotePort - Porta remota
 * @property {string|null} remotePortDescr - Descrizione porta remota
 * @property {string|null} chassisId - MAC/ID chassis remoto
 * @property {string|null} managementIp - IP management remoto
 * @property {string|null} systemDescr - System description remoto
 * @property {string[]} capabilities - Capabilities LLDP
 */
