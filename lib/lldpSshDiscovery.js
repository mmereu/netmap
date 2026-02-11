import SwitchSSH from './switchSSH.js';
import { parseHuaweiLldpNeighbors, normalizeInterfaceName } from './huaweiLldpParser.js';
import {
  getParserByVendor,
  getParserByEnterpriseId,
  createParserForDevice,
  extractEnterpriseId
} from './vendors/index.js';

/**
 * Orchestratore per discovery LLDP via SSH su switch multi-vendor
 *
 * Supporta:
 * - Huawei (VRP) - completamente implementato
 * - Cisco (IOS/IOS-XE) - stub, comandi documentati
 * - Arista (EOS) - stub, comandi documentati
 * - Juniper (Junos) - stub, comandi documentati
 *
 * Il vendor viene rilevato automaticamente da:
 * 1. Campo vendor nel database (popolato via SNMP)
 * 2. Enterprise ID da sysObjectID
 * 3. Inferenza dal sysname (fallback)
 *
 * Usa:
 * - SwitchSSH per connessione e esecuzione comandi (with connection pooling)
 * - huaweiLldpParser per parsing output LLDP
 * - NetMapDB per inserimento device e link
 *
 * Connection Pooling:
 * - Uses pooled SSH connections by default for batch discovery operations
 * - Connections are reused across multiple device discoveries with same credentials
 * - Pool is automatically cleaned up after batch operations complete
 * - Pool configuration can be customized via poolConfig option
 */
export default class LldpSshDiscovery {
  /**
   * Create a new LldpSshDiscovery instance
   * @param {Object} db - NetMapDB instance
   * @param {Object} [options] - Configuration options
   * @param {Object} [options.credentials] - SSH credentials { username, password }
   * @param {number} [options.port=22] - Default SSH port
   * @param {number} [options.timeout=30000] - Command timeout in ms
   * @param {boolean} [options.usePool=true] - Enable connection pooling
   * @param {Object} [options.poolConfig] - Pool configuration options
   * @param {number} [options.poolConfig.maxConnections=10] - Maximum pooled connections
   * @param {number} [options.poolConfig.idleTimeout=300000] - Idle timeout in ms (5 min)
   * @param {boolean} [options.poolConfig.debug=false] - Enable pool debug logging
   */
  constructor(db, options = {}) {
    this.db = db;  // istanza NetMapDB
    this.credentials = options.credentials || {
      username: 'admin',
      password: ''
    };
    this.defaultPort = options.port || 22;
    this.timeout = options.timeout || 30000;

    // Connection pooling configuration
    const usePool = options.usePool !== false; // Default to true for batch discovery
    const poolConfig = {
      maxConnections: 10,
      idleTimeout: 300000,  // 5 minutes
      healthCheckInterval: 60000, // 1 minute
      debug: false,
      ...options.poolConfig,
    };

    this.ssh = new SwitchSSH({
      usePool: usePool,
      poolConfig: poolConfig,
    });
  }

