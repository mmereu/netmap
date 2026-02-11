import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * Cache class for database query results
 * Extends the caching pattern from MapCache with statistics tracking
 * and memory management specifically designed for database queries
 */
class DatabaseQueryCache {
  /**
   * Create a new DatabaseQueryCache instance
   * @param {Object} options - Configuration options
   * @param {number} options.ttlMs - Time to live in milliseconds (default: 60000)
   * @param {number} options.maxSize - Maximum number of cache entries (default: 1000)
   * @param {number} options.cleanupIntervalMs - Cleanup interval in ms (default: 300000 = 5 min)
   */
  constructor(options = {}) {
    this.ttl = options.ttlMs || 60000; // 60 seconds default
    this.maxSize = options.maxSize || 1000;
    this.cleanupIntervalMs = options.cleanupIntervalMs || 300000; // 5 minutes default

    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      cleanups: 0,
      evictions: 0
    };

    // Start periodic cleanup
    this.cleanupTimer = null;
    this._startCleanupTimer();
  }

  /**
   * Get a cached value by key
   * @param {string} key - Cache key
   * @returns {*} Cached data or null if not found/expired
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry.data;
  }

  /**
   * Set a cached value
   * @param {string} key - Cache key
   * @param {*} data - Data to cache
   */
  set(key, data) {
    // Enforce max size by evicting oldest entry if needed
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this._evictOldest();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    this.stats.sets++;
  }

  /**
   * Clear all cache entries
   */
  clear() {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.invalidations += size;
  }

  /**
   * Invalidate a specific cache entry
   * @param {string} key - Cache key to invalidate
   * @returns {boolean} True if entry was found and deleted
   */
  invalidate(key) {
    const existed = this.cache.has(key);
    if (existed) {
      this.cache.delete(key);
      this.stats.invalidations++;
    }
    return existed;
  }

  /**
   * Invalidate all entries matching a pattern
   * @param {string} pattern - Pattern to match (supports * wildcard at end)
   * @returns {number} Number of entries invalidated
   */
  invalidatePattern(pattern) {
    let count = 0;
    const isPrefix = pattern.endsWith('*');
    const prefix = isPrefix ? pattern.slice(0, -1) : pattern;

    for (const key of this.cache.keys()) {
      if (isPrefix ? key.startsWith(prefix) : key === pattern) {
        this.cache.delete(key);
        this.stats.invalidations++;
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a key exists and is not expired
   * @param {string} key - Cache key
   * @returns {boolean} True if key exists and is valid
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttl,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      invalidations: this.stats.invalidations,
      cleanups: this.stats.cleanups,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(2) + '%' : '0%',
      memoryEstimateKB: this._estimateMemoryUsage()
    };
  }

  /**
   * Reset statistics (useful for monitoring intervals)
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      invalidations: 0,
      cleanups: 0,
      evictions: 0
    };
  }

  /**
   * Get all cache keys (for debugging)
   * @returns {string[]} Array of cache keys
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Clean up expired entries
   * @returns {number} Number of entries removed
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.stats.cleanups++;
    }
    return removed;
  }

  /**
   * Stop the cleanup timer (call before disposing)
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }

  /**
   * Start the periodic cleanup timer
   * @private
   */
  _startCleanupTimer() {
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, this.cleanupIntervalMs);

      // Don't prevent process exit
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  /**
   * Evict the oldest cache entry
   * @private
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
      this.stats.evictions++;
    }
  }

  /**
   * Estimate memory usage in KB
   * @private
   * @returns {number} Estimated memory usage in KB
   */
  _estimateMemoryUsage() {
    let totalSize = 0;

    for (const [key, entry] of this.cache.entries()) {
      // Estimate key size
      totalSize += key.length * 2; // UTF-16 chars

      // Estimate data size (rough approximation)
      try {
        totalSize += JSON.stringify(entry.data).length * 2;
      } catch {
        // If can't stringify, estimate based on typeof
        totalSize += 1024; // Default 1KB estimate for non-serializable
      }

      // Timestamp overhead
      totalSize += 8;
    }

    return Math.round(totalSize / 1024);
  }
}

/**
 * Libreria per gestione database SQLite (stile NeDi)
 */
class NetMapDB {
  /**
   * Create a new NetMapDB instance
   * @param {string} dbPath - Path to the SQLite database file
   * @param {Object} cacheOptions - Options for the query cache
   * @param {number} cacheOptions.ttlMs - Cache TTL in milliseconds (default: 60000)
   * @param {number} cacheOptions.maxSize - Maximum cache entries (default: 100)
   */
  constructor(dbPath = './netmap.db', cacheOptions = {}) {
    this.dbPath = dbPath;
    this.db = null;

    // Initialize query cache for expensive operations
    this.queryCache = new DatabaseQueryCache({
      ttlMs: cacheOptions.ttlMs || 60000, // 60 seconds default
      maxSize: cacheOptions.maxSize || 100,
      cleanupIntervalMs: cacheOptions.cleanupIntervalMs || 300000
    });

    this.init();
  }

  init() {
    // Crea directory se non esiste
    const dir = path.dirname(this.dbPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging per performance
    this.createSchema();
  }

  createSchema() {
    // Tabella devices (dispositivi di rete)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT UNIQUE NOT NULL,
        sysname TEXT,
        sysdesc TEXT,
        sysuptime INTEGER,
        syslocation TEXT,
        vendor TEXT,
        model TEXT,
        os TEXT,
        serial TEXT,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        status TEXT DEFAULT 'active',
        snmp_version TEXT DEFAULT '2c',
        community TEXT,
        notes TEXT,
        level INTEGER DEFAULT 0
      )
    `);

    // Tabella interfaces (interfacce di rete)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interfaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        ifindex INTEGER,
        ifname TEXT,
        ifdescr TEXT,
        iftype INTEGER,
        ifspeed INTEGER,
        ifadminstatus INTEGER,
        ifoperstatus INTEGER,
        ifalias TEXT,
        ifphysaddress TEXT,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        UNIQUE(device_id, ifindex)
      )
    `);

