import mysql from 'mysql2/promise';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// Auto-load config from nedi-config.json if exists
function loadNeDiConfig() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = join(__dirname, 'nedi-config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log('[NeDi] Config caricata da nedi-config.json:', config.host + ':' + config.port);
      return config;
    }
  } catch (e) {
    console.log('[NeDi] Errore caricamento config:', e.message);
  }
  return {};
}

const fileConfig = loadNeDiConfig();

/**
 * Adapter per database NeDi MySQL - Connessione diretta
 * Usa connection pool per performance ottimali
 */
class NeDiDB {
  constructor(config = {}) {
    // Merge: passed config > file config > defaults
    const mergedConfig = { ...fileConfig, ...config };
    this.mysqlConfig = {
      host: mergedConfig.host || 'localhost',
      port: mergedConfig.port || 3307,
      user: mergedConfig.user || 'nedi',
      password: mergedConfig.password || process.env.NEDI_MYSQL_PASS || '',
      database: mergedConfig.database || 'nedi',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000
    };
    this.pool = null;

    // Enhanced cache configuration - NeDi data changes less frequently
    // so we use a longer default TTL (5 minutes)
    this.cacheTtl = config.cacheTtl || 300000; // 5 minutes default
    this.cacheMaxSize = config.cacheMaxSize || 100;
    this.cache = new Map();
    this.cacheStats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      evictions: 0
    };