  /**
   * Discovery LLDP su singolo device via SSH
   * Uses pooled connections for improved performance in batch operations.
   * @param {string} deviceName - Nome device (es: '21_L2_S5735_V2_CED_1')
   * @returns {Promise<Object>} Report discovery: { success, device, neighborsFound, linksCreated, errors }
   */
  async discoverDevice(deviceName) {
    const report = {
      success: false,
      device: deviceName,
      deviceIp: null,
      vendor: null,
      parserUsed: null,
      neighborsFound: 0,
      linksCreated: 0,
      virtualDevicesCreated: 0,
      errors: []
    };

    try {
      // 1. Trova device nel DB per ottenere IP
      const device = this.db.getDevice(deviceName);
      if (!device) {
        report.errors.push(`Device '${deviceName}' non trovato nel database`);
        return report;
      }

      if (!device.ip) {
        report.errors.push(`Device '${deviceName}' non ha IP configurato`);
        return report;
      }

      report.deviceIp = device.ip;

      // 2. Ottieni parser vendor-specific
      const parser = this._getParserForDevice(device);
      if (!parser) {
        report.errors.push(`Nessun parser disponibile per vendor '${device.vendor || 'unknown'}'`);
        return report;
      }

      report.vendor = parser.constructor.vendorId;
      report.parserUsed = parser.constructor.name;

      // 3. Verifica se parser è implementato (non stub)
      if (!parser.constructor.isImplemented) {
        report.errors.push(
          `Parser ${report.parserUsed} per vendor '${report.vendor}' non ancora implementato (stub). ` +
          `Solo Huawei è attualmente supportato.`
        );
        return report;
      }

      console.log(`[LLDP-SSH] Discovery ${deviceName} (${device.ip}) con ${report.parserUsed}`);

      // 4. Ottieni comando LLDP vendor-specific
      const lldpCommand = parser.getLldpCommand();

      // 5. Connetti via SSH e esegui comando LLDP
      let lldpOutput;
      try {
        lldpOutput = await this._executeVendorCommand(device, lldpCommand, parser);
      } catch (sshError) {
        report.errors.push(`Connessione SSH fallita: ${sshError.message}`);
        console.error(`[LLDP-SSH] ${deviceName}: ${sshError.message}`);
        return report;
      }

      // 6. Parsa output LLDP con parser vendor-specific
      const neighbors = parser.parseLldpOutput(lldpOutput);
      report.neighborsFound = neighbors.length;

      if (neighbors.length === 0) {
        console.log(`[LLDP-SSH] ${deviceName}: Nessun neighbor LLDP trovato`);
        report.success = true;
        return report;
      }

      console.log(`[LLDP-SSH] ${deviceName}: Trovati ${neighbors.length} neighbors LLDP`);

      // 4. Per ogni neighbor: crea device (se non esiste) e link
      for (const neighbor of neighbors) {
        try {
          await this._processNeighbor(device, neighbor, report);
        } catch (err) {
          const errorMsg = `Errore processing neighbor ${neighbor.remoteSysname}: ${err.message}`;
          report.errors.push(errorMsg);
          console.error(`[LLDP-SSH] ${deviceName}: ${errorMsg}`);
        }
      }

      report.success = report.errors.length === 0 || report.linksCreated > 0;
      console.log(`[LLDP-SSH] ${deviceName}: Completato - ${report.linksCreated} link creati, ${report.virtualDevicesCreated} device virtuali`);

      return report;
    } catch (err) {
      report.errors.push(`Errore generale discovery: ${err.message}`);
      console.error(`[LLDP-SSH] ${deviceName}: Errore generale: ${err.message}`);
      return report;
    }
  }

  /**
   * Discovery batch su tutti device senza link
   * Uses pooled connections for improved performance - connections are reused
   * across multiple device discoveries when using the same credentials.
   * @param {Object} options - Opzioni filtro { vendor: 'Huawei', limit: 10, parallel: false }
   * @returns {Promise<Object>} Report aggregato
   */
  async discoverZeroLinkDevices(options = {}) {
    const { vendor = 'Huawei', limit = null, parallel = false } = options;

    console.log(`[LLDP-SSH] Inizio discovery batch su device senza link (vendor: ${vendor || 'all'}, limit: ${limit || 'nessuno'})`);

    // 1. Trova device senza link
    const devices = this.db.getDevicesWithZeroLinks({ vendor, limit });

    if (devices.length === 0) {
      console.log('[LLDP-SSH] Nessun device senza link trovato');
      return {
        totalDevices: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        totalNeighbors: 0,
        totalLinks: 0,
        totalVirtualDevices: 0,
        poolStats: this.getPoolStats(),
        reports: []
      };
    }

    console.log(`[LLDP-SSH] Trovati ${devices.length} device senza link`);

    // Log pool stats at start if pooling is enabled
    const poolStatsStart = this.getPoolStats();
    if (poolStatsStart) {
      console.log(`[LLDP-SSH] Pool status at start: ${poolStatsStart.size} connections, ${poolStatsStart.hits} hits, ${poolStatsStart.misses} misses`);
    }

    // 2. Discovery su ogni device
    let reports = [];
    let poolStatsEnd = null;
    try {
      if (parallel) {
        // Esecuzione parallela (usa con cautela - può sovraccaricare switch)
        const promises = devices.map(d => this.discoverDevice(d.sysname || d.ip));
        reports = await Promise.all(promises);
      } else {
        // Esecuzione sequenziale (raccomandato)
        for (const device of devices) {
          const report = await this.discoverDevice(device.sysname || device.ip);
          reports.push(report);

          // Delay tra discovery per non sovraccaricare switch
          await this._delay(1000);
        }
      }
    } finally {
      // Clean up pooled connections after batch completes
      // This ensures we don't leave idle connections open indefinitely
      poolStatsEnd = this.getPoolStats();
      if (poolStatsEnd) {
        console.log(`[LLDP-SSH] Pool status at end: ${poolStatsEnd.size} connections, ${poolStatsEnd.hits} hits (total), ${poolStatsEnd.misses} misses (total)`);
        console.log(`[LLDP-SSH] Pool hit rate: ${poolStatsEnd.hitRate.toFixed(2)}%`);
      }

      // Clear pool after batch to release resources
      // Connections will be recreated on next batch if needed
      this.clearPool();
      console.log('[LLDP-SSH] Connection pool cleared after batch completion');
    }

    // 3. Aggrega risultati
    const summary = {
      totalDevices: devices.length,
      processed: reports.length,
      succeeded: reports.filter(r => r.success).length,
      failed: reports.filter(r => !r.success).length,
      totalNeighbors: reports.reduce((sum, r) => sum + r.neighborsFound, 0),
      totalLinks: reports.reduce((sum, r) => sum + r.linksCreated, 0),
      totalVirtualDevices: reports.reduce((sum, r) => sum + r.virtualDevicesCreated, 0),
      poolStats: poolStatsEnd,
      reports: reports
    };

    console.log(`[LLDP-SSH] Discovery batch completata:`);
    console.log(`  - Device processati: ${summary.processed}/${summary.totalDevices}`);
    console.log(`  - Successi: ${summary.succeeded}`);
    console.log(`  - Fallimenti: ${summary.failed}`);
    console.log(`  - Neighbors trovati: ${summary.totalNeighbors}`);
    console.log(`  - Link creati: ${summary.totalLinks}`);
    console.log(`  - Device virtuali creati: ${summary.totalVirtualDevices}`);

    return summary;
  }