    // Tabella links (collegamenti LLDP/CDP/FDP/EDP)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        local_ifindex INTEGER,
        local_ifname TEXT,
        remote_device_id INTEGER,
        remote_ip TEXT,
        remote_sysname TEXT,
        remote_chassisid TEXT,
        remote_portid TEXT,
        remote_portdesc TEXT,
        protocol TEXT, -- LLDP, CDP, FDP, EDP
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (remote_device_id) REFERENCES devices(id) ON DELETE SET NULL
      )
    `);

    // Tabella nodes (nodi MAC/IP)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mac TEXT NOT NULL,
        ip TEXT,
        device_id INTEGER,
        interface_id INTEGER,
        vlan INTEGER,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        source TEXT, -- ARP, FDB, ND
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE SET NULL
      )
    `);

    // Tabella arp (ARP table)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        interface_id INTEGER,
        ip TEXT NOT NULL,
        mac TEXT NOT NULL,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE SET NULL,
        UNIQUE(device_id, ip)
      )
    `);

    // Tabella fdb (Forwarding Database / MAC table)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fdb (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        interface_id INTEGER,
        mac TEXT NOT NULL,
        vlan INTEGER,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE SET NULL,
        UNIQUE(device_id, mac, vlan)
      )
    `);

    // Tabella vlans
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vlans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        vlan_id INTEGER NOT NULL,
        vlan_name TEXT,
        vlan_status TEXT,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        UNIQUE(device_id, vlan_id)
      )
    `);

    // Tabella monitoring (stato dispositivi)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        status TEXT DEFAULT 'unknown', -- up, down, warning
        latency INTEGER, -- ms
        cpu_usage INTEGER, -- %
        memory_usage INTEGER, -- %
        temperature INTEGER, -- celsius
        last_check INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        UNIQUE(device_id)
      )
    `);

    // Tabella events (eventi/incidenti)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER,
        type TEXT, -- discovery, alert, change, error
        severity TEXT, -- info, warning, error, critical
        message TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
      )
    `);

    // Tabella interface_vlans (VLAN membership per porta)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interface_vlans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interface_id INTEGER NOT NULL,
        vlan_id INTEGER NOT NULL,
        tagged INTEGER DEFAULT 0, -- 0=untagged/access, 1=tagged/trunk
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE CASCADE,
        UNIQUE(interface_id, vlan_id)
      )
    `);

    // Tabella stp_ports (STP port states)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stp_ports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        port_num INTEGER NOT NULL,
        state INTEGER, -- 1=disabled, 2=blocking, 3=listening, 4=learning, 5=forwarding, 6=broken
        priority INTEGER,
        path_cost INTEGER,
        designated_root TEXT,
        designated_bridge TEXT,
        designated_port TEXT,
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        UNIQUE(device_id, port_num)
      )
    `);

    // Tabella lag_groups (Link Aggregation Groups)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lag_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        lag_index INTEGER NOT NULL,
        lag_name TEXT,
        mode TEXT, -- 'lacp', 'static'
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        UNIQUE(device_id, lag_index)
      )
    `);

    // Tabella lag_members (membri LAG)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lag_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lag_id INTEGER NOT NULL,
        interface_id INTEGER NOT NULL,
        FOREIGN KEY (lag_id) REFERENCES lag_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE CASCADE,
        UNIQUE(lag_id, interface_id)
      )
    `);

    // Tabella poe_ports (PoE port info)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poe_ports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interface_id INTEGER NOT NULL,
        admin_enabled INTEGER DEFAULT 1,
        detection_status INTEGER, -- 1=disabled, 2=searching, 3=delivering, 4=fault
        priority TEXT, -- critical, high, low
        power_class INTEGER,
        power_used REAL, -- watts
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE CASCADE,
        UNIQUE(interface_id)
      )
    `);

    // Tabella ip_addresses (IP addresses per device/interface)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id INTEGER NOT NULL,
        interface_id INTEGER,
        ip_address TEXT NOT NULL,
        netmask TEXT,
        ip_type TEXT DEFAULT 'ipv4', -- ipv4, ipv6
        is_primary INTEGER DEFAULT 0,
        firstseen INTEGER DEFAULT (strftime('%s', 'now')),
        lastseen INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
        FOREIGN KEY (interface_id) REFERENCES interfaces(id) ON DELETE SET NULL,
        UNIQUE(device_id, ip_address)
      )
    `);

    // Tabella users (autenticazione)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'viewer', -- viewer, operator, admin
        email TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_login INTEGER,
        active INTEGER DEFAULT 1
      )
    `);

    // Tabella sessions (sessioni utente)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Tabella sites (definizione siti/tenant)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Tabella site_rules (regole matching device -> site)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS site_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL,
        rule_type TEXT NOT NULL,
        rule_value TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
      )
    `);

    // Tabella user_sites (assegnazione utenti a siti)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sites (
        user_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, site_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
      )
    `);

    // Indici per performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);
      CREATE INDEX IF NOT EXISTS idx_devices_sysname ON devices(sysname);
      CREATE INDEX IF NOT EXISTS idx_interfaces_device ON interfaces(device_id);
      CREATE INDEX IF NOT EXISTS idx_links_device ON links(device_id);
      CREATE INDEX IF NOT EXISTS idx_links_remote ON links(remote_device_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_mac ON nodes(mac);
      CREATE INDEX IF NOT EXISTS idx_nodes_ip ON nodes(ip);
      CREATE INDEX IF NOT EXISTS idx_arp_device ON arp(device_id);
      CREATE INDEX IF NOT EXISTS idx_fdb_device ON fdb(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_interface_vlans_interface ON interface_vlans(interface_id);
      CREATE INDEX IF NOT EXISTS idx_stp_ports_device ON stp_ports(device_id);
      CREATE INDEX IF NOT EXISTS idx_lag_groups_device ON lag_groups(device_id);
      CREATE INDEX IF NOT EXISTS idx_poe_ports_interface ON poe_ports(interface_id);
      CREATE INDEX IF NOT EXISTS idx_ip_addresses_device ON ip_addresses(device_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sites_name ON sites(name);
      CREATE INDEX IF NOT EXISTS idx_site_rules_site ON site_rules(site_id);
      CREATE INDEX IF NOT EXISTS idx_site_rules_priority ON site_rules(priority);
      CREATE INDEX IF NOT EXISTS idx_user_sites_user ON user_sites(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sites_site ON user_sites(site_id);
    `);

    // Migration: aggiungi site_id a devices se non esiste
    this.migrateSiteId();
  }

  /**
   * Migration per aggiungere site_id alla tabella devices
   */
  migrateSiteId() {
    try {
      // Verifica se la colonna esiste già
      const tableInfo = this.db.prepare("PRAGMA table_info(devices)").all();
      const hasSiteId = tableInfo.some(col => col.name === 'site_id');

      if (!hasSiteId) {
        this.db.exec(`ALTER TABLE devices ADD COLUMN site_id INTEGER REFERENCES sites(id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_site ON devices(site_id)`);
        console.log('[DB] Migration: added site_id column to devices');
      }
    } catch (err) {
      console.error('[DB] Migration error:', err.message);
    }
  }

  // ========== DEVICES ==========

  /**
   * Insert or update a device
   * @param {Object} device - Device data
   * @param {Object} options - Options for the operation
   * @param {boolean} options.skipCacheInvalidation - Skip cache invalidation (for batch operations)
   * @returns {Object} Result with lastInsertRowid and changes
   */
  upsertDevice(device, options = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO devices (ip, sysname, sysdesc, sysuptime, syslocation, vendor, model, os, serial, snmp_version, community, status, level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET
        sysname = excluded.sysname,
        sysdesc = excluded.sysdesc,
        sysuptime = excluded.sysuptime,
        syslocation = excluded.syslocation,
        vendor = excluded.vendor,
        model = excluded.model,
        os = excluded.os,
        serial = excluded.serial,
        level = excluded.level,
        lastseen = strftime('%s', 'now'),
        status = excluded.status
    `);

    const result = stmt.run(
      device.ip,
      device.sysname || null,
      device.sysdesc || null,
      device.sysuptime || null,
      device.syslocation || null,
      device.vendor || null,
      device.model || null,
      device.os || null,
      device.serial || null,
      device.snmp_version || '2c',
      device.community || null,
      device.status || 'active',
      device.level !== undefined ? device.level : 0
    );

    // Invalidate device cache unless skipped (for batch operations)
    if (!options.skipCacheInvalidation) {
      this.queryCache.invalidate('devices:all');
    }

    // IMPORTANTE: lastInsertRowid funziona solo per INSERT, non per UPDATE
    // Se è un UPDATE (changes > 0 ma lastInsertRowid = 0), recupera l'ID dal database
    if (result.lastInsertRowid === 0 && result.changes > 0 && device.ip) {
      const updatedDevice = this.getDevice(device.ip);
      if (updatedDevice) {
        // Crea un oggetto result modificato con l'ID corretto
        return {
          ...result,
          lastInsertRowid: updatedDevice.id
        };
      }
    }

    return result;
  }

  getDevice(ipOrSysname) {
    // Cerca prima per IP
    let device = this.db.prepare('SELECT * FROM devices WHERE ip = ?').get(ipOrSysname);
    // Se non trovato, cerca per sysname
    if (!device) {
      device = this.db.prepare('SELECT * FROM devices WHERE sysname = ?').get(ipOrSysname);
    }
    return device;
  }

  getAllDevices() {
    return this.db.prepare('SELECT * FROM devices ORDER BY lastseen DESC').all();
  }

  /**
   * Get all devices with caching
   * Cache key: 'devices:all'
   * @returns {Array} Array of device objects
   */
  getCachedAllDevices() {
    const cacheKey = 'devices:all';
    const cached = this.queryCache.get(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const result = this.getAllDevices();
    this.queryCache.set(cacheKey, result);
    return result;
  }

  /**
   * Ottimizzato per large scale: paginazione e filtri
   */
  getDevicesPaginated(options = {}) {
    const { limit = 100, offset = 0, status = null, level = null } = options;

    let query = 'SELECT * FROM devices WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (level !== null) {
      query += ' AND level = ?';
      params.push(level);
    }

    query += ' ORDER BY lastseen DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(query).all(...params);
  }

  /**
   * Count totale devices per paginazione
   */
  getDevicesCount(options = {}) {
    const { status = null, level = null } = options;

    let query = 'SELECT COUNT(*) as total FROM devices WHERE 1=1';
    const params = [];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (level !== null) {
      query += ' AND level = ?';
      params.push(level);
    }

    return this.db.prepare(query).get(...params).total;
  }

  /**
   * Ottieni device senza link (candidati per discovery LLDP via SSH)
   * @param {Object} options - Opzioni filtro
   * @param {string} options.vendor - Filtra per vendor (es: 'Huawei')
   * @param {number} options.limit - Limite risultati (default: 50)
   * @returns {Array} Lista device senza link
   */
  getDevicesWithoutLinks(options = {}) {
    const { vendor = null, limit = 50 } = options;

    // Device senza link: nessuna riga in links con device_id = d.id
    let query = `
      SELECT d.*
      FROM devices d
      WHERE d.ip IS NOT NULL
        AND d.status NOT IN ('virtual', 'inactive', 'deleted')
        AND NOT EXISTS (
          SELECT 1 FROM links l WHERE l.device_id = d.id
        )
    `;
    const params = [];

    if (vendor) {
      query += ' AND d.vendor LIKE ?';
      params.push(`%${vendor}%`);
    }

    query += ' ORDER BY d.lastseen DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(query).all(...params);
  }

  /**
   * Trova device che non hanno link nel database
   * Utile per identificare device isolati o con problemi di discovery LLDP
   * @param {Object} options - Opzioni filtro { vendor: 'Huawei', limit: 100 }
   * @returns {Array} Lista device senza link con dati essenziali
   */
  getDevicesWithZeroLinks(options = {}) {
    const { vendor = null, limit = null } = options;

    // Query base: device senza link (non presenti in links.device_id)
    let query = `
      SELECT d.id, d.ip, d.sysname, d.vendor, d.model, d.syslocation, d.status, d.lastseen
      FROM devices d
      WHERE d.id NOT IN (SELECT DISTINCT device_id FROM links WHERE device_id IS NOT NULL)
    `;
    const params = [];

    // Escludi device virtuali/inattivi (status = 'virtual' o simili)
    query += ` AND d.status NOT IN ('virtual', 'inactive', 'deleted')`;

    // Filtro opzionale per vendor (LIKE case-insensitive)
    if (vendor) {
      query += ' AND d.vendor LIKE ?';
      params.push(`%${vendor}%`);
    }

    // Ordinamento per sysname (NULL ultimi)
    query += ' ORDER BY d.sysname COLLATE NOCASE';

    // Limite opzionale
    if (limit !== null && limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    return this.db.prepare(query).all(...params);
  }

  // ========== INTERFACES ==========

  /**
   * Insert or update an interface
   * @param {Object} iface - Interface data
   * @param {Object} options - Options for the operation
   * @param {boolean} options.skipCacheInvalidation - Skip cache invalidation (for batch operations)
   * @returns {Object} Result with lastInsertRowid and changes
   */
  upsertInterface(iface, options = {}) {
    const stmt = this.db.prepare(`
      INSERT INTO interfaces (device_id, ifindex, ifname, ifdescr, iftype, ifspeed, ifadminstatus, ifoperstatus, ifalias, ifphysaddress)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, ifindex) DO UPDATE SET
        ifname = excluded.ifname,
        ifdescr = excluded.ifdescr,
        iftype = excluded.iftype,
        ifspeed = excluded.ifspeed,
        ifadminstatus = excluded.ifadminstatus,
        ifoperstatus = excluded.ifoperstatus,
        ifalias = excluded.ifalias,
        ifphysaddress = excluded.ifphysaddress,
        lastseen = strftime('%s', 'now')
    `);

    const result = stmt.run(
      iface.device_id,
      iface.ifindex,
      iface.ifname || null,
      iface.ifdescr || null,
      iface.iftype || null,
      iface.ifspeed || null,
      iface.ifadminstatus || null,
      iface.ifoperstatus || null,
      iface.ifalias || null,
      iface.ifphysaddress || null
    );

    // Invalidate interfaces cache for this device unless skipped (for batch operations)
    if (!options.skipCacheInvalidation && iface.device_id) {
      this.queryCache.invalidate(`interfaces:device:${iface.device_id}`);
    }

    return result;
  }

  getDeviceInterfaces(deviceId) {
    return this.db.prepare('SELECT * FROM interfaces WHERE device_id = ? ORDER BY ifindex').all(deviceId);
  }

  /**
   * Get device interfaces with caching
   * Cache key: 'interfaces:device:{deviceId}'
   * @param {number} deviceId - The device ID
   * @returns {Array} Array of interface objects
   */
  getCachedDeviceInterfaces(deviceId) {
    const cacheKey = `interfaces:device:${deviceId}`;
    const cached = this.queryCache.get(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const result = this.getDeviceInterfaces(deviceId);
    this.queryCache.set(cacheKey, result);
    return result;
  }

  // ========== LINKS ==========

  /**
   * Insert or update a link
   * @param {Object} link - Link data
   * @param {Object} options - Options for the operation
   * @param {boolean} options.skipCacheInvalidation - Skip cache invalidation (for batch operations)
   * @returns {Object} Result with lastInsertRowid and changes
   */
  upsertLink(link, options = {}) {
    // METODO NEDI: Cerca link esistente con priorità:
    // 1. device_id + local_ifindex + remote_device_id (se disponibile)
    // 2. device_id + local_ifindex + remote_chassisid + remote_portid (se disponibili)
    // 3. device_id + local_ifindex + remote_ip (se disponibile)
    // 4. device_id + local_ifindex + remote_sysname (se disponibile)
    // 5. device_id + local_ifindex (ultimo caso, per link senza dati remoti)
    let existing = null;

    // PRIORITÀ 1: remote_device_id (device già matchato)
    if (link.remote_device_id) {
      existing = this.db.prepare(`
        SELECT id FROM links 
        WHERE device_id = ? AND local_ifindex = ? AND remote_device_id = ?
      `).get(
        link.device_id,
        link.local_ifindex || null,
        link.remote_device_id
      );
    }

    // PRIORITÀ 2: chassisid + portid (identificazione univoca LLDP)
    if (!existing && link.remote_chassisid && link.remote_portid) {
      existing = this.db.prepare(`
        SELECT id FROM links 
        WHERE device_id = ? AND local_ifindex = ? AND remote_chassisid = ? AND remote_portid = ?
      `).get(
        link.device_id,
        link.local_ifindex || null,
        link.remote_chassisid,
        link.remote_portid
      );
    }

    // PRIORITÀ 3: remote_ip (se disponibile)
    if (!existing && link.remote_ip) {
      existing = this.db.prepare(`
        SELECT id FROM links 
        WHERE device_id = ? AND local_ifindex = ? AND remote_ip = ?
      `).get(
        link.device_id,
        link.local_ifindex || null,
        link.remote_ip
      );
    }

    // PRIORITÀ 4: remote_sysname (se disponibile)
    if (!existing && link.remote_sysname) {
      existing = this.db.prepare(`
        SELECT id FROM links 
        WHERE device_id = ? AND local_ifindex = ? AND remote_sysname = ?
      `).get(
        link.device_id,
        link.local_ifindex || null,
        link.remote_sysname
      );
    }

    // PRIORITÀ 5: solo device_id + local_ifindex (link senza dati remoti)
    // ATTENZIONE: Questo può creare duplicati se ci sono più link sulla stessa interfaccia
    // Ma è necessario per link senza dati remoti (es. interfacce non connesse)
    // NeDi gestisce questo caso creando un link per ogni neighbor discovery
    if (!existing && link.local_ifindex) {
      // Cerca link esistente sulla stessa interfaccia senza dati remoti
      // Solo se anche il link esistente non ha dati remoti
      existing = this.db.prepare(`
        SELECT id FROM links 
        WHERE device_id = ? AND local_ifindex = ? 
        AND (remote_device_id IS NULL OR remote_device_id = '')
        AND (remote_ip IS NULL OR remote_ip = '')
        AND (remote_sysname IS NULL OR remote_sysname = '')
        AND (remote_chassisid IS NULL OR remote_chassisid = '')
        AND (remote_portid IS NULL OR remote_portid = '')
        LIMIT 1
      `).get(
        link.device_id,
        link.local_ifindex
      );
    }

    // Recupera local_ifname dalla tabella interfaces se non fornito
    let localIfname = link.local_ifname;
    if (!localIfname && link.device_id && link.local_ifindex) {
      const iface = this.db.prepare(`
        SELECT ifname FROM interfaces 
        WHERE device_id = ? AND ifindex = ?
      `).get(link.device_id, link.local_ifindex);
      if (iface) {
        localIfname = iface.ifname;
      }
    }

    if (existing) {
      // Aggiorna lastseen e remote_device_id se non era presente o è cambiato
      // Aggiorna solo se il nuovo valore non è NULL
      const updateFields = ['lastseen = strftime(\'%s\', \'now\')'];
      const updateValues = [];

      if (localIfname != null) {
        updateFields.push('local_ifname = ?');
        updateValues.push(localIfname);
      }
      if (link.remote_device_id != null) {
        updateFields.push('remote_device_id = ?');
        updateValues.push(link.remote_device_id);
      }
      if (link.remote_ip != null) {
        updateFields.push('remote_ip = ?');
        updateValues.push(link.remote_ip);
      }
      if (link.remote_sysname != null) {
        updateFields.push('remote_sysname = ?');
        updateValues.push(link.remote_sysname);
      }
      if (link.remote_portid != null) {
        updateFields.push('remote_portid = ?');
        updateValues.push(link.remote_portid);
      }
      if (link.remote_portdesc != null) {
        updateFields.push('remote_portdesc = ?');
        updateValues.push(link.remote_portdesc);
      }

      updateValues.push(existing.id);

      this.db.prepare(`
        UPDATE links SET ${updateFields.join(', ')}
        WHERE id = ?
      `).run(...updateValues);

      // Invalidate links cache unless skipped (for batch operations)
      if (!options.skipCacheInvalidation) {
        this.queryCache.invalidatePattern('links:*');
      }

      return { lastInsertRowid: existing.id, changes: 0 };
    }

    // Inserisci nuovo
    const stmt = this.db.prepare(`
      INSERT INTO links (device_id, local_ifindex, local_ifname, remote_device_id, remote_ip, remote_sysname, remote_chassisid, remote_portid, remote_portdesc, protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      link.device_id,
      link.local_ifindex || null,
      localIfname || null,
      link.remote_device_id || null,
      link.remote_ip || null,
      link.remote_sysname || null,
      link.remote_chassisid || null,
      link.remote_portid || null,
      link.remote_portdesc || null,
      link.protocol || 'LLDP'
    );

    // Invalidate links cache unless skipped (for batch operations)
    if (!options.skipCacheInvalidation) {
      this.queryCache.invalidatePattern('links:*');
    }

    return result;
  }

  getDeviceLinks(deviceId) {
    return this.db.prepare(`
      SELECT l.*, d.ip as remote_device_ip, d.sysname as remote_device_sysname
      FROM links l
      LEFT JOIN devices d ON l.remote_device_id = d.id
      WHERE l.device_id = ?
      ORDER BY l.lastseen DESC
    `).all(deviceId);
  }

  getAllLinks() {
    return this.db.prepare(`
      SELECT l.*,
        d1.ip as local_ip, d1.sysname as local_sysname,
        d2.ip as remote_device_ip, d2.sysname as remote_device_sysname
      FROM links l
      LEFT JOIN devices d1 ON l.device_id = d1.id
      LEFT JOIN devices d2 ON l.remote_device_id = d2.id
      ORDER BY l.lastseen DESC
    `).all();
  }

  /**
   * Get all links with caching
   * Cache key: 'links:all'
   * @returns {Array} Array of link objects with device info
   */
  getCachedAllLinks() {
    const cacheKey = 'links:all';
    const cached = this.queryCache.get(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const result = this.getAllLinks();
    this.queryCache.set(cacheKey, result);
    return result;
  }

  /**
   * Ottimizzato per large scale: paginazione
   */
  getLinksPaginated(options = {}) {
    const { limit = 200, offset = 0 } = options;

    return this.db.prepare(`
      SELECT l.*,
        d1.ip as local_ip, d1.sysname as local_sysname, d1.level as local_level,
        d2.ip as remote_device_ip, d2.sysname as remote_device_sysname, d2.level as remote_level,
        i.ifspeed as speed
      FROM links l
      LEFT JOIN devices d1 ON l.device_id = d1.id
      LEFT JOIN devices d2 ON l.remote_device_id = d2.id
      LEFT JOIN interfaces i ON l.device_id = i.device_id AND l.local_ifindex = i.ifindex
      WHERE l.remote_device_id IS NOT NULL
      ORDER BY l.lastseen DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /**
   * Count totale links per paginazione
   */
  getLinksCount() {
    return this.db.prepare('SELECT COUNT(*) as total FROM links WHERE remote_device_id IS NOT NULL').get().total;
  }

  /**
   * Query ottimizzata per mappa: solo link completi con dati essenziali
   */
  getLinksForMap() {
    return this.db.prepare(`
      SELECT l.id,
        l.device_id, l.remote_device_id,
        COALESCE(l.local_ifname, i.ifname, i.ifdescr) as di,
        COALESCE(l.remote_portdesc, l.remote_portid) as ni,
        l.protocol,
        d1.ip as local_ip, d1.sysname as local_sysname,
        d2.ip as remote_device_ip, d2.sysname as remote_device_sysname,
        COALESCE(i.ifspeed, 1000) as speed
      FROM links l
      INNER JOIN devices d1 ON l.device_id = d1.id
      INNER JOIN devices d2 ON l.remote_device_id = d2.id
      LEFT JOIN interfaces i ON l.device_id = i.device_id AND l.local_ifindex = i.ifindex
      WHERE l.remote_device_id IS NOT NULL
      ORDER BY l.lastseen DESC
    `).all();
  }

  /**
   * Ottiene link orfani (senza remote_device_id) per processing
   * Query ottimizzata con indice su remote_device_id
   */
  getOrphanLinks() {
    return this.db.prepare(`
      SELECT l.*, 
        d.ip as local_ip, d.sysname as local_sysname
      FROM links l
      INNER JOIN devices d ON l.device_id = d.id
      WHERE l.remote_device_id IS NULL
        AND (l.remote_sysname IS NOT NULL OR l.remote_ip IS NOT NULL OR l.remote_chassisid IS NOT NULL)
      ORDER BY l.lastseen DESC
    `).all();
  }

  /**
   * Ottiene link completi (con remote_device_id) per mappa
   * Query ottimizzata per rendering veloce
   */
  getCompleteLinks() {
    return this.db.prepare(`
      SELECT l.*, 
        d1.ip as local_ip, d1.sysname as local_sysname,
        d2.ip as remote_device_ip, d2.sysname as remote_device_sysname
      FROM links l
      INNER JOIN devices d1 ON l.device_id = d1.id
      INNER JOIN devices d2 ON l.remote_device_id = d2.id
      WHERE l.remote_device_id IS NOT NULL
      ORDER BY l.lastseen DESC
    `).all();
  }

  // ========== NODES ==========

  upsertNode(node) {
    const stmt = this.db.prepare(`
      INSERT INTO nodes (mac, ip, device_id, interface_id, vlan, source)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        ip = excluded.ip,
        device_id = excluded.device_id,
        interface_id = excluded.interface_id,
        vlan = excluded.vlan,
        lastseen = strftime('%s', 'now')
    `);

    return stmt.run(
      node.mac,
      node.ip || null,
      node.device_id || null,
      node.interface_id || null,
      node.vlan || null,
      node.source || 'unknown'
    );
  }

  // ========== ARP ==========

  upsertARP(arp) {
    const stmt = this.db.prepare(`
      INSERT INTO arp (device_id, interface_id, ip, mac)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, ip) DO UPDATE SET
        mac = excluded.mac,
        interface_id = excluded.interface_id,
        lastseen = strftime('%s', 'now')
    `);

    return stmt.run(arp.device_id, arp.interface_id || null, arp.ip, arp.mac);
  }

  // ========== FDB ==========

  upsertFDB(fdb) {
    const stmt = this.db.prepare(`
      INSERT INTO fdb (device_id, interface_id, mac, vlan)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, mac, vlan) DO UPDATE SET
        interface_id = excluded.interface_id,
        lastseen = strftime('%s', 'now')
    `);

    return stmt.run(fdb.device_id, fdb.interface_id || null, fdb.mac, fdb.vlan || 0);
  }

  // ========== EVENTS ==========

  addEvent(event) {
    const stmt = this.db.prepare(`
      INSERT INTO events (device_id, type, severity, message)
      VALUES (?, ?, ?, ?)
    `);

    return stmt.run(
      event.device_id || null,
      event.type || 'info',
      event.severity || 'info',
      event.message || ''
    );
  }

  getEvents(limit = 100) {
    return this.db.prepare(`
      SELECT e.*, d.ip, d.sysname
      FROM events e
      LEFT JOIN devices d ON e.device_id = d.id
      ORDER BY e.timestamp DESC
      LIMIT ?
    `).all(limit);
  }

  // ========== MONITORING ==========

  upsertMonitoring(monitoring) {
    const stmt = this.db.prepare(`
      INSERT INTO monitoring (device_id, status, latency, cpu_usage, memory_usage, temperature)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        status = excluded.status,
        latency = excluded.latency,
        cpu_usage = excluded.cpu_usage,
        memory_usage = excluded.memory_usage,
        temperature = excluded.temperature,
        last_check = strftime('%s', 'now')
    `);

    return stmt.run(
      monitoring.device_id,
      monitoring.status || 'unknown',
      monitoring.latency || null,
      monitoring.cpu_usage || null,
      monitoring.memory_usage || null,
      monitoring.temperature || null
    );
  }

  // ========== INTERFACE VLANS ==========

  upsertInterfaceVLAN(data) {
    const stmt = this.db.prepare(`
      INSERT INTO interface_vlans (interface_id, vlan_id, tagged)
      VALUES (?, ?, ?)
      ON CONFLICT(interface_id, vlan_id) DO UPDATE SET
        tagged = excluded.tagged
    `);
    return stmt.run(data.interface_id, data.vlan_id, data.tagged ? 1 : 0);
  }

  getInterfaceVLANs(interfaceId) {
    return this.db.prepare(`
      SELECT iv.*, v.vlan_name
      FROM interface_vlans iv
      LEFT JOIN vlans v ON iv.vlan_id = v.vlan_id
      WHERE iv.interface_id = ?
    `).all(interfaceId);
  }

  // ========== STP PORTS ==========

  upsertSTPPort(data) {
    const stmt = this.db.prepare(`
      INSERT INTO stp_ports (device_id, port_num, state, priority, path_cost, designated_root, designated_bridge, designated_port)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, port_num) DO UPDATE SET
        state = excluded.state,
        priority = excluded.priority,
        path_cost = excluded.path_cost,
        designated_root = excluded.designated_root,
        designated_bridge = excluded.designated_bridge,
        designated_port = excluded.designated_port,
        lastseen = strftime('%s', 'now')
    `);
    return stmt.run(
      data.device_id, data.port_num, data.state || null,
      data.priority || null, data.path_cost || null,
      data.designated_root || null, data.designated_bridge || null,
      data.designated_port || null
    );
  }

  getDeviceSTPPorts(deviceId) {
    return this.db.prepare('SELECT * FROM stp_ports WHERE device_id = ? ORDER BY port_num').all(deviceId);
  }

  // ========== LAG GROUPS ==========

  upsertLAGGroup(data) {
    const stmt = this.db.prepare(`
      INSERT INTO lag_groups (device_id, lag_index, lag_name, mode)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, lag_index) DO UPDATE SET
        lag_name = excluded.lag_name,
        mode = excluded.mode,
        lastseen = strftime('%s', 'now')
    `);
    return stmt.run(data.device_id, data.lag_index, data.lag_name || null, data.mode || 'lacp');
  }

  addLAGMember(lagId, interfaceId) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO lag_members (lag_id, interface_id)
      VALUES (?, ?)
    `);
    return stmt.run(lagId, interfaceId);
  }

  getDeviceLAGs(deviceId) {
    return this.db.prepare(`
      SELECT lg.*, GROUP_CONCAT(lm.interface_id) as member_interfaces
      FROM lag_groups lg
      LEFT JOIN lag_members lm ON lg.id = lm.lag_id
      WHERE lg.device_id = ?
      GROUP BY lg.id
    `).all(deviceId);
  }

  // ========== POE PORTS ==========

  upsertPoEPort(data) {
    const stmt = this.db.prepare(`
      INSERT INTO poe_ports (interface_id, admin_enabled, detection_status, priority, power_class, power_used)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(interface_id) DO UPDATE SET
        admin_enabled = excluded.admin_enabled,
        detection_status = excluded.detection_status,
        priority = excluded.priority,
        power_class = excluded.power_class,
        power_used = excluded.power_used,
        lastseen = strftime('%s', 'now')
    `);
    return stmt.run(
      data.interface_id, data.admin_enabled ? 1 : 0,
      data.detection_status || null, data.priority || null,
      data.power_class || null, data.power_used || null
    );
  }

  getDevicePoEPorts(deviceId) {
    return this.db.prepare(`
      SELECT pp.*, i.ifindex, i.ifname, i.ifdescr
      FROM poe_ports pp
      JOIN interfaces i ON pp.interface_id = i.id
      WHERE i.device_id = ?
    `).all(deviceId);
  }

  // ========== IP ADDRESSES ==========

  upsertIPAddress(data) {
    const stmt = this.db.prepare(`
      INSERT INTO ip_addresses (device_id, interface_id, ip_address, netmask, ip_type, is_primary)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, ip_address) DO UPDATE SET
        interface_id = excluded.interface_id,
        netmask = excluded.netmask,
        ip_type = excluded.ip_type,
        is_primary = excluded.is_primary,
        lastseen = strftime('%s', 'now')
    `);
    return stmt.run(
      data.device_id, data.interface_id || null,
      data.ip_address, data.netmask || null,
      data.ip_type || 'ipv4', data.is_primary ? 1 : 0
    );
  }

  getDeviceIPAddresses(deviceId) {
    return this.db.prepare(`
      SELECT ipa.*, i.ifindex, i.ifname
      FROM ip_addresses ipa
      LEFT JOIN interfaces i ON ipa.interface_id = i.id
      WHERE ipa.device_id = ?
      ORDER BY ipa.is_primary DESC, ipa.ip_type, ipa.ip_address
    `).all(deviceId);
  }

  // ========== USERS & AUTH ==========

  createUser(data) {
    const stmt = this.db.prepare(`
      INSERT INTO users (username, password_hash, role, email)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(data.username, data.password_hash, data.role || 'viewer', data.email || null);
  }

  getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  }

  getUserById(id) {
    return this.db.prepare('SELECT id, username, role, email, created_at, last_login FROM users WHERE id = ? AND active = 1').get(id);
  }

  updateUserLastLogin(userId) {
    return this.db.prepare('UPDATE users SET last_login = strftime(\'%s\', \'now\') WHERE id = ?').run(userId);
  }

  getAllUsers() {
    return this.db.prepare('SELECT id, username, role, email, created_at, last_login, active FROM users ORDER BY username').all();
  }

  updateUser(userId, data) {
    const fields = [];
    const values = [];
    if (data.role !== undefined) { fields.push('role = ?'); values.push(data.role); }
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
    if (data.password_hash !== undefined) { fields.push('password_hash = ?'); values.push(data.password_hash); }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }

    if (fields.length === 0) return null;
    values.push(userId);

    return this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  // ========== SESSIONS ==========

  createSession(userId, token, expiresInSeconds = 86400) {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const stmt = this.db.prepare(`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `);
    return stmt.run(userId, token, expiresAt);
  }

  getSessionByToken(token) {
    const now = Math.floor(Date.now() / 1000);
    return this.db.prepare(`
      SELECT s.*, u.username, u.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
    `).get(token, now);
  }

  deleteSession(token) {
    return this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  cleanupExpiredSessions() {
    const now = Math.floor(Date.now() / 1000);
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  // ========== SITES & MULTI-TENANT ==========

  // --- Sites CRUD ---

  createSite(data) {
    const stmt = this.db.prepare(`
      INSERT INTO sites (name, description)
      VALUES (?, ?)
    `);
    return stmt.run(data.name, data.description || null);
  }

  getSiteById(id) {
    return this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  }

  getSiteByName(name) {
    return this.db.prepare('SELECT * FROM sites WHERE name = ?').get(name);
  }

  getAllSites() {
    return this.db.prepare('SELECT * FROM sites ORDER BY name').all();
  }

  getAllSitesWithStats() {
    return this.db.prepare(`
      SELECT
        s.*,
        COUNT(DISTINCT d.id) as device_count,
        COUNT(DISTINCT us.user_id) as user_count
      FROM sites s
      LEFT JOIN devices d ON d.site_id = s.id
      LEFT JOIN user_sites us ON us.site_id = s.id
      GROUP BY s.id
      ORDER BY s.name
    `).all();
  }

  updateSite(id, data) {
    const fields = [];
    const values = [];
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }

    if (fields.length === 0) return null;
    values.push(id);

    return this.db.prepare(`UPDATE sites SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSite(id) {
    // Prima rimuovi assegnazioni device
    this.db.prepare('UPDATE devices SET site_id = NULL WHERE site_id = ?').run(id);
    return this.db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  }

  // --- Site Rules CRUD ---

  createSiteRule(siteId, data) {
    const stmt = this.db.prepare(`
      INSERT INTO site_rules (site_id, rule_type, rule_value, priority)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(siteId, data.rule_type, data.rule_value, data.priority || 0);
  }

  getSiteRules(siteId) {
    return this.db.prepare(`
      SELECT * FROM site_rules
      WHERE site_id = ?
      ORDER BY priority DESC
    `).all(siteId);
  }

  getAllSiteRules() {
    return this.db.prepare(`
      SELECT sr.*, s.name as site_name
      FROM site_rules sr
      JOIN sites s ON sr.site_id = s.id
      ORDER BY sr.priority DESC
    `).all();
  }

  updateSiteRule(id, data) {
    const fields = [];
    const values = [];
    if (data.rule_type !== undefined) { fields.push('rule_type = ?'); values.push(data.rule_type); }
    if (data.rule_value !== undefined) { fields.push('rule_value = ?'); values.push(data.rule_value); }
    if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority); }

    if (fields.length === 0) return null;
    values.push(id);

    return this.db.prepare(`UPDATE site_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSiteRule(id) {
    return this.db.prepare('DELETE FROM site_rules WHERE id = ?').run(id);
  }

  // --- User-Site Assignments ---

  getUserSites(userId) {
    return this.db.prepare(`
      SELECT s.*
      FROM sites s
      JOIN user_sites us ON us.site_id = s.id
      WHERE us.user_id = ?
      ORDER BY s.name
    `).all(userId);
  }

  getSiteUsers(siteId) {
    return this.db.prepare(`
      SELECT u.id, u.username, u.role, u.email
      FROM users u
      JOIN user_sites us ON us.user_id = u.id
      WHERE us.site_id = ?
      ORDER BY u.username
    `).all(siteId);
  }

  setUserSites(userId, siteIds) {
    // Rimuovi assegnazioni esistenti
    this.db.prepare('DELETE FROM user_sites WHERE user_id = ?').run(userId);

    // Aggiungi nuove assegnazioni
    if (siteIds && siteIds.length > 0) {
      const stmt = this.db.prepare('INSERT INTO user_sites (user_id, site_id) VALUES (?, ?)');
      for (const siteId of siteIds) {
        stmt.run(userId, siteId);
      }
    }
    return { changes: siteIds ? siteIds.length : 0 };
  }

  addUserToSite(userId, siteId) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO user_sites (user_id, site_id)
      VALUES (?, ?)
    `);
    return stmt.run(userId, siteId);
  }

  removeUserFromSite(userId, siteId) {
    return this.db.prepare('DELETE FROM user_sites WHERE user_id = ? AND site_id = ?').run(userId, siteId);
  }

  // --- Device-Site Assignment ---

  getDevicesBySite(siteId) {
    return this.db.prepare(`
      SELECT * FROM devices
      WHERE site_id = ?
      ORDER BY sysname
    `).all(siteId);
  }

  getDevicesBySites(siteIds) {
    if (!siteIds || siteIds.length === 0) return [];
    const placeholders = siteIds.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM devices
      WHERE site_id IN (${placeholders})
      ORDER BY sysname
    `).all(...siteIds);
  }

  getUnassignedDevices() {
    return this.db.prepare(`
      SELECT * FROM devices
      WHERE site_id IS NULL
      ORDER BY sysname
    `).all();
  }

  assignDeviceToSite(deviceId, siteId) {
    return this.db.prepare('UPDATE devices SET site_id = ? WHERE id = ?').run(siteId, deviceId);
  }

  // --- Site Matching Logic ---

  /**
   * Verifica se un IP è contenuto in un CIDR range
   * @param {string} ip - IP address (es. "10.1.2.3")
   * @param {string} cidr - CIDR notation (es. "10.1.0.0/16")
   * @returns {boolean}
   */
  _ipMatchesCidr(ip, cidr) {
    try {
      const [range, bits] = cidr.split('/');
      const mask = bits ? parseInt(bits, 10) : 32;

      const ipNum = this._ipToNumber(ip);
      const rangeNum = this._ipToNumber(range);

      if (ipNum === null || rangeNum === null) return false;

      const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
      return (ipNum & maskNum) === (rangeNum & maskNum);
    } catch {
      return false;
    }
  }

  /**
   * Converte IP string in numero
   * @param {string} ip
   * @returns {number|null}
   */
  _ipToNumber(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    let num = 0;
    for (let i = 0; i < 4; i++) {
      const octet = parseInt(parts[i], 10);
      if (isNaN(octet) || octet < 0 || octet > 255) return null;
      num = (num << 8) + octet;
    }
    return num >>> 0;
  }

  /**
   * Trova il sito che matcha un device basandosi sulle regole
   * @param {Object} device - Device con ip e syslocation
   * @returns {number|null} - site_id o null se nessun match
   */
  matchDeviceToSite(device) {
    const rules = this.getAllSiteRules();

    for (const rule of rules) {
      let matches = false;

      switch (rule.rule_type) {
        case 'cidr':
          if (device.ip) {
            matches = this._ipMatchesCidr(device.ip, rule.rule_value);
          }
          break;

        case 'ip_range':
          // Formato: "10.1.0.1-10.1.255.254"
          if (device.ip) {
            const [startIp, endIp] = rule.rule_value.split('-');
            const ipNum = this._ipToNumber(device.ip);
            const startNum = this._ipToNumber(startIp);
            const endNum = this._ipToNumber(endIp);
            if (ipNum !== null && startNum !== null && endNum !== null) {
              matches = ipNum >= startNum && ipNum <= endNum;
            }
          }
          break;

        case 'pattern':
          // Pattern su syslocation (SQL LIKE style, convertito a regex)
          if (device.syslocation) {
            const regexPattern = rule.rule_value
              .replace(/%/g, '.*')
              .replace(/_/g, '.');
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            matches = regex.test(device.syslocation);
          }
          break;

        case 'sysname_pattern':
          // Pattern su sysname
          if (device.sysname) {
            const regexPattern = rule.rule_value
              .replace(/%/g, '.*')
              .replace(/_/g, '.');
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            matches = regex.test(device.sysname);
          }
          break;
      }

      if (matches) {
        return rule.site_id;
      }
    }

    return null; // Nessun match
  }

  /**
   * Ricalcola assegnazioni per tutti i device
   * @returns {Object} Statistiche: { total, assigned, unassigned, bysite }
   */
  reassignAllDevices() {
    const devices = this.getAllDevices();
    const stats = { total: 0, assigned: 0, unassigned: 0, bysite: {} };

    const updateStmt = this.db.prepare('UPDATE devices SET site_id = ? WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const device of devices) {
        stats.total++;
        const siteId = this.matchDeviceToSite(device);

        updateStmt.run(siteId, device.id);

        if (siteId) {
          stats.assigned++;
          stats.bysite[siteId] = (stats.bysite[siteId] || 0) + 1;
        } else {
          stats.unassigned++;
        }
      }
    });

    transaction();

    // Invalida cache se presente
    if (this.queryCache) {
      this.queryCache.invalidatePattern('devices*');
    }

    return stats;
  }

  /**
   * Preview assegnazioni senza modificare il database
   * @returns {Array} Lista di { device, matched_site, matched_rule }
   */
  previewSiteAssignments() {
    const devices = this.getAllDevices();
    const rules = this.getAllSiteRules();
    const sites = this.getAllSites();
    const siteMap = new Map(sites.map(s => [s.id, s]));

    const preview = [];

    for (const device of devices) {
      let matchedSite = null;
      let matchedRule = null;

      for (const rule of rules) {
        let matches = false;

        switch (rule.rule_type) {
          case 'cidr':
            if (device.ip) matches = this._ipMatchesCidr(device.ip, rule.rule_value);
            break;
          case 'ip_range':
            if (device.ip) {
              const [startIp, endIp] = rule.rule_value.split('-');
              const ipNum = this._ipToNumber(device.ip);
              const startNum = this._ipToNumber(startIp);
              const endNum = this._ipToNumber(endIp);
              if (ipNum !== null && startNum !== null && endNum !== null) {
                matches = ipNum >= startNum && ipNum <= endNum;
              }
            }
            break;
          case 'pattern':
            if (device.syslocation) {
              const regexPattern = rule.rule_value.replace(/%/g, '.*').replace(/_/g, '.');
              matches = new RegExp(`^${regexPattern}$`, 'i').test(device.syslocation);
            }
            break;
          case 'sysname_pattern':
            if (device.sysname) {
              const regexPattern = rule.rule_value.replace(/%/g, '.*').replace(/_/g, '.');
              matches = new RegExp(`^${regexPattern}$`, 'i').test(device.sysname);
            }
            break;
        }

        if (matches) {
          matchedSite = siteMap.get(rule.site_id);
          matchedRule = rule;
          break;
        }
      }

      preview.push({
        device_id: device.id,
        device_ip: device.ip,
        device_sysname: device.sysname,
        device_syslocation: device.syslocation,
        current_site_id: device.site_id,
        matched_site_id: matchedSite?.id || null,
        matched_site_name: matchedSite?.name || null,
        matched_rule: matchedRule ? {
          id: matchedRule.id,
          type: matchedRule.rule_type,
          value: matchedRule.rule_value
        } : null
      });
    }

    return preview;
  }

  // ========== NEIGHBOR RESOLUTION (METODO NEDI) ==========

  /**
   * Risolvi neighbor Unknown usando multiple strategie (stile NeDi)
   * 1. ChassisId come MAC → cerca in ifPhysAddress
   * 2. ChassisId come IP → cerca per IP
   * 3. Cross-reference ARP → MAC → IP → Device
   * 4. Cross-reference FDB → MAC → Device
   */
  resolveUnknownNeighbors() {
    const links = this.getAllLinks();
    let resolved = 0;
    let checked = 0;

    for (const link of links) {
      // Salta link già risolti
      if (link.remote_device_id) continue;
      checked++;

      let resolvedDevice = null;

      // STRATEGIA 1: ChassisId come MAC → cerca in ifPhysAddress
      if (link.remote_chassisid && /^[0-9a-fA-F:.-]{12,17}$/.test(link.remote_chassisid)) {
        // Normalizza MAC (rimuovi separatori, lowercase)
        const normalizedMAC = link.remote_chassisid.replace(/[:.|-]/g, '').toLowerCase();

        // Cerca interface con questo MAC
        const iface = this.db.prepare(`
          SELECT i.*, d.id as device_id, d.ip, d.sysname
          FROM interfaces i
          JOIN devices d ON i.device_id = d.id
          WHERE REPLACE(REPLACE(REPLACE(LOWER(i.ifphysaddress), ':', ''), '.', ''), '-', '') = ?
          LIMIT 1
        `).get(normalizedMAC);

        if (iface) {
          resolvedDevice = { id: iface.device_id, ip: iface.ip, sysname: iface.sysname };
          console.log(`[RESOLVE] ChassisId MAC ${link.remote_chassisid} → Device ${iface.sysname || iface.ip}`);
        }
      }

      // STRATEGIA 2: ChassisId come IP → cerca per IP
      if (!resolvedDevice && link.remote_chassisid && /^\d+\.\d+\.\d+\.\d+$/.test(link.remote_chassisid)) {
        const device = this.getDevice(link.remote_chassisid);
        if (device) {
          resolvedDevice = device;
          console.log(`[RESOLVE] ChassisId IP ${link.remote_chassisid} → Device ${device.sysname || device.ip}`);
        }
      }

      // STRATEGIA 3: Cross-reference ARP (MAC → IP → Device)
      if (!resolvedDevice && link.remote_chassisid && /^[0-9a-fA-F:.-]{12,17}$/.test(link.remote_chassisid)) {
        const normalizedMAC = link.remote_chassisid.replace(/[:.|-]/g, '').toLowerCase();

        // Cerca in ARP table
        const arpEntry = this.db.prepare(`
          SELECT a.ip, d.id as device_id, d.sysname
          FROM arp a
          JOIN devices d ON a.ip = d.ip
          WHERE REPLACE(REPLACE(REPLACE(LOWER(a.mac), ':', ''), '.', ''), '-', '') = ?
          LIMIT 1
        `).get(normalizedMAC);

        if (arpEntry) {
          resolvedDevice = { id: arpEntry.device_id, ip: arpEntry.ip, sysname: arpEntry.sysname };
          console.log(`[RESOLVE] ARP ${link.remote_chassisid} → IP ${arpEntry.ip} → Device ${arpEntry.sysname || arpEntry.ip}`);
        }
      }

      // STRATEGIA 4: Cross-reference FDB (MAC visto su device = potrebbe essere quel device)
      // Questa è meno affidabile, ma può aiutare
      if (!resolvedDevice && link.remote_chassisid && /^[0-9a-fA-F:.-]{12,17}$/.test(link.remote_chassisid)) {
        const normalizedMAC = link.remote_chassisid.replace(/[:.|-]/g, '').toLowerCase();

        // Cerca in FDB - il MAC potrebbe essere l'indirizzo del device stesso
        // Solo se il MAC appare su UN SOLO device (altrimenti è traffico in transito)
        const fdbEntries = this.db.prepare(`
          SELECT f.device_id, d.ip, d.sysname, COUNT(*) as count
          FROM fdb f
          JOIN devices d ON f.device_id = d.id
          WHERE REPLACE(REPLACE(REPLACE(LOWER(f.mac), ':', ''), '.', ''), '-', '') = ?
          GROUP BY f.device_id
        `).all(normalizedMAC);

        if (fdbEntries.length === 1) {
          // MAC visto solo su un device - probabilmente è lui
          const entry = fdbEntries[0];
          resolvedDevice = { id: entry.device_id, ip: entry.ip, sysname: entry.sysname };
          console.log(`[RESOLVE] FDB ${link.remote_chassisid} → Device ${entry.sysname || entry.ip}`);
        }
      }

      // STRATEGIA 5: SysName matching parziale
      if (!resolvedDevice && link.remote_sysname) {
        // Cerca match esatto o parziale
        const device = this.db.prepare(`
          SELECT * FROM devices 
          WHERE sysname = ? OR sysname LIKE ?
          LIMIT 1
        `).get(link.remote_sysname, `%${link.remote_sysname}%`);

        if (device) {
          resolvedDevice = device;
          console.log(`[RESOLVE] SysName ${link.remote_sysname} → Device ${device.sysname || device.ip}`);
        }
      }

      // Aggiorna link se risolto
      if (resolvedDevice) {
        this.db.prepare(`
          UPDATE links 
          SET remote_device_id = ?, remote_ip = COALESCE(remote_ip, ?), remote_sysname = COALESCE(remote_sysname, ?)
          WHERE id = ?
        `).run(resolvedDevice.id, resolvedDevice.ip, resolvedDevice.sysname, link.id);
        resolved++;
      }
    }

    return { checked, resolved };
  }

  /**
   * Cerca device per MAC address (in ifPhysAddress)
   */
  getDeviceByMAC(mac) {
    if (!mac) return null;
    const normalizedMAC = mac.replace(/[:.|-]/g, '').toLowerCase();

    const iface = this.db.prepare(`
      SELECT d.* FROM interfaces i
      JOIN devices d ON i.device_id = d.id
      WHERE REPLACE(REPLACE(REPLACE(LOWER(i.ifphysaddress), ':', ''), '.', ''), '-', '') = ?
      LIMIT 1
    `).get(normalizedMAC);

    return iface || null;
  }

  /**
   * Cerca IP per MAC via ARP table
   */
  getIPByMAC(mac) {
    if (!mac) return null;
    const normalizedMAC = mac.replace(/[:.|-]/g, '').toLowerCase();

    const arp = this.db.prepare(`
      SELECT ip FROM arp
      WHERE REPLACE(REPLACE(REPLACE(LOWER(mac), ':', ''), '.', ''), '-', '') = ?
      ORDER BY lastseen DESC
      LIMIT 1
    `).get(normalizedMAC);

    return arp?.ip || null;
  }

  // ========== LINK DEDUPLICATION ==========

  /**
   * Deduplica link simmetrici (A->B e B->A diventano un solo link)
   * Mantiene il link con più informazioni
   */
  deduplicateLinks() {
    // Trova link simmetrici
    const links = this.getAllLinks();
    const linkPairs = new Map(); // "minId-maxId" -> [linkA, linkB]

    for (const link of links) {
      if (!link.device_id || !link.remote_device_id) continue;

      const minId = Math.min(link.device_id, link.remote_device_id);
      const maxId = Math.max(link.device_id, link.remote_device_id);
      const key = `${minId}-${maxId}`;

      if (!linkPairs.has(key)) {
        linkPairs.set(key, []);
      }
      linkPairs.get(key).push(link);
    }

    let deduplicated = 0;
    for (const [key, pair] of linkPairs) {
      if (pair.length <= 1) continue;

      // Ordina per "completezza" (più campi non-null = meglio)
      pair.sort((a, b) => {
        const scoreA = [a.local_ifname, a.remote_sysname, a.remote_chassisid, a.remote_portid].filter(Boolean).length;
        const scoreB = [b.local_ifname, b.remote_sysname, b.remote_chassisid, b.remote_portid].filter(Boolean).length;
        return scoreB - scoreA; // Maggiore score prima
      });

      // Mantieni il primo (più completo), elimina gli altri
      for (let i = 1; i < pair.length; i++) {
        this.db.prepare('DELETE FROM links WHERE id = ?').run(pair[i].id);
        deduplicated++;
      }
    }

    return { checked: links.length, duplicates: deduplicated };
  }

  /**
   * Ottieni link dedeuplicati per la mappa
   * Restituisce un solo link per ogni coppia di device
   */
  getDeduplicatedLinks() {
    return this.db.prepare(`
      WITH ranked_links AS (
        SELECT l.*,
          d1.ip as local_ip, d1.sysname as local_sysname,
          d2.ip as remote_device_ip, d2.sysname as remote_device_sysname,
          ROW_NUMBER() OVER (
            PARTITION BY 
              CASE WHEN l.device_id < l.remote_device_id 
                   THEN l.device_id || '-' || l.remote_device_id
                   ELSE l.remote_device_id || '-' || l.device_id
              END
            ORDER BY 
              CASE WHEN l.local_ifname IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN l.remote_sysname IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN l.remote_chassisid IS NOT NULL THEN 1 ELSE 0 END +
              CASE WHEN l.remote_portid IS NOT NULL THEN 1 ELSE 0 END DESC,
              l.lastseen DESC
          ) as rn
        FROM links l
        LEFT JOIN devices d1 ON l.device_id = d1.id
        LEFT JOIN devices d2 ON l.remote_device_id = d2.id
        WHERE l.remote_device_id IS NOT NULL
      )
      SELECT * FROM ranked_links WHERE rn = 1
      ORDER BY lastseen DESC
    `).all();
  }

  /**
   * Get deduplicated links with caching
   * Cache key: 'links:deduplicated'
   * @returns {Array} Array of deduplicated link objects
   */
  getCachedDeduplicatedLinks() {
    const cacheKey = 'links:deduplicated';
    const cached = this.queryCache.get(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const result = this.getDeduplicatedLinks();
    this.queryCache.set(cacheKey, result);
    return result;
  }

  // ========== PORT STATISTICS ==========

  /**
   * Ottieni statistiche utilizzo porte per un device
   */
  getPortStatistics(deviceId) {
    const interfaces = this.getDeviceInterfaces(deviceId);
    const vlans = this.db.prepare(`
      SELECT iv.*, v.vlan_name
      FROM interface_vlans iv
      JOIN interfaces i ON iv.interface_id = i.id
      LEFT JOIN vlans v ON iv.vlan_id = v.vlan_id AND v.device_id = i.device_id
      WHERE i.device_id = ?
    `).all(deviceId);

    const fdb = this.db.prepare('SELECT interface_id, COUNT(*) as mac_count FROM fdb WHERE device_id = ? GROUP BY interface_id').all(deviceId);
    const fdbMap = new Map(fdb.map(f => [f.interface_id, f.mac_count]));

    return interfaces.map(iface => ({
      ...iface,
      vlans: vlans.filter(v => v.interface_id === iface.id),
      macCount: fdbMap.get(iface.id) || 0,
      statusText: iface.ifoperstatus === 1 ? 'up' : 'down',
      speedMbps: iface.ifspeed ? Math.round(iface.ifspeed / 1000000) : null,
    }));
  }

  // ========== UTILITY ==========

  close() {
    if (this.queryCache) {
      this.queryCache.destroy();
    }
    if (this.db) {
      this.db.close();
    }
  }

  // Cleanup vecchi record (opzionale)
  cleanup(olderThanDays = 30) {
    const cutoff = Math.floor(Date.now() / 1000) - (olderThanDays * 24 * 60 * 60);
    this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
    this.cleanupExpiredSessions();
    // Altri cleanup se necessario
  }

  // ========== CACHE MANAGEMENT ==========

  /**
   * Get query cache statistics
   * @returns {Object} Cache statistics
   */
  getQueryCacheStats() {
    return this.queryCache.getStats();
  }

  /**
   * Clear all query cache entries
   */
  clearQueryCache() {
    this.queryCache.clear();
  }

  /**
   * Invalidate specific cache entries by pattern
   * @param {string} pattern - Cache key pattern (e.g., 'devices:*', 'links:*')
   * @returns {number} Number of entries invalidated
   */
  invalidateQueryCache(pattern) {
    return this.queryCache.invalidatePattern(pattern);
  }

  // ========== BATCH OPERATIONS ==========

  /**
   * Batch insert/update devices with single cache invalidation at end
   * More efficient than calling upsertDevice multiple times
   * @param {Array} devices - Array of device objects
   * @returns {Object} Result with counts of inserted and updated devices
   */
  batchUpsertDevices(devices) {
    if (!devices || devices.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;

    // Use transaction for atomicity
    const transaction = this.db.transaction(() => {
      for (const device of devices) {
        const result = this.upsertDevice(device, { skipCacheInvalidation: true });
        if (result.changes > 0 || result.lastInsertRowid > 0) {
          // For upsert, changes=0 means INSERT, changes>0 means UPDATE
          if (result.changes === 0 && result.lastInsertRowid > 0) {
            inserted++;
          } else {
            updated++;
          }
        }
      }
    });

    transaction();

    // Invalidate device cache once at the end
    this.queryCache.invalidate('devices:all');

    return { inserted, updated };
  }

  /**
   * Batch insert/update links with single cache invalidation at end
   * More efficient than calling upsertLink multiple times
   * @param {Array} links - Array of link objects
   * @returns {Object} Result with counts of inserted and updated links
   */
  batchUpsertLinks(links) {
    if (!links || links.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;

    // Use transaction for atomicity
    const transaction = this.db.transaction(() => {
      for (const link of links) {
        const result = this.upsertLink(link, { skipCacheInvalidation: true });
        if (result.changes > 0 || result.lastInsertRowid > 0) {
          // For upsert, changes=0 means update via existing logic, changes>0 means INSERT
          if (result.changes === 0) {
            updated++;
          } else {
            inserted++;
          }
        }
      }
    });

    transaction();

    // Invalidate links cache once at the end
    this.queryCache.invalidatePattern('links:*');

    return { inserted, updated };
  }

  /**
   * Batch insert/update interfaces with single cache invalidation at end
   * More efficient than calling upsertInterface multiple times
   * @param {Array} interfaces - Array of interface objects
   * @returns {Object} Result with counts of inserted and updated interfaces
   */
  batchUpsertInterfaces(interfaces) {
    if (!interfaces || interfaces.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;
    const deviceIds = new Set();

    // Use transaction for atomicity
    const transaction = this.db.transaction(() => {
      for (const iface of interfaces) {
        const result = this.upsertInterface(iface, { skipCacheInvalidation: true });
        if (iface.device_id) {
          deviceIds.add(iface.device_id);
        }
        if (result.changes > 0) {
          updated++;
        } else if (result.lastInsertRowid > 0) {
          inserted++;
        }
      }
    });

    transaction();

    // Invalidate interface cache for affected devices
    for (const deviceId of deviceIds) {
      this.queryCache.invalidate(`interfaces:device:${deviceId}`);
    }

    return { inserted, updated };
  }
}

export { DatabaseQueryCache };
export default NetMapDB;