    // Cleanup timer for expired entries
    this.cleanupIntervalMs = config.cleanupIntervalMs || 300000; // 5 minutes
    this.cleanupTimer = null;
  }

  async init() {
    try {
      this.pool = mysql.createPool(this.mysqlConfig);
      // Test connessione
      const [rows] = await this.pool.query('SELECT 1 as test');
      console.log('[NeDi] Connessione MySQL diretta OK:', this.mysqlConfig.host);
      // Start cache cleanup timer
      this._startCleanupTimer();
    } catch (err) {
      console.error('[NeDi] Errore connessione MySQL:', err.message);
      throw err;
    }
  }

  // ============ CACHE MANAGEMENT ============

  /**
   * Start the periodic cache cleanup timer
   */
  _startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this._cleanupExpired(), this.cleanupIntervalMs);
    // Ensure timer doesn't prevent process exit
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Remove expired cache entries
   */
  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.cacheTtl) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.cacheStats.evictions += cleaned;
    }
  }

  /**
   * Get a cached value by key
   * @param {string} key - Cache key
   * @returns {*} Cached data or null if not found/expired
   */
  _cacheGet(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.cacheStats.misses++;
      return null;
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.cacheTtl) {
      this.cache.delete(key);
      this.cacheStats.misses++;
      return null;
    }

    this.cacheStats.hits++;
    return entry.data;
  }

  /**
   * Set a cached value
   * @param {string} key - Cache key
   * @param {*} data - Data to cache
   */
  _cacheSet(key, data) {
    // Enforce max size by evicting oldest entry if needed
    if (this.cache.size >= this.cacheMaxSize && !this.cache.has(key)) {
      this._evictOldest();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    this.cacheStats.sets++;
  }

  /**
   * Evict the oldest cache entry (LRU-like)
   */
  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.cacheStats.evictions++;
    }
  }

  /**
   * Clear all cache entries
   */
  clearCache() {
    const size = this.cache.size;
    this.cache.clear();
    this.cacheStats.invalidations += size;
  }

  /**
   * Invalidate cache entries matching a pattern
   * @param {string} pattern - Pattern to match (supports * wildcard at end)
   * @returns {number} Number of entries invalidated
   */
  invalidateCache(pattern) {
    let count = 0;
    const isPrefix = pattern.endsWith('*');
    const prefix = isPrefix ? pattern.slice(0, -1) : pattern;

    for (const key of this.cache.keys()) {
      const matches = isPrefix ? key.startsWith(prefix) : key === pattern;
      if (matches) {
        this.cache.delete(key);
        count++;
        this.cacheStats.invalidations++;
      }
    }
    return count;
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    const total = this.cacheStats.hits + this.cacheStats.misses;
    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      ttlMs: this.cacheTtl,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      sets: this.cacheStats.sets,
      invalidations: this.cacheStats.invalidations,
      evictions: this.cacheStats.evictions,
      hitRate: total > 0 ? (this.cacheStats.hits / total * 100).toFixed(2) + '%' : '0%',
      entries: Array.from(this.cache.keys())
    };
  }

  /**
   * Warm the cache by pre-loading frequently used data
   * @returns {Promise<Object>} Summary of warmed cache entries
   */
  async warmCache() {
    const warmed = { devices: false, links: false, topology: false };

    try {
      // Pre-load devices
      await this.getCachedAllDevices();
      warmed.devices = true;

      // Pre-load links
      await this.getCachedAllLinks();
      warmed.links = true;

      // Pre-load default topology (no filter)
      await this.getCachedTopologyData({});
      warmed.topology = true;
    } catch (err) {
      console.error('[NeDi] Cache warming error:', err.message);
    }

    return warmed;
  }

  // Esegue query MySQL con connection pool
  async execQuery(sql, params = []) {
    if (!this.pool) {
      throw new Error('Pool MySQL non inizializzato');
    }
    const [rows] = params.length > 0
      ? await this.pool.query(sql, params)
      : await this.pool.query(sql);
    return rows;
  }

  // Utility: IP numerico -> dotted notation
  longToIp(long) {
    if (!long || long === '0' || long === 0) return null;
    const n = typeof long === 'string' ? parseInt(long) : long;
    return [
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255
    ].join('.');
  }

  // Utility: IP dotted -> numerico
  ipToLong(ip) {
    if (!ip) return 0;
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  // ============ DEVICES ============

  async getAllDevices() {
    const sql = `
      SELECT device, devip, serial, type, description, location, vendor, devos,
             firstdis, lastdis, snmpversion, readcomm, devstatus
      FROM devices ORDER BY device
    `;
    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      sysname: row.device,
      ip: this.longToIp(row.devip),
      serial: row.serial,
      model: row.type,
      sysdesc: row.description,
      syslocation: row.location,
      vendor: row.vendor,
      os: row.devos,
      firstseen: parseInt(row.firstdis) || 0,
      lastseen: parseInt(row.lastdis) || 0,
      snmp_version: row.snmpversion === '2' ? '2c' : row.snmpversion,
      community: row.readcomm,
      status: row.devstatus === 0 ? 'active' : 'inactive'
    }));
  }

  /**
   * Get all devices with caching
   * @returns {Promise<Array>} Cached array of device objects
   */
  async getCachedAllDevices() {
    const cacheKey = 'nedi:devices:all';
    const cached = this._cacheGet(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const devices = await this.getAllDevices();
    this._cacheSet(cacheKey, devices);
    return devices;
  }

  async getDevice(ipOrSysname) {
    let sql;
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipOrSysname)) {
      const ipLong = this.ipToLong(ipOrSysname);
      sql = `SELECT * FROM devices WHERE devip = ${ipLong} LIMIT 1`;
    } else {
      sql = `SELECT * FROM devices WHERE device = ? OR device LIKE ? LIMIT 1`;
      const [rows] = await this.pool.query(sql, [ipOrSysname, `%${ipOrSysname}%`]);
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        sysname: row.device,
        ip: this.longToIp(row.devip),
        serial: row.serial,
        model: row.type,
        sysdesc: row.description,
        syslocation: row.location,
        vendor: row.vendor,
        os: row.devos,
        firstseen: parseInt(row.firstdis) || 0,
        lastseen: parseInt(row.lastdis) || 0,
        status: row.devstatus === 0 ? 'active' : 'inactive'
      };
    }

    const rows = await this.execQuery(sql);
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      sysname: row.device,
      ip: this.longToIp(row.devip),
      serial: row.serial,
      model: row.type,
      sysdesc: row.description,
      syslocation: row.location,
      vendor: row.vendor,
      os: row.devos,
      firstseen: parseInt(row.firstdis) || 0,
      lastseen: parseInt(row.lastdis) || 0,
      status: row.devstatus === 0 ? 'active' : 'inactive'
    };
  }

  async getDevicesPaginated(options = {}) {
    const { limit = 100, offset = 0, status, site } = options;

    let sql = `
      SELECT device, devip, serial, type, description, location, vendor, devos,
             firstdis, lastdis, devstatus
      FROM devices WHERE 1=1
    `;

    if (status === 'active') sql += ` AND devstatus = 0`;
    else if (status === 'inactive') sql += ` AND devstatus > 0`;

    if (site) sql += ` AND device LIKE '${site}_%'`;

    sql += ` ORDER BY device LIMIT ${limit} OFFSET ${offset}`;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      sysname: row.device,
      ip: this.longToIp(row.devip),
      serial: row.serial,
      model: row.type,
      sysdesc: row.description,
      syslocation: row.location,
      location: row.location,
      vendor: row.vendor,
      os: row.devos,
      firstseen: parseInt(row.firstdis) || 0,
      lastseen: parseInt(row.lastdis) || 0,
      status: row.devstatus === 0 ? 'active' : 'inactive'
    }));
  }

  async getDevicesCount(options = {}) {
    const { status, site } = options;
    let sql = `SELECT COUNT(*) as cnt FROM devices WHERE 1=1`;

    if (status === 'active') sql += ` AND devstatus = 0`;
    else if (status === 'inactive') sql += ` AND devstatus > 0`;

    if (site) sql += ` AND device LIKE '${site}_%'`;

    const rows = await this.execQuery(sql);
    return rows[0]?.cnt || 0;
  }

  // ============ SITES (SITI) ============

  async getSites() {
    const sql = `
      SELECT
        SUBSTRING_INDEX(device, '_', 1) as site_id,
        COUNT(*) as device_count
      FROM devices
      WHERE device LIKE '%_%'
      GROUP BY SUBSTRING_INDEX(device, '_', 1)
      ORDER BY site_id
    `;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      id: row.site_id,
      name: `Sito ${row.site_id}`,
      deviceCount: parseInt(row.device_count) || 0
    }));
  }

  async getStatsBySite(site) {
    const siteFilter = `${site}_%`;

    const [devRows, ifRows, linkRows, activeRows] = await Promise.all([
      this.execQuery(`SELECT COUNT(*) as cnt FROM devices WHERE device LIKE '${siteFilter}'`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM interfaces WHERE device LIKE '${siteFilter}'`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM links WHERE (device LIKE '${siteFilter}' OR neighbor LIKE '${siteFilter}')`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM devices WHERE device LIKE '${siteFilter}' AND devstatus = 0`)
    ]);

    return {
      totalDevices: devRows[0]?.cnt || 0,
      totalInterfaces: ifRows[0]?.cnt || 0,
      totalLinks: linkRows[0]?.cnt || 0,
      activeDevices: activeRows[0]?.cnt || 0,
      site: site
    };
  }

  // ============ INTERFACES ============

  async getDeviceInterfaces(deviceName) {
    const sql = `
      SELECT ifidx, ifname, ifdesc, iftype, speed, ifstat, alias, ifmac, pvid
      FROM interfaces WHERE device = ? ORDER BY ifidx
    `;

    const [rows] = await this.pool.query(sql, [deviceName]);

    return rows.map(row => ({
      ifindex: parseInt(row.ifidx) || 0,
      ifname: row.ifname,
      ifdescr: row.ifdesc,
      iftype: parseInt(row.iftype) || 0,
      ifspeed: parseInt(row.speed) || 0,
      ifoperstatus: parseInt(row.ifstat) || 0,
      ifalias: row.alias,
      ifphysaddress: row.ifmac,
      vlan: parseInt(row.pvid) || 0
    }));
  }

  // ============ LINKS ============

  async getAllLinks() {
    const sql = `
      SELECT l.device, d.devip, l.ifname, l.neighbor, l.nbrifname,
             l.bandwidth, l.linktype, MAX(l.time) as time, dn.devip as nbrip
      FROM links l
      LEFT JOIN devices d ON l.device = d.device
      LEFT JOIN devices dn ON l.neighbor = dn.device
      WHERE l.linktype IS NOT NULL
        AND l.neighbor IS NOT NULL
        AND l.neighbor != ''
      GROUP BY l.device, l.ifname, l.neighbor
      ORDER BY l.device, l.ifname
    `;

    const rows = await this.execQuery(sql);
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    return rows
      .filter(row => !ipPattern.test(row.neighbor))
      .map(row => ({
        local_sysname: row.device,
        local_ip: this.longToIp(row.devip),
        local_ifname: row.ifname,
        remote_sysname: row.neighbor,
        remote_ip: this.longToIp(row.nbrip),
        remote_portdesc: row.nbrifname,
        remote_portid: row.nbrifname,
        protocol: row.linktype || 'LLDP',
        lastseen: parseInt(row.time) || 0
      }));
  }

  /**
   * Get all links with caching
   * @returns {Promise<Array>} Cached array of link objects
   */
  async getCachedAllLinks() {
    const cacheKey = 'nedi:links:all';
    const cached = this._cacheGet(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const links = await this.getAllLinks();
    this._cacheSet(cacheKey, links);
    return links;
  }

  async getNeighborDevices() {
    const sql = `
      SELECT DISTINCT l.neighbor, dn.devip
      FROM links l
      LEFT JOIN devices dn ON l.neighbor = dn.device
      WHERE l.neighbor NOT IN (SELECT device FROM devices)
      ORDER BY l.neighbor
    `;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      sysname: row.neighbor,
      ip: row.devip ? this.longToIp(row.devip) : null
    }));
  }

  async getDeviceLinks(deviceName) {
    const sql = `
      SELECT l.device, d.devip, l.ifname, l.neighbor, l.nbrifname,
             l.bandwidth, l.linktype, MAX(l.time) as time, dn.devip as nbrip
      FROM links l
      LEFT JOIN devices d ON l.device = d.device
      LEFT JOIN devices dn ON l.neighbor = dn.device
      WHERE (l.device = ? OR l.neighbor = ?)
        AND l.linktype IS NOT NULL
        AND l.neighbor IS NOT NULL
        AND l.neighbor != ''
      GROUP BY l.device, l.ifname, l.neighbor
      ORDER BY l.ifname
    `;

    const [rows] = await this.pool.query(sql, [deviceName, deviceName]);
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    return rows
      .filter(row => !ipPattern.test(row.neighbor))
      .map(row => ({
        local_sysname: row.device,
        local_ip: this.longToIp(row.devip),
        local_ifname: row.ifname,
        remote_sysname: row.neighbor,
        remote_ip: this.longToIp(row.nbrip),
        remote_portdesc: row.nbrifname,
        protocol: row.linktype || 'LLDP',
        lastseen: parseInt(row.time) || 0
      }));
  }

  async getLinksForMap(options = {}) {
    const { deviceFilter } = options;

    let sql = `
      SELECT l.device, d.devip, l.ifname, l.neighbor, l.nbrifname,
             l.bandwidth, l.linktype, MAX(l.time) as time, dn.devip as nbrip,
             d.location as dloc, dn.location as nloc
      FROM links l
      LEFT JOIN devices d ON l.device = d.device
      LEFT JOIN devices dn ON l.neighbor = dn.device
      WHERE l.linktype IS NOT NULL
        AND l.neighbor IS NOT NULL
        AND l.neighbor != ''
    `;

    if (deviceFilter) {
      sql += ` AND (l.device LIKE '${deviceFilter}%' OR l.neighbor LIKE '${deviceFilter}%')`;
    }

    sql += ` GROUP BY l.device, l.ifname, l.neighbor`;
    sql += ` ORDER BY l.device, l.ifname`;

    const rows = await this.execQuery(sql);
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    return rows
      .filter(row => !ipPattern.test(row.neighbor))
      .map(row => ({
        source: row.device,
        source_ip: this.longToIp(row.devip),
        source_port: row.ifname,
        target: row.neighbor,
        target_ip: this.longToIp(row.nbrip),
        target_port: row.nbrifname,
        protocol: row.linktype || 'LLDP',
        bandwidth: parseInt(row.bandwidth) || 0
      }));
  }

  // ============ TOPOLOGY MAP ============

  async getTopologyData(options = {}) {
    const { deviceFilter } = options;

    let devSql = `SELECT device, devip, type, location, vendor FROM devices`;
    if (deviceFilter) {
      devSql += ` WHERE device LIKE '${deviceFilter}%'`;
    }

    const devices = await this.execQuery(devSql);
    const links = await this.getLinksForMap(options);

    const nodes = devices.map(d => ({
      id: d.device,
      label: d.device,
      ip: this.longToIp(d.devip),
      type: d.type,
      location: d.location,
      vendor: d.vendor
    }));

    const edgeSet = new Set();
    const edges = [];

    for (const link of links) {
      const key = [link.source, link.target].sort().join('--');
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({
          source: link.source,
          target: link.target,
          sourcePort: link.source_port,
          targetPort: link.target_port,
          protocol: link.protocol
        });
      }
    }

    return { nodes, edges, links };
  }

  /**
   * Get topology data with caching
   * Uses filter-aware cache keys to cache different filtered views separately
   * @param {Object} options - Options with optional deviceFilter
   * @returns {Promise<Object>} Cached topology data with nodes, edges, and links
   */
  async getCachedTopologyData(options = {}) {
    const { deviceFilter } = options;
    // Create a cache key that includes the filter to cache different views separately
    const filterKey = deviceFilter ? `:filter:${deviceFilter}` : ':all';
    const cacheKey = `nedi:topology${filterKey}`;

    const cached = this._cacheGet(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const topology = await this.getTopologyData(options);
    this._cacheSet(cacheKey, topology);
    return topology;
  }

  // ============ STATISTICS ============

  async getStats() {
    const [devRows, ifRows, linkRows, nodeRows] = await Promise.all([
      this.execQuery(`SELECT COUNT(*) as cnt FROM devices`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM interfaces`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM links`),
      this.execQuery(`SELECT COUNT(*) as cnt FROM nodes`)
    ]);

    return {
      devices: devRows[0]?.cnt || 0,
      interfaces: ifRows[0]?.cnt || 0,
      links: linkRows[0]?.cnt || 0,
      nodes: nodeRows[0]?.cnt || 0
    };
  }

  async getMacAddresses(limit = 50000, daysBack = 7) {
    const sql = `
      SELECT mac, device, ifname, vlanid, oui, nodesc
      FROM nodes
      WHERE device IS NOT NULL
        AND device != ''
        AND ifname IS NOT NULL
        AND ifname != ''
      ORDER BY device, ifname
      LIMIT ${limit}
    `;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      mac: row.mac,
      device: row.device,
      ifname: row.ifname,
      vlan: row.vlanid ? parseInt(row.vlanid) : null,
      timestamp: null,
      vendor: row.oui || null,
      description: row.nodesc || null
    }));
  }

  /**
   * Recupera posizione attuale MAC dalla tabella mac_current_position
   * Questa tabella contiene la PORTA FISICA REALE (non VLAN interfaces)
   */
  async getMacCurrentPosition(limit = 50000) {
    const sql = `
      SELECT mac, device, ifname, vlanid, lastseen, oui, nodesc
      FROM mac_current_position
      WHERE device IS NOT NULL
        AND device != ''
        AND ifname IS NOT NULL
        AND ifname != ''
      ORDER BY lastseen DESC
      LIMIT ${limit}
    `;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      mac: row.mac,
      device: row.device,
      ifname: row.ifname,
      vlan: row.vlanid ? parseInt(row.vlanid) : null,
      lastseen: row.lastseen,
      vendor: row.oui || null,
      description: row.nodesc || null
    }));
  }

  /**
   * Cerca MAC nella tabella mac_current_position
   */
  async searchMacCurrentPosition(macPattern) {
    const cleanMac = macPattern.replace(/[:.|-]/g, '').toLowerCase();

    const sql = `
      SELECT mac, device, ifname, vlanid, lastseen, oui, nodesc
      FROM mac_current_position
      WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${cleanMac}%'
      ORDER BY lastseen DESC
      LIMIT 10
    `;

    const rows = await this.execQuery(sql);

    return rows.map(row => ({
      mac: row.mac,
      device: row.device,
      ifname: row.ifname,
      vlan: row.vlanid ? parseInt(row.vlanid) : null,
      lastseen: row.lastseen,
      vendor: row.oui || null,
      description: row.nodesc || null
    }));
  }

  async searchMac(macPattern, limit = 100, filters = {}) {
    const cleanMac = macPattern.replace(/[:.|\-]/g, '').toLowerCase();

    const site = typeof filters.site === 'string' && /^\d{1,3}$/.test(filters.site) ? filters.site : null;
    const vlan = filters.vlan !== undefined ? parseInt(filters.vlan) : null;

    console.log(`[NeDi] Ricerca MAC: ${macPattern} → pattern: ${cleanMac} | site=${site || '-'} | vlan=${vlan ?? '-'}`);

    // Escape special characters in LIKE pattern for SQL
    const escapedMacPattern = `%${cleanMac.replace(/[%_\\]/g, '\\$&')}%`;
    const escapedSitePattern = site ? `${site}_%` : null;

    let nodesSql = `
      SELECT n.mac, n.device, n.ifname, n.vlanid, n.oui, n.nodesc,
             d.devip, d.type as devtype, d.location as devlocation,
             (SELECT COUNT(*) FROM nodes n2 WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
      FROM nodes n
      LEFT JOIN devices d ON n.device = d.device
      WHERE REPLACE(REPLACE(REPLACE(n.mac, ':', ''), '-', ''), '.', '') LIKE ?
    `;
    const nodeParams = [escapedMacPattern];

    if (site) {
      nodesSql += ` AND n.device LIKE ?`;
      nodeParams.push(escapedSitePattern);
    }
    if (vlan !== null && !Number.isNaN(vlan)) {
      nodesSql += ` AND n.vlanid = ?`;
      nodeParams.push(vlan);
    }
    nodesSql += ` LIMIT ${Math.min(limit, 1000)}`;

    let nodarpSql = `
      SELECT a.mac, a.nodip, a.arpdevice, a.arpifname, a.ipupdate, a.aname,
             d.devip, d.type as devtype
      FROM nodarp a
      LEFT JOIN devices d ON a.arpdevice = d.device
      WHERE REPLACE(REPLACE(REPLACE(a.mac, ':', ''), '-', ''), '.', '') LIKE ?
    `;
    const nodarpParams = [escapedMacPattern];

    if (site) {
      nodarpSql += ` AND a.arpdevice LIKE ?`;
      nodarpParams.push(escapedSitePattern);
    }
    if (vlan !== null && !Number.isNaN(vlan)) {
      nodarpSql += ` AND a.vlanid = ?`;
      nodarpParams.push(vlan);
    }
    nodarpSql += ` ORDER BY a.ipupdate DESC LIMIT ${Math.min(limit, 1000)}`;

    try {
      const [nodesData, nodarpData] = await Promise.all([
        this.execQuery(nodesSql, nodeParams),
        this.execQuery(nodarpSql, nodarpParams)
      ]);

      const nodesResult = nodesData.map(row => ({
        mac: row.mac,
        device: row.device,
        device_ip: row.devip ? this.longToIp(row.devip) : null,
        device_type: row.devtype || null,
        device_location: row.devlocation || null,
        interface: row.ifname,
        vlan: row.vlanid ? parseInt(row.vlanid) : null,
        lastseen: null,
        vendor: row.oui || null,
        description: row.nodesc || null,
        macCount: row.macCount ? parseInt(row.macCount) : 999  // numero MAC su questa porta (basso=access, alto=uplink)
      }));

      const nodarpResult = nodarpData.map(row => ({
        mac: row.mac,
        ip: row.nodip ? this.longToIp(row.nodip) : null,
        device: row.arpdevice,
        interface: row.arpifname || null,
        device_ip: row.devip ? this.longToIp(row.devip) : null,
        device_type: row.devtype || null,
        hostname: row.aname || null,
        lastseen: parseInt(row.ipupdate) || 0
      }));

      console.log(`[NeDi] MAC search risultati: nodes=${nodesResult.length}, nodarp=${nodarpResult.length}`);

      return {
        nodes: { count: nodesResult.length, data: nodesResult },
        arp: { count: nodarpResult.length, data: nodarpResult },
        totalCount: nodesResult.length + nodarpResult.length
      };
    } catch (err) {
      console.error(`[NeDi] Errore searchMac:`, err.message);
      throw err;
    }
  }

  // ============ MAC TRACKER V2 - NUOVI METODI ============

  /**
   * Ottiene info ARP per un MAC address (IP associato)
   * @param {string} mac - MAC address
   * @returns {Promise<{ip: string, lastSeen: number, hostname: string}|null>}
   */
  async getArpInfo(mac) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();
    // Formatta per query NeDi (xxxx-xxxx-xxxx)
    const nediMac = cleanMac.match(/.{4}/g)?.join('-') || cleanMac;

    const sql = `
      SELECT nodip, ipupdate, aname, arpdevice, arpifname
      FROM nodarp
      WHERE REPLACE(REPLACE(mac, '-', ''), ':', '') = '${cleanMac}'
      ORDER BY ipupdate DESC
      LIMIT 1
    `;

    try {
      const rows = await this.execQuery(sql);
      if (!rows || rows.length === 0) return null;

      const row = rows[0];
      return {
        ip: row.nodip ? this.longToIp(row.nodip) : null,
        lastSeen: parseInt(row.ipupdate) || 0,
        hostname: row.aname || null,
        device: row.arpdevice || null,
        interface: row.arpifname || null
      };
    } catch (err) {
      console.error(`[NeDi] Errore getArpInfo:`, err.message);
      return null;
    }
  }

  /**
   * Ottiene storico movimenti di un MAC (ultimi N giorni)
   * @param {string} mac - MAC address
   * @param {number} days - Giorni indietro (default 30)
   * @returns {Promise<Array<{device, port, vlan, firstSeen, lastSeen}>>}
   */
  async getMacHistory(mac, days = 30) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (days * 86400);

    const sql = `
      SELECT device, ifname, vlanid, firstseen, lastseen
      FROM nodes
      WHERE REPLACE(REPLACE(mac, '-', ''), ':', '') = '${cleanMac}'
        AND lastseen > ${cutoffTimestamp}
      ORDER BY lastseen DESC
      LIMIT 50
    `;

    try {
      const rows = await this.execQuery(sql);

      // Raggruppa per device+port per evitare duplicati
      const seen = new Map();
      const results = [];

      for (const row of rows) {
        const key = `${row.device}|${row.ifname}`;
        if (!seen.has(key)) {
          seen.set(key, true);
          results.push({
            device: row.device,
            port: row.ifname,
            vlan: row.vlanid ? parseInt(row.vlanid) : null,
            firstSeen: parseInt(row.firstseen) || 0,
            lastSeen: parseInt(row.lastseen) || 0
          });
        }
      }

      return results;
    } catch (err) {
      console.error(`[NeDi] Errore getMacHistory:`, err.message);
      return [];
    }
  }

  /**
   * Ottiene storico VLAN di un MAC
   * @param {string} mac - MAC address
   * @returns {Promise<Array<{vlan, lastSeen, current}>>}
   */
  async getVlanHistory(mac) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();

    const sql = `
      SELECT vlanid, MAX(lastseen) as lastSeen
      FROM nodes
      WHERE REPLACE(REPLACE(mac, '-', ''), ':', '') = '${cleanMac}'
        AND vlanid IS NOT NULL
      GROUP BY vlanid
      ORDER BY lastSeen DESC
    `;

    try {
      const rows = await this.execQuery(sql);

      const results = rows.map((row, idx) => ({
        vlan: parseInt(row.vlanid) || 0,
        lastSeen: parseInt(row.lastSeen) || 0,
        current: idx === 0  // La prima è la più recente
      }));

      return results;
    } catch (err) {
      console.error(`[NeDi] Errore getVlanHistory:`, err.message);
      return [];
    }
  }

  /**
   * Ottiene storico movimenti WiFi di un MAC dagli ultimi N giorni
   * Usa le tabelle mac_history e mac_movements per tracciare spostamenti tra AP
   * @param {string} mac - MAC address
   * @param {number} days - Numero di giorni di storico (default 30)
   * @returns {Promise<{movements: Array, summary: Object}>}
   */
  async getMacMovementHistory(mac, days = 30) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();

    try {
      // 1. Movimenti con dettagli old->new
      const movementsSql = `
        SELECT
          old_device,
          old_ifname,
          old_vlanid,
          new_device,
          new_ifname,
          new_vlanid,
          movement_time
        FROM mac_movements
        WHERE mac = '${cleanMac}'
          AND movement_time > DATE_SUB(NOW(), INTERVAL ${days} DAY)
        ORDER BY movement_time DESC
        LIMIT 200
      `;

      // 2. Snapshot storico (posizioni uniche)
      const historySql = `
        SELECT
          device,
          ifname,
          vlanid,
          snapshot_time
        FROM mac_history
        WHERE mac = '${cleanMac}'
          AND snapshot_time > DATE_SUB(NOW(), INTERVAL ${days} DAY)
        ORDER BY snapshot_time DESC
        LIMIT 500
      `;

      // 3. Summary: AP più frequentati
      const summarySql = `
        SELECT
          device,
          COUNT(*) as visit_count,
          MIN(snapshot_time) as first_seen,
          MAX(snapshot_time) as last_seen
        FROM mac_history
        WHERE mac = '${cleanMac}'
          AND snapshot_time > DATE_SUB(NOW(), INTERVAL ${days} DAY)
        GROUP BY device
        ORDER BY visit_count DESC
        LIMIT 20
      `;

      const [movements, history, summary] = await Promise.all([
        this.execQuery(movementsSql),
        this.execQuery(historySql),
        this.execQuery(summarySql)
      ]);

      // Formatta movimenti
      const formattedMovements = movements.map(m => ({
        from: {
          device: m.old_device,
          port: m.old_ifname,
          vlan: m.old_vlanid
        },
        to: {
          device: m.new_device,
          port: m.new_ifname,
          vlan: m.new_vlanid
        },
        timestamp: m.movement_time,
        isWifiRoaming: m.old_device?.startsWith('AP_') && m.new_device?.startsWith('AP_')
      }));

      // Formatta storico posizioni
      const formattedHistory = history.map(h => ({
        device: h.device,
        port: h.ifname,
        vlan: h.vlanid,
        timestamp: h.snapshot_time,
        isAccessPoint: h.device?.startsWith('AP_')
      }));

      // Formatta summary
      const formattedSummary = summary.map(s => ({
        device: s.device,
        visitCount: parseInt(s.visit_count),
        firstSeen: s.first_seen,
        lastSeen: s.last_seen,
        isAccessPoint: s.device?.startsWith('AP_')
      }));

      // Calcola statistiche
      const stats = {
        totalMovements: movements.length,
        totalSnapshots: history.length,
        uniqueLocations: summary.length,
        wifiRoamings: formattedMovements.filter(m => m.isWifiRoaming).length,
        mostVisitedAP: formattedSummary.find(s => s.isAccessPoint)?.device || null,
        periodStart: history.length > 0 ? history[history.length - 1].snapshot_time : null,
        periodEnd: history.length > 0 ? history[0].snapshot_time : null
      };

      return {
        mac: cleanMac,
        days,
        movements: formattedMovements,
        history: formattedHistory,
        topLocations: formattedSummary,
        stats
      };
    } catch (err) {
      console.error(`[NeDi] Errore getMacMovementHistory:`, err.message);
      return {
        mac: cleanMac,
        days,
        movements: [],
        history: [],
        topLocations: [],
        stats: { error: err.message }
      };
    }
  }

  /**
   * Ottiene tutti gli switch dove è stato visto un MAC
   * @param {string} mac - MAC address
   * @returns {Promise<Array<{switch, ip, port, vlan, macCount, isEndpoint}>>}
   */
  async getAllSwitchesForMac(mac) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();

    // Query con filtro per escludere interfacce virtuali
    // JOIN con interfaces per ottenere PVID (VLAN configurata sulla porta)
    const sql = `
      SELECT n.device, d.devip, n.ifname, n.vlanid, n.lastseen,
             i.pvid as portPvid,
             (SELECT COUNT(*) FROM nodes n2
              WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
      FROM nodes n
      LEFT JOIN devices d ON n.device = d.device
      LEFT JOIN interfaces i ON n.device = i.device AND n.ifname = i.ifname
      WHERE REPLACE(REPLACE(n.mac, '-', ''), ':', '') = '${cleanMac}'
        AND n.ifname NOT LIKE 'Vlanif%'
        AND n.ifname NOT LIKE 'Vlif%'
        AND n.ifname NOT LIKE 'Vlan%'
        AND n.ifname NOT LIKE 'NULL%'
        AND n.ifname NOT LIKE 'null%'
        AND n.ifname NOT LIKE 'Loop%'
        AND n.ifname NOT LIKE 'InLoop%'
        AND n.ifname NOT LIKE 'MEth%'
        AND n.ifname NOT LIKE 'Stack-Port%'
        AND n.ifname NOT LIKE 'Bridge-Aggregation%'
      ORDER BY n.lastseen DESC
    `;

    try {
      const rows = await this.execQuery(sql);

      // Se non trova porte fisiche, cerca senza filtro come fallback
      if (rows.length === 0) {
        console.log(`[NeDi] getAllSwitchesForMac: nessuna porta fisica, fallback a tutte le interfacce`);
        const fallbackSql = `
          SELECT n.device, d.devip, n.ifname, n.vlanid, n.lastseen,
                 i.pvid as portPvid,
                 (SELECT COUNT(*) FROM nodes n2
                  WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
          FROM nodes n
          LEFT JOIN devices d ON n.device = d.device
          LEFT JOIN interfaces i ON n.device = i.device AND n.ifname = i.ifname
          WHERE REPLACE(REPLACE(n.mac, '-', ''), ':', '') = '${cleanMac}'
          ORDER BY n.lastseen DESC
        `;
        const fallbackRows = await this.execQuery(fallbackSql);
        return fallbackRows.map(row => ({
          switch: row.device,
          ip: row.devip ? this.longToIp(row.devip) : null,
          port: row.ifname,
          vlan: row.portPvid ? parseInt(row.portPvid) : (row.vlanid ? parseInt(row.vlanid) : null),
          vlanSeen: row.vlanid ? parseInt(row.vlanid) : null,
          pvid: row.portPvid ? parseInt(row.portPvid) : null,
          lastSeen: parseInt(row.lastseen) || 0,
          macCount: parseInt(row.macCount) || 1,
          isEndpoint: (parseInt(row.macCount) || 1) <= 3,
          isVirtual: true  // Flag per indicare interfaccia virtuale
        }));
      }

      return rows.map(row => ({
        switch: row.device,
        ip: row.devip ? this.longToIp(row.devip) : null,
        port: row.ifname,
        vlan: row.portPvid ? parseInt(row.portPvid) : (row.vlanid ? parseInt(row.vlanid) : null),
        vlanSeen: row.vlanid ? parseInt(row.vlanid) : null,
        pvid: row.portPvid ? parseInt(row.portPvid) : null,
        lastSeen: parseInt(row.lastseen) || 0,
        macCount: parseInt(row.macCount) || 1,
        isEndpoint: (parseInt(row.macCount) || 1) <= 3
      }));
    } catch (err) {
      console.error(`[NeDi] Errore getAllSwitchesForMac:`, err.message);
      return [];
    }
  }

  /**
   * Ottiene dettagli LLDP per un neighbor su una porta specifica
   * @param {string} device - Nome device
   * @param {string} port - Nome porta (può essere parziale)
   * @returns {Promise<{sysName, sysDescription, managementIp, capabilities}|null>}
   */
  async getLldpDetails(device, port) {
    // Estrai numero porta per match flessibile
    const portMatch = port.match(/(\d+\/\d+\/\d+|\d+)$/);
    const portPattern = portMatch ? `%${portMatch[1]}` : `%${port}%`;

    // JOIN con devices per ottenere info sul neighbor
    const sql = `
      SELECT l.neighbor, l.nbrifname, l.linktype, l.linkdesc,
             d.description AS nbrdesc, d.devip AS nbripaddr, d.type AS nbrtype
      FROM links l
      LEFT JOIN devices d ON d.device = l.neighbor
      WHERE l.device = '${device}'
        AND (l.ifname LIKE '${portPattern}' OR l.ifname = '${port}')
      ORDER BY l.time DESC
      LIMIT 1
    `;

    try {
      const rows = await this.execQuery(sql);
      if (!rows || rows.length === 0) return null;

      const row = rows[0];

      // Parse capabilities da description/type se presente
      let capabilities = [];
      const desc = (row.nbrdesc || row.nbrtype || '').toLowerCase();
      if (desc.includes('access point') || desc.includes('wlan') || desc.includes('wap')) capabilities.push('wlanAccessPoint');
      if (desc.includes('bridge') || desc.includes('switch')) capabilities.push('bridge');
      if (desc.includes('router')) capabilities.push('router');
      if (desc.includes('phone') || desc.includes('telephone')) capabilities.push('telephone');

      return {
        sysName: row.neighbor || null,
        sysDescription: row.nbrdesc || null,
        managementIp: row.nbripaddr ? this.longToIp(row.nbripaddr) : null,
        portId: row.nbrifname || null,
        linkType: row.linktype || null,
        capabilities
      };
    } catch (err) {
      console.error(`[NeDi] Errore getLldpDetails:`, err.message);
      return null;
    }
  }

  /**
   * Verifica se un device name esiste nella tabella devices (è gestito)
   * @param {string} deviceName - Nome del device
   * @returns {Promise<boolean>} true se esiste
   */
  async isNetworkDevice(deviceName) {
    if (!deviceName) return false;
    try {
      const sql = `SELECT device FROM devices WHERE device = ? LIMIT 1`;
      const [rows] = await this.pool.query(sql, [deviceName]);
      return rows.length > 0;
    } catch (err) {
      console.error(`[NeDi] Errore isNetworkDevice:`, err.message);
      return false;
    }
  }

  /**
   * Verifica se un MAC appartiene a un device di rete gestito (switch/router/AP)
   * Cerca nella tabella links se questo MAC corrisponde a un neighbor noto
   * @param {string} mac - MAC address (pulito, senza separatori)
   * @returns {Promise<{device: string, devip: number}|null>} Device info se trovato
   */
  async getDeviceByMac(mac) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();
    console.log(`[NeDi] getDeviceByMac: searching for ${cleanMac}`);
    try {
      // Cerca nella tabella interfaces se questo MAC appartiene a un device gestito
      // NOTA: NeDi non ha una colonna MAC nella tabella devices, quindi
      // cerchiamo nella tabella interfaces per MAC di interfacce
      const sql = `
        SELECT DISTINCT i.device, d.devip
        FROM interfaces i
        JOIN devices d ON d.device = i.device
        WHERE REPLACE(REPLACE(LOWER(i.ifmac), ':', ''), '-', '') = ?
        LIMIT 1
      `;
      const [rows] = await this.pool.query(sql, [cleanMac]);
      console.log(`[NeDi] getDeviceByMac: query returned ${rows?.length || 0} rows`);
      if (rows && rows.length > 0) {
        console.log(`[NeDi] MAC ${cleanMac} appartiene all'interfaccia del device ${rows[0].device}`);
        return {
          device: rows[0].device,
          devip: rows[0].devip
        };
      }
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceByMac:`, err.message);
    }
    console.log(`[NeDi] getDeviceByMac: MAC ${cleanMac} is NOT a network device`);
    return null;
  }

  /**
   * Trova la porta endpoint reale seguendo la catena LLDP
   * SOLO se il MAC appartiene effettivamente a un device di rete gestito
   * @param {string} mac - MAC address cercato
   * @param {string} switchName - Switch dove è visto il MAC
   * @param {string} port - Porta dove è visto il MAC
   * @param {Object} lldpInfo - Info LLDP del neighbor (può essere null)
   * @returns {Promise<Object|null>} Endpoint reale o null
   */
  async findRealEndpoint(mac, switchName, port, lldpInfo) {
    console.log(`[NeDi] findRealEndpoint CALLED: mac=${mac}, switch=${switchName}, port=${port}`);
    // Prima verifica: il MAC appartiene a un device di rete gestito?
    const deviceInfo = await this.getDeviceByMac(mac);
    console.log(`[NeDi] findRealEndpoint deviceInfo:`, deviceInfo ? JSON.stringify(deviceInfo) : 'null');

    if (!deviceInfo) {
      // Il MAC NON appartiene a nessun device gestito → è un endpoint normale
      // Non seguire la catena LLDP
      return null;
    }

    // Il MAC appartiene a un device di rete (switch/router/AP)
    // Trova dove quel device è connesso (uplink)
    console.log(`[NeDi] MAC ${mac} appartiene al device di rete: ${deviceInfo.device}`);

    // Cerca il link dove questo device è il neighbor
    const sql = `
      SELECT l.device, l.ifname, l.neighbor, l.nbrifname, d.devip
      FROM links l
      JOIN devices d ON d.device = l.device
      WHERE l.neighbor = ?
      ORDER BY l.time DESC
      LIMIT 1
    `;

    try {
      const [rows] = await this.pool.query(sql, [deviceInfo.device]);
      if (rows.length > 0) {
        const row = rows[0];
        return {
          switch: row.device,
          switchIp: row.devip ? this.longToIp(row.devip) : null,
          port: row.ifname,
          neighborSwitch: row.neighbor,
          neighborPort: row.nbrifname,
          isNetworkDevice: true,
          networkDeviceName: deviceInfo.device
        };
      }
    } catch (err) {
      console.error(`[NeDi] Errore findRealEndpoint:`, err.message);
    }
    return null;
  }

  // ============ SSH LIVE SEARCH ============

  /**
   * Legge credenziali SSH dal file Pdv.CSV per un dato IP
   * @param {string} ip - IP dello switch
   * @returns {{username: string, password: string}}
   */
  getCredentialsForIp(ip) {
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const csvPath = join(__dirname, 'Pdv.CSV');
      if (!existsSync(csvPath)) {
        console.log('[NeDi] Pdv.CSV non trovato, uso credenziali default');
        return { username: process.env.SSH_USERNAME || 'admin', password: process.env.SWITCH_PASSWORD || 'changeme' };
      }

      const content = readFileSync(csvPath, 'utf8');
      const lines = content.trim().split(/\r?\n/);

      // Estrai prefisso network dall'IP (es. 192.168.1.251 -> 192.168.1)
      const ipParts = ip.split('.');
      const ipPrefix = ipParts.slice(0, 3).join('.');

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(';');
        const network = parts[2] || '';
        const user = (parts[3] || '').replace(/"/g, '');
        const pass = (parts[4] || '').replace(/"/g, '');

        // Estrai prefisso dalla network (es. 192.168.1.0/24 -> 192.168.1)
        const netPrefix = network.split('/')[0].split('.').slice(0, 3).join('.');

        if (netPrefix === ipPrefix && user && pass) {
          console.log(`[NeDi] Credenziali per ${ip}: ${user}@${netPrefix}`);
          return { username: user, password: pass };
        }
      }

      console.log(`[NeDi] Nessuna credenziale per ${ip}, uso default`);
      return { username: process.env.SSH_USERNAME || 'admin', password: process.env.SWITCH_PASSWORD || 'changeme' };
    } catch (err) {
      console.error('[NeDi] Errore lettura Pdv.CSV:', err.message);
      return { username: process.env.SSH_USERNAME || 'admin', password: process.env.SWITCH_PASSWORD || 'changeme' };
    }
  }

  /**
   * Cerca un MAC via SSH su un singolo switch
   * @param {string} mac - MAC da cercare (formato pulito)
   * @param {string} switchIp - IP dello switch
   * @param {string} switchName - Nome dello switch
   * @returns {Promise<{port: string, vlan: number}|null>}
   */
  async searchMacOnSwitchViaSsh(mac, switchIp, switchName) {
    const creds = this.getCredentialsForIp(switchIp);

    // Formato MAC per Huawei: xxxx-xxxx-xxxx
    const huaweiMac = mac.replace(/[:.]/g, '').toLowerCase();
    const huaweiFmt = huaweiMac.match(/.{4}/g)?.join('-') || huaweiMac;

    console.log(`[NeDi] SSH search ${huaweiFmt} su ${switchName} (${switchIp})`);

    // Crea script expect temporaneo
    const scriptContent = `#!/usr/bin/expect -f
set timeout 15
log_user 0
spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa ${creds.username}@${switchIp}
expect {
  -re "assword:|assword:" { send "${creds.password}\\r" }
  timeout { exit 1 }
}
expect {
  -re "<.*>|\\\\[.*\\\\]" { send "screen-length 0 temporary\\r" }
  timeout { exit 1 }
}
expect -re "<.*>|\\\\[.*\\\\]"
send "display mac-address ${huaweiFmt}\\r"
expect -re "<.*>|\\\\[.*\\\\]"
send "quit\\r"
expect eof
`;

    const tmpScript = `/tmp/ssh_mac_search_${Date.now()}.exp`;

    try {
      writeFileSync(tmpScript, scriptContent);

      const { stdout } = await execPromise(`expect ${tmpScript}`, { timeout: 20000 });

      // Cleanup
      try { unlinkSync(tmpScript); } catch (e) {}

      // Parse output - cerca righe con MAC e porta
      // Formato: xxxx-xxxx-xxxx  123  GE0/0/1  dynamic  ...
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes(huaweiFmt) || line.toLowerCase().includes(huaweiMac.substring(0, 8))) {
          // Cerca pattern: MAC VLAN PORT TYPE
          const match = line.match(/([0-9a-f-]+)\s+(\d+)\s+(\S+)\s+(dynamic|static)/i);
          if (match) {
            const [, , vlan, port] = match;
            console.log(`[NeDi] SSH trovato: ${port} VLAN ${vlan}`);
            return { port, vlan: parseInt(vlan) };
          }
        }
      }

      console.log(`[NeDi] SSH: MAC non trovato su ${switchName}`);
      return null;

    } catch (err) {
      console.error(`[NeDi] SSH error ${switchName}:`, err.message);
      try { unlinkSync(tmpScript); } catch (e) {}
      return null;
    }
  }

  /**
   * Cerca MAC su tutti i Core switch via SSH (fallback quando NeDi non trova)
   * @param {string} mac - MAC da cercare
   * @returns {Promise<Object|null>} Endpoint trovato o null
   */
  async searchMacOnCoresViaSsh(mac) {
    console.log(`[NeDi] Fallback SSH: cerco ${mac} sui Core switch...`);

    // Prendi tutti i core switch (L3) da NeDi
    const sql = `
      SELECT device, devip
      FROM devices
      WHERE device LIKE '%L3%' OR device LIKE '%Core%' OR device LIKE '%CORE%'
      ORDER BY device
    `;

    try {
      const [rows] = await this.pool.query(sql);

      if (rows.length === 0) {
        console.log('[NeDi] Nessun Core switch trovato');
        return null;
      }

      console.log(`[NeDi] Trovati ${rows.length} Core switch`);

      // Cerca in parallelo su max 5 core alla volta
      const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();

      for (let i = 0; i < rows.length; i += 5) {
        const batch = rows.slice(i, i + 5);

        const results = await Promise.all(
          batch.map(async (row) => {
            const switchIp = this.longToIp(row.devip);
            if (!switchIp) return null;

            const result = await this.searchMacOnSwitchViaSsh(cleanMac, switchIp, row.device);
            if (result) {
              return {
                switch: row.device,
                switchIp,
                port: result.port,
                vlan: result.vlan,
                source: 'ssh-live'
              };
            }
            return null;
          })
        );

        // Se trovato, ritorna subito
        const found = results.find(r => r !== null);
        if (found) {
          console.log(`[NeDi] SSH trovato su ${found.switch}:${found.port}`);
          return found;
        }
      }

      console.log('[NeDi] SSH: MAC non trovato su nessun Core');
      return null;

    } catch (err) {
      console.error('[NeDi] Errore searchMacOnCoresViaSsh:', err.message);
      return null;
    }
  }

  /**
   * Ricerca MAC completa per MAC Tracker v2 (instant)
   * Esegue tutte le query in parallelo per risultato istantaneo
   * @param {string} mac - MAC address
   * @returns {Promise<Object>} Tutti i dati aggregati
   */
  async searchMacInstant(mac) {
    const cleanMac = mac.replace(/[:.|-]/g, '').toLowerCase();
    const formattedMac = cleanMac.match(/.{2}/g)?.join(':') || cleanMac;

    console.log(`[NeDi] searchMacInstant: ${mac} → ${formattedMac}`);

    try {
      // Query parallele per performance
      const [searchResult, arpInfo, history, vlanHistory, allSwitches] = await Promise.all([
        this.searchMac(mac, 10),
        this.getArpInfo(mac),
        this.getMacHistory(mac, 30),
        this.getVlanHistory(mac),
        this.getAllSwitchesForMac(mac)
      ]);

      // Trova endpoint (switch con meno MAC sulla porta)
      let endpoint = null;
      let lldpInfo = null;
      let realEndpoint = null;

      if (allSwitches.length > 0) {
        // Ordina per macCount ascendente (meno MAC = più probabile endpoint)
        const sorted = [...allSwitches].sort((a, b) => a.macCount - b.macCount);
        const best = sorted[0];

        // Ottieni dettagli LLDP
        lldpInfo = best.switch && best.port
          ? await this.getLldpDetails(best.switch, best.port)
          : null;

        // Verifica se il MAC appartiene a un device di rete (switch/router)
        // In tal caso, trova la porta reale dove quel device è connesso
        // NOTA: ora passiamo il MAC per verificare che sia effettivamente un device gestito
        realEndpoint = await this.findRealEndpoint(cleanMac, best.switch, best.port, lldpInfo);

        if (realEndpoint) {
          // Il MAC appartiene a un device di rete
          // L'endpoint reale è la porta del neighbor switch
          endpoint = {
            switch: realEndpoint.switch,
            switchIp: realEndpoint.switchIp,
            port: realEndpoint.port,
            vlan: best.vlan,
            macCount: 1,
            portType: 'uplink',
            source: 'nedi',
            isNetworkDevice: true,
            connectedTo: {
              switch: best.switch,
              switchIp: best.ip,
              port: best.port
            }
          };
          console.log(`[NeDi] MAC ${mac} appartiene a device di rete ${lldpInfo.sysName}, endpoint reale: ${realEndpoint.switch}:${realEndpoint.port}`);
        } else {
          // MAC di un endpoint normale (PC, stampante, etc)
          endpoint = {
            switch: best.switch,
            switchIp: best.ip,
            port: best.port,
            vlan: best.vlan,
            macCount: best.macCount,
            portType: best.macCount > 5 ? 'uplink' : 'access',
            source: 'nedi'
          };
        }
      }

      // FALLBACK: Se NeDi non trova, cerca sui Core switch via SSH
      const foundInNedi = allSwitches.length > 0 || (searchResult.nodes?.count > 0);

      if (!foundInNedi) {
        console.log(`[NeDi] MAC ${mac} non trovato in NeDi, provo fallback SSH sui Core...`);

        const sshResult = await this.searchMacOnCoresViaSsh(mac);

        if (sshResult) {
          endpoint = {
            switch: sshResult.switch,
            switchIp: sshResult.switchIp,
            port: sshResult.port,
            vlan: sshResult.vlan,
            macCount: 1,
            portType: 'unknown',
            source: 'ssh-live'
          };

          return {
            query: mac,
            normalized: formattedMac,
            found: true,
            phase: 'ssh-fallback',
            source: 'ssh-live',
            endpoint,
            lldpInfo: null,
            arpInfo,
            history: [],
            vlanHistory: [],
            allSwitches: [{
              switch: sshResult.switch,
              ip: sshResult.switchIp,
              port: sshResult.port,
              vlan: sshResult.vlan,
              lastSeen: Math.floor(Date.now() / 1000),
              macCount: 1,
              isEndpoint: false,
              source: 'ssh-live'
            }],
            nodes: searchResult.nodes,
            arp: searchResult.arp
          };
        }
      }

      return {
        query: mac,
        normalized: formattedMac,
        found: foundInNedi,
        phase: 'db',
        source: 'nedi',
        endpoint,
        lldpInfo,
        arpInfo,
        history,
        vlanHistory,
        allSwitches,
        nodes: searchResult.nodes,
        arp: searchResult.arp
      };
    } catch (err) {
      console.error(`[NeDi] Errore searchMacInstant:`, err.message);
      throw err;
    }
  }

  // ============ DEVICE DETAILS ============

  async getDeviceVlans(deviceName) {
    const sql = `
      SELECT vlanid, vlanname, device
      FROM vlans
      WHERE device = ?
      ORDER BY vlanid
    `;

    try {
      const [rows] = await this.pool.query(sql, [deviceName]);

      return rows.map(row => ({
        vlan_id: parseInt(row.vlanid) || 0,
        vlan_name: row.vlanname || `VLAN${row.vlanid}`,
        device: row.device
      }));
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceVlans per ${deviceName}:`, err.message);
      return [];
    }
  }

  async getDeviceConnections(deviceName) {
    const sql = `
      SELECT l.id, l.device, d.devip, l.ifname, l.neighbor, l.nbrifname,
             l.bandwidth, l.linktype, l.time, dn.devip as nbrip, dn.type as nbrtype,
             dn.vendor as nbrvendor, dn.location as nbrlocation
      FROM links l
      LEFT JOIN devices d ON l.device = d.device
      LEFT JOIN devices dn ON l.neighbor = dn.device
      WHERE l.device = ?
      ORDER BY l.ifname
    `;

    try {
      const [rows] = await this.pool.query(sql, [deviceName]);

      return rows.map(row => ({
        link_id: parseInt(row.id) || 0,
        local_device: row.device,
        local_ip: this.longToIp(row.devip),
        local_interface: row.ifname,
        remote_device: row.neighbor,
        remote_ip: this.longToIp(row.nbrip),
        remote_interface: row.nbrifname,
        remote_type: row.nbrtype,
        remote_vendor: row.nbrvendor,
        remote_location: row.nbrlocation,
        bandwidth: parseInt(row.bandwidth) || 0,
        protocol: row.linktype || 'LLDP',
        last_seen: parseInt(row.time) || 0
      }));
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceConnections per ${deviceName}:`, err.message);
      return [];
    }
  }

  async getDeviceEvents(deviceName, limit = 5) {
    const sql = `
      SELECT level, info, time, source
      FROM events
      WHERE source LIKE ? OR device LIKE ?
      ORDER BY time DESC
      LIMIT ?
    `;

    try {
      const [rows] = await this.pool.query(sql, [`%${deviceName}%`, `%${deviceName}%`, limit]);

      return rows.map(row => ({
        severity: this._mapEventLevel(row.level),
        description: row.info,
        timestamp: parseInt(row.time) || 0,
        source: row.source
      }));
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceEvents per ${deviceName}:`, err.message);
      return [];
    }
  }

  _mapEventLevel(level) {
    const lvl = parseInt(level) || 0;
    if (lvl >= 500) return 'critical';
    if (lvl >= 400) return 'error';
    if (lvl >= 300) return 'warning';
    if (lvl >= 200) return 'info';
    return 'debug';
  }

  async getDeviceStatus(deviceName) {
    const sql = `
      SELECT device, cpu, memcpu, temp, lastdis, firstdis,
             cpualert, memalert, tempalert, supplyalert, devstatus
      FROM devices
      WHERE device = ?
      LIMIT 1
    `;

    try {
      const [rows] = await this.pool.query(sql, [deviceName]);
      if (rows.length === 0) return null;

      const row = rows[0];
      const lastSeen = parseInt(row.lastdis) || 0;
      const firstSeen = parseInt(row.firstdis) || 0;
      const uptime = lastSeen > 0 && firstSeen > 0 ? lastSeen - firstSeen : 0;

      return {
        device: row.device,
        cpu_usage: parseInt(row.cpu) || 0,
        memory_usage: parseInt(row.memcpu) || 0,
        temperature: parseInt(row.temp) || 0,
        uptime_seconds: uptime,
        last_seen: lastSeen,
        status: row.devstatus === 0 ? 'active' : 'inactive',
        alerts: {
          cpu: row.cpualert !== 0,
          memory: row.memalert !== 0,
          temperature: row.tempalert !== 0,
          power_supply: row.supplyalert !== 0
        }
      };
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceStatus per ${deviceName}:`, err.message);
      return null;
    }
  }

  async getDeviceFullStatus(deviceName) {
    try {
      const [device, interfaces, vlans, connections, events, status] = await Promise.all([
        this.getDevice(deviceName),
        this.getDeviceInterfaces(deviceName),
        this.getDeviceVlans(deviceName),
        this.getDeviceConnections(deviceName),
        this.getDeviceEvents(deviceName, 5),
        this.getDeviceStatus(deviceName)
      ]);

      if (!device) {
        throw new Error(`Device '${deviceName}' non trovato`);
      }

      return {
        device,
        interfaces: { count: interfaces.length, list: interfaces },
        vlans: { count: vlans.length, list: vlans },
        connections: { count: connections.length, list: connections },
        events: { count: events.length, list: events },
        status,
        timestamp: Date.now()
      };
    } catch (err) {
      console.error(`[NeDi] Errore getDeviceFullStatus per ${deviceName}:`, err.message);
      throw err;
    }
  }

  // ============ NEIGHBOR DEVICES (VIRTUAL) ============

  async getNeighborDevicesVirtual(neighborPattern = null) {
    let sql = `
      SELECT DISTINCT l.neighbor as device_name
      FROM links l
      WHERE l.neighbor IS NOT NULL AND l.neighbor != ''
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.device = l.neighbor
      )
    `;
    if (neighborPattern) {
      sql += ` AND l.neighbor LIKE '${neighborPattern}'`;
    }
    sql += ` ORDER BY l.neighbor`;

    try {
      const rows = await this.execQuery(sql);
      return rows.map(row => ({
        sysname: row.device_name,
        ip: null,
        device_type: this._inferDeviceType(row.device_name),
        is_virtual: true,
        source: 'LLDP/CDP neighbor'
      }));
    } catch (err) {
      console.error(`[NeDi] Errore getNeighborDevicesVirtual:`, err.message);
      return [];
    }
  }

  async getPDVAccessPoints() {
    return this.getNeighborDevicesVirtual('%PDV%');
  }

  _inferDeviceType(deviceName) {
    const name = (deviceName || '').toLowerCase();
    if (name.includes('pdv') || name.includes('-ap') || name.includes('_ap')) return 'AccessPoint';
    if (name.includes('switch') || name.includes('sw')) return 'Switch';
    if (name.includes('router') || name.includes('rt')) return 'Router';
    return 'Unknown';
  }

  async getNeighborStats() {
    try {
      const [totalRows, virtualRows, pdvRows] = await Promise.all([
        this.execQuery(`SELECT COUNT(DISTINCT neighbor) as cnt FROM links WHERE neighbor IS NOT NULL`),
        this.execQuery(`
          SELECT COUNT(DISTINCT l.neighbor) as cnt FROM links l
          WHERE l.neighbor IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device = l.neighbor)
        `),
        this.execQuery(`
          SELECT COUNT(DISTINCT l.neighbor) as cnt FROM links l
          WHERE l.neighbor LIKE '%PDV%'
          AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device = l.neighbor)
        `)
      ]);

      return {
        total_neighbors: totalRows[0]?.cnt || 0,
        virtual_neighbors: virtualRows[0]?.cnt || 0,
        pdv_access_points: pdvRows[0]?.cnt || 0
      };
    } catch (err) {
      return { total_neighbors: 0, virtual_neighbors: 0, pdv_access_points: 0 };
    }
  }

  // ============ CLOSE ============

  async close() {
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Clear cache
    this.cache.clear();
    // Close connection pool
    if (this.pool) {
      await this.pool.end();
      console.log('[NeDi] Connection pool chiuso');
    }
  }

  /**
   * Parse SSH query output into array of objects
   * @param {string} output - Raw SSH output from NeDi query
   * @param {Array<string>} columns - Column names
   * @returns {Array<Object>} - Array of objects with column keys
   */
  parseRows(output, columns) {
    if (!output || typeof output !== 'string') {
      return [];
    }

    const lines = output.trim().split('\n');
    const results = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const values = line.split('\t');
      const obj = {};

      columns.forEach((col, idx) => {
        obj[col] = values[idx] || null;
      });

      results.push(obj);
    }

    return results;
  }

  // ============ MAC CACHE SYNC (V3) ============

  /**
   * Fetch tutti i nodes per popolare MacCache
   * Query ottimizzata: filtra porte virtuali, ultimi 7 giorni
   * @returns {Promise<Array>} Array di nodes con info device
   */
  async getAllNodesForCache() {
    const cacheKey = 'allNodesForCache';
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    const sql = `
      SELECT n.mac, n.device, n.ifname, n.vlanid, n.lastseen, n.oui,
             d.devip, d.type, d.vendor, d.location,
             (SELECT COUNT(*) FROM nodes n2
              WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
      FROM nodes n
      LEFT JOIN devices d ON n.device = d.device
      WHERE n.ifname NOT LIKE 'Vlanif%'
        AND n.ifname NOT LIKE 'Vlif%'
        AND n.ifname NOT LIKE 'Vlan%'
        AND n.ifname NOT LIKE 'Loop%'
        AND n.ifname NOT LIKE 'InLoop%'
        AND n.ifname NOT LIKE 'NULL%'
        AND n.ifname NOT LIKE 'null%'
        AND n.ifname NOT LIKE 'MEth%'
        AND n.ifname NOT LIKE 'Stack-Port%'
        AND n.ifname NOT LIKE 'Bridge-Aggregation%'
        AND n.lastseen > UNIX_TIMESTAMP() - 86400 * 7
      ORDER BY n.lastseen DESC
    `;

    try {
      const startTime = Date.now();
      const [rows] = await this.pool.query(sql);
      const duration = Date.now() - startTime;

      console.log(`[NeDi] getAllNodesForCache: ${rows.length} rows in ${duration}ms`);

      // Converti devip da numerico a stringa IP
      const result = rows.map(row => ({
        mac: row.mac,
        device: row.device,
        ifname: row.ifname,
        vlanid: row.vlanid,
        lastseen: row.lastseen,
        oui: row.oui,
        devip: row.devip ? this.longToIp(row.devip) : null,
        type: row.type,
        vendor: row.vendor,
        location: row.location,
        macCount: parseInt(row.macCount) || 1
      }));

      this._cacheSet(cacheKey, result, 60000);  // Cache 1 minuto (sync è ogni 15min)
      return result;

    } catch (err) {
      console.error('[NeDi] Errore getAllNodesForCache:', err.message);
      throw err;
    }
  }

  /**
   * Fetch tutti gli ARP per popolare MacCache
   * Query ottimizzata: ultimi 7 giorni
   * @returns {Promise<Array>} Array di ARP entries
   */
  async getAllArpForCache() {
    const cacheKey = 'allArpForCache';
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    const sql = `
      SELECT mac, nodip, aname, arpdevice, arpifname, ipupdate
      FROM nodarp
      WHERE ipupdate > UNIX_TIMESTAMP() - 86400 * 7
      ORDER BY ipupdate DESC
    `;

    try {
      const startTime = Date.now();
      const [rows] = await this.pool.query(sql);
      const duration = Date.now() - startTime;

      console.log(`[NeDi] getAllArpForCache: ${rows.length} rows in ${duration}ms`);

      this._cacheSet(cacheKey, rows, 60000);  // Cache 1 minuto
      return rows;

    } catch (err) {
      console.error('[NeDi] Errore getAllArpForCache:', err.message);
      throw err;
    }
  }

  /**
   * Fetch tutti i devices per popolare MacCache
   * @returns {Promise<Array>} Array di devices (solo campi necessari)
   */
  async getAllDevicesForCache() {
    const cacheKey = 'allDevicesForCache';
    const cached = this._cacheGet(cacheKey);
    if (cached) return cached;

    const sql = `
      SELECT device, devip
      FROM devices
    `;

    try {
      const startTime = Date.now();
      const [rows] = await this.pool.query(sql);
      const duration = Date.now() - startTime;

      console.log(`[NeDi] getAllDevicesForCache: ${rows.length} rows in ${duration}ms`);

      const result = rows.map(row => ({
        device: row.device,
        devip: row.devip ? this.longToIp(row.devip) : null
      }));

      this._cacheSet(cacheKey, result, 60000);  // Cache 1 minuto
      return result;

    } catch (err) {
      console.error('[NeDi] Errore getAllDevicesForCache:', err.message);
      throw err;
    }
  }
}

// Singleton instance
let instance = null;

export async function getNeDiDB(config) {
  if (!instance) {
    instance = new NeDiDB(config);
    await instance.init();
  }
  return instance;
}

export default NeDiDB;