  /**
   * Processa un singolo neighbor: crea device virtuale (se necessario) e link
   * @private
   */
  async _processNeighbor(localDevice, neighbor, report) {
    // 1. Cerca se neighbor esiste già come device
    let remoteDevice = null;

    // Cerca per sysname
    if (neighbor.remoteSysname) {
      remoteDevice = this.db.getDevice(neighbor.remoteSysname);
    }

    // Se non trovato, cerca per chassis ID (se è IP)
    if (!remoteDevice && neighbor.remoteChassisId && this._isValidIp(neighbor.remoteChassisId)) {
      remoteDevice = this.db.getDevice(neighbor.remoteChassisId);
    }

    // 2. Se neighbor non esiste, crea device virtuale
    if (!remoteDevice && neighbor.remoteSysname) {
      const virtualDevice = this._createVirtualDevice(neighbor);

      try {
        this.db.upsertDevice(virtualDevice);
        remoteDevice = this.db.getDevice(neighbor.remoteSysname);

        if (remoteDevice) {
          report.virtualDevicesCreated++;
          console.log(`[LLDP-SSH] ${localDevice.sysname}: Device virtuale creato per ${neighbor.remoteSysname}`);
        }
      } catch (err) {
        console.error(`[LLDP-SSH] ${localDevice.sysname}: Errore creazione device virtuale per ${neighbor.remoteSysname}: ${err.message}`);
      }
    }

    // 3. Ottieni ifindex dalla localPort con mapping robusto
    const localIfindex = this._getIfindexFromPort(localDevice.id, neighbor.localPort);

    // 4. Crea link
    try {
      this.db.upsertLink({
        device_id: localDevice.id,
        local_ifindex: localIfindex,
        local_ifname: neighbor.localPort,
        remote_device_id: remoteDevice ? remoteDevice.id : null,
        remote_ip: (remoteDevice && remoteDevice.ip) || null,
        remote_sysname: neighbor.remoteSysname || null,
        remote_chassisid: neighbor.remoteChassisId || null,
        remote_portid: neighbor.remotePort || null,
        remote_portdesc: neighbor.remotePort || null,
        protocol: 'LLDP'
      });

      report.linksCreated++;
      console.log(`[LLDP-SSH] ${localDevice.sysname}: Link creato ${neighbor.localPort} -> ${neighbor.remoteSysname} (${neighbor.remotePort})`);
    } catch (err) {
      throw new Error(`Errore creazione link: ${err.message}`);
    }
  }

  /**
   * Ottieni ifindex da nome porta con fallback multipli
   * @private
   * @param {number} deviceId - ID device nel DB
   * @param {string} portName - Nome porta (es: GE2/0/21)
   * @returns {number|null} ifindex o null se non trovato
   */
  _getIfindexFromPort(deviceId, portName) {
    if (!portName) return null;

    const ifaces = this.db.getDeviceInterfaces(deviceId);
    if (!ifaces || ifaces.length === 0) return null;

    // 1. Match esatto ifname
    let iface = ifaces.find(i => i.ifname === portName);
    if (iface) return iface.ifindex;

    // 2. Match esatto ifdescr
    iface = ifaces.find(i => i.ifdescr === portName);
    if (iface) return iface.ifindex;

    // 3. Match normalizzato (GigabitEthernet → GE, etc.)
    const normalizedPort = normalizeInterfaceName(portName);
    iface = ifaces.find(i =>
      normalizeInterfaceName(i.ifname) === normalizedPort ||
      normalizeInterfaceName(i.ifdescr) === normalizedPort
    );
    if (iface) return iface.ifindex;

    // 4. Match case-insensitive
    const portLower = portName.toLowerCase();
    iface = ifaces.find(i =>
      i.ifname?.toLowerCase() === portLower ||
      i.ifdescr?.toLowerCase() === portLower
    );
    if (iface) return iface.ifindex;

    // 5. Match parziale (contiene il nome)
    iface = ifaces.find(i =>
      i.ifname?.includes(portName) ||
      i.ifdescr?.includes(portName) ||
      portName.includes(i.ifname) ||
      portName.includes(i.ifdescr)
    );
    if (iface) return iface.ifindex;

    // 6. Fallback: estrai ultimo numero come ifindex (legacy behavior)
    const portMatch = portName.match(/(\d+)$/);
    if (portMatch) {
      const extractedIndex = parseInt(portMatch[1]);
      // Verifica che esista un'interfaccia con questo ifindex
      iface = ifaces.find(i => i.ifindex === extractedIndex);
      if (iface) return extractedIndex;
    }

    return null;
  }

  /**
   * Crea device virtuale per neighbor non esistente
   * @private
   */
  _createVirtualDevice(neighbor) {
    const vendor = this._inferVendor(neighbor.remoteSysname);

    // Se chassis ID è IP, usalo come IP del device
    const ip = (neighbor.remoteChassisId && this._isValidIp(neighbor.remoteChassisId))
      ? neighbor.remoteChassisId
      : null;

    return {
      ip: ip || `0.0.0.0`,  // IP placeholder se non disponibile (richiesto per unique constraint)
      sysname: neighbor.remoteSysname,
      vendor: vendor,
      status: 'virtual',
      level: 999,  // Level alto per marcare come virtuale
      sysdesc: `Virtual device from LLDP (${vendor})`,
    };
  }

  /**
   * Inferisci vendor dal nome del device
   * @private
   */
  _inferVendor(sysname) {
    if (!sysname) return 'Unknown';

    const name = sysname.toLowerCase();

    // Pattern per Access Point
    if (name.includes('ap-') || name.includes('-ap') ||
        name.includes('ap_') || name.includes('_ap') ||
        name.includes('pdv') || name.includes('wifi') ||
        name.includes('wireless') || name.includes('wlan')) {
      return 'Access Point';
    }

    // Pattern per Huawei
    if (name.includes('htw') || name.includes('huawei') ||
        name.includes('s5') || name.includes('s6') ||
        name.includes('ce')) {
      return 'Huawei';
    }

    // Pattern per Cisco
    if (name.includes('cisco') || name.includes('cat') ||
        name.includes('ws-')) {
      return 'Cisco';
    }

    return 'Unknown';
  }

  /**
   * Ottieni parser appropriato per il device
   * Prova in ordine: vendor dal DB, enterprise ID, inferenza da sysname
   * @private
   * @param {Object} device - Device object dal database
   * @returns {VendorParser|null} Istanza parser o null
   */
  _getParserForDevice(device) {
    // Priorità 1: vendor name dal DB (popolato via SNMP)
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

    // Priorità 3: inferenza da sysname (fallback)
    const inferredVendor = this._inferVendor(device.sysname || device.name);
    if (inferredVendor && inferredVendor !== 'Unknown' && inferredVendor !== 'Access Point') {
      const Parser = getParserByVendor(inferredVendor);
      if (Parser) return new Parser();
    }

    return null;
  }

  /**
   * Esegue comando SSH con paging disabilitato vendor-specific
   * @private
   * @param {Object} device - Device object
   * @param {string} command - Comando da eseguire
   * @param {VendorParser} parser - Parser instance per ottenere disablePaging command
   * @returns {Promise<string>} Output del comando
   */
  async _executeVendorCommand(device, command, parser) {
    const disablePagingCmd = parser.getDisablePagingCommand();

    // Costruisce array comandi: prima disable paging, poi comando effettivo
    const commands = disablePagingCmd
      ? [disablePagingCmd, command]
      : [command];

    // Usa connessione pooled se disponibile
    if (this.ssh.getPool()) {
      // executeCommandsPooled per più comandi
      if (commands.length > 1) {
        return await this.ssh.executeCommandsPooled({
          host: device.ip,
          port: this.defaultPort,
          username: this.credentials.username,
          password: this.credentials.password,
          commands: commands,
          timeout: this.timeout
        });
      } else {
        return await this.ssh.executeCommandPooled({
          host: device.ip,
          port: this.defaultPort,
          username: this.credentials.username,
          password: this.credentials.password,
          command: command,
          timeout: this.timeout,
          disablePaging: true
        });
      }
    } else {
      // Fallback senza pool
      if (commands.length > 1) {
        return await this.ssh.executeCommands({
          host: device.ip,
          port: this.defaultPort,
          username: this.credentials.username,
          password: this.credentials.password,
          commands: commands,
          timeout: this.timeout
        });
      } else {
        return await this.ssh.executeCommand({
          host: device.ip,
          port: this.defaultPort,
          username: this.credentials.username,
          password: this.credentials.password,
          command: command,
          timeout: this.timeout,
          disablePaging: true
        });
      }
    }
  }

  /**
   * Verifica se stringa è IP valido
   * @private
   */
  _isValidIp(str) {
    if (!str) return false;
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(str);
  }

  /**
   * Delay helper
   * @private
   */
  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test connessione SSH a device
   * @param {string} deviceName - Nome o IP device
   * @returns {Promise<Object>} { success, message, device }
   */
  async testConnection(deviceName) {
    try {
      const device = this.db.getDevice(deviceName);
      if (!device) {
        return {
          success: false,
          message: `Device '${deviceName}' non trovato nel database`,
          device: null
        };
      }

      if (!device.ip) {
        return {
          success: false,
          message: `Device '${deviceName}' non ha IP configurato`,
          device: device
        };
      }

      const connected = await this.ssh.testConnection({
        host: device.ip,
        port: this.defaultPort,
        username: this.credentials.username,
        password: this.credentials.password
      });

      return {
        success: connected,
        message: connected ? 'Connessione SSH riuscita' : 'Connessione SSH fallita',
        device: device
      };
    } catch (err) {
      return {
        success: false,
        message: `Errore test connessione: ${err.message}`,
        device: null
      };
    }
  }

  /**
   * Ottieni statistiche sui device senza link
   * @param {Object} options - Opzioni filtro { vendor: 'Huawei' }
   * @returns {Object} Statistiche
   */
  getZeroLinkStats(options = {}) {
    const devices = this.db.getDevicesWithZeroLinks(options);

    const byVendor = {};
    const bySite = {};

    for (const device of devices) {
      const vendor = device.vendor || 'Unknown';
      byVendor[vendor] = (byVendor[vendor] || 0) + 1;

      // Estrai sito dal sysname (assumendo formato "XX_..." dove XX è sito)
      const siteMatch = device.sysname?.match(/^(\d+)_/);
      const site = siteMatch ? siteMatch[1] : 'Unknown';
      bySite[site] = (bySite[site] || 0) + 1;
    }

    return {
      total: devices.length,
      byVendor: byVendor,
      bySite: bySite,
      devices: devices.slice(0, 10).map(d => ({
        sysname: d.sysname,
        ip: d.ip,
        vendor: d.vendor,
        location: d.syslocation
      }))
    };
  }

  // ============================================================
  // CONNECTION POOL MANAGEMENT METHODS
  // ============================================================

  /**
   * Get connection pool statistics
   * @returns {Object|null} Pool stats or null if pooling disabled
   */
  getPoolStats() {
    return this.ssh.getPoolStats();
  }

  /**
   * Clear all pooled connections
   * Useful after batch operations to free resources
   */
  clearPool() {
    this.ssh.clearPool();
  }

  /**
   * Shutdown the pool, closing all connections
   * Should be called when the discovery instance is being disposed
   */
  shutdownPool() {
    this.ssh.shutdownPool();
  }

  /**
   * Check if connection pooling is enabled
   * @returns {boolean} True if pooling is enabled
   */
  isPoolingEnabled() {
    return this.ssh.getPool() !== null;
  }
}
