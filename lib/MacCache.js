/**
 * MacCache.js - Cache in-memory per MAC address
 *
 * MAC-Tracker V3: lookup O(1) con indici secondari
 * Target: <10ms per ricerca, ~15MB RAM per 25K entries
 */

/**
 * Normalizza MAC address in formato lowercase senza separatori
 * @param {string} mac - MAC in qualsiasi formato
 * @returns {string} MAC normalizzato (es: "aabbccddeeff")
 */
function normalizeMac(mac) {
  if (!mac) return '';
  return mac.replace(/[:\-\.]/g, '').toLowerCase();
}

/**
 * Formatta MAC per display (aa:bb:cc:dd:ee:ff)
 * @param {string} normalized - MAC normalizzato
 * @returns {string} MAC formattato
 */
function formatMacForDisplay(normalized) {
  if (!normalized || normalized.length !== 12) return normalized;
  return normalized.match(/.{2}/g).join(':');
}

/**
 * Cache in-memory per MAC address con indici secondari
 */
class MacCache {
  constructor() {
    // Cache principale: MAC normalizzato → entry
    this.cache = new Map();

    // Indici secondari per ricerche veloci
    this.bySwitch = new Map();   // switchName → Set<normalizedMac>
    this.byIp = new Map();       // IP → normalizedMac
    this.byVlan = new Map();     // VLAN number → Set<normalizedMac>

    // Metadata
    this.lastSync = null;
    this.lastSyncDuration = 0;
    this.version = 0;  // Incrementato ad ogni swap

    // Statistiche
    this.stats = {
      hits: 0,
      misses: 0,
      searches: 0,
      refreshes: 0
    };
  }

  /**
   * Dimensione cache
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * Lookup diretto per MAC (O(1))
   * @param {string} mac - MAC address
   * @returns {object|null} Entry o null
   */
  get(mac) {
    const normalized = normalizeMac(mac);
    const entry = this.cache.get(normalized);

    if (entry) {
      this.stats.hits++;
      return { ...entry, mac: formatMacForDisplay(normalized) };
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Ricerca per MAC (supporta partial match)
   * @param {string} query - MAC parziale o completo
   * @param {number} limit - Max risultati (default 50)
   * @returns {Array} Array di entries
   */
  searchByMac(query, limit = 50) {
    this.stats.searches++;
    const normalized = normalizeMac(query);
    const results = [];

    // Se query completa, usa lookup diretto
    if (normalized.length === 12) {
      const entry = this.get(normalized);
      return entry ? [entry] : [];
    }

    // Partial match: scan (ottimizzabile con trie se necessario)
    for (const [mac, entry] of this.cache) {
      if (mac.includes(normalized)) {
        results.push({ ...entry, mac: formatMacForDisplay(mac) });
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Ricerca per IP (O(1))
   * @param {string} ip - IP address
   * @returns {object|null} Entry o null
   */
  searchByIp(ip) {
    this.stats.searches++;
    const normalized = this.byIp.get(ip);

    if (normalized) {
      return this.get(normalized);
    }

    return null;
  }

  /**
   * Tutti i MAC su uno switch
   * @param {string} switchName - Nome switch
   * @param {number} limit - Max risultati
   * @returns {Array} Array di entries
   */
  getBySwitch(switchName, limit = 100) {
    this.stats.searches++;
    const macs = this.bySwitch.get(switchName);

    if (!macs) return [];

    const results = [];
    for (const normalized of macs) {
      const entry = this.cache.get(normalized);
      if (entry) {
        results.push({ ...entry, mac: formatMacForDisplay(normalized) });
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Tutti i MAC in una VLAN
   * @param {number} vlan - VLAN ID
   * @param {number} limit - Max risultati
   * @returns {Array} Array di entries
   */
  getByVlan(vlan, limit = 100) {
    this.stats.searches++;
    const macs = this.byVlan.get(vlan);

    if (!macs) return [];

    const results = [];
    for (const normalized of macs) {
      const entry = this.cache.get(normalized);
      if (entry) {
        results.push({ ...entry, mac: formatMacForDisplay(normalized) });
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Ricerca con filtri multipli
   * @param {object} filters - { mac, ip, vlan, switch }
   * @param {number} limit - Max risultati
   * @returns {Array} Array di entries
   */
  search(filters = {}, limit = 50) {
    const { mac, ip, vlan, switch: sw } = filters;

    // Priorità: IP (O(1)) → MAC (O(1) o O(n)) → Switch → VLAN
    if (ip) {
      const result = this.searchByIp(ip);
      return result ? [result] : [];
    }

    if (mac) {
      let results = this.searchByMac(mac, limit);

      // Applica filtri aggiuntivi
      if (vlan) {
        results = results.filter(r => r.endpoint?.vlan === vlan);
      }
      if (sw) {
        results = results.filter(r => r.endpoint?.switch === sw);
      }

      return results;
    }

    if (sw) {
      let results = this.getBySwitch(sw, limit);
      if (vlan) {
        results = results.filter(r => r.endpoint?.vlan === vlan);
      }
      return results;
    }

    if (vlan) {
      return this.getByVlan(vlan, limit);
    }

    return [];
  }

  /**
   * Aggiorna singola entry (dopo SSH refresh)
   * @param {string} mac - MAC address
   * @param {object} updates - Campi da aggiornare
   * @returns {boolean} True se aggiornato
   */
  update(mac, updates) {
    const normalized = normalizeMac(mac);
    const existing = this.cache.get(normalized);

    if (!existing) {
      // Se non esiste, crea nuova entry
      this.set(mac, updates);
      return true;
    }

    // Merge updates
    const updated = {
      ...existing,
      ...updates,
      endpoint: { ...existing.endpoint, ...updates.endpoint },
      liveVerified: Date.now()
    };

    this.cache.set(normalized, updated);
    this.stats.refreshes++;

    // Aggiorna indici se necessario
    this._updateIndexes(normalized, existing, updated);

    return true;
  }

  /**
   * Inserisce nuova entry
   * @param {string} mac - MAC address
   * @param {object} entry - Entry completa
   */
  set(mac, entry) {
    const normalized = normalizeMac(mac);

    // Rimuovi da indici vecchi se esisteva
    const existing = this.cache.get(normalized);
    if (existing) {
      this._removeFromIndexes(normalized, existing);
    }

    // Aggiungi entry
    const fullEntry = {
      ...entry,
      cacheUpdated: Date.now()
    };
    this.cache.set(normalized, fullEntry);

    // Aggiungi a indici
    this._addToIndexes(normalized, fullEntry);
  }

  /**
   * Atomic swap: sostituisce intera cache
   * @param {MacCache} newCache - Nuova cache popolata
   */
  swap(newCache) {
    // Copia dati dalla nuova cache
    this.cache = newCache.cache;
    this.bySwitch = newCache.bySwitch;
    this.byIp = newCache.byIp;
    this.byVlan = newCache.byVlan;

    // Aggiorna metadata
    this.lastSync = new Date();
    this.lastSyncDuration = newCache.lastSyncDuration || 0;
    this.version++;

    // Mantieni statistiche
    // (non copiamo stats dalla nuova cache)
  }

  /**
   * Costruisce cache da dati NeDi
   * @param {Array} nodes - Righe da tabella nodes
   * @param {Array} arp - Righe da tabella nodarp
   * @param {Array} devices - Righe da tabella devices
   * @returns {MacCache} Nuova cache popolata
   */
  static buildFromNeDi(nodes, arp, devices) {
    const startTime = Date.now();
    const cache = new MacCache();

    // Mappa devices per lookup veloce
    const deviceMap = new Map();
    for (const d of devices) {
      deviceMap.set(d.device, d);
    }

    // Mappa ARP per lookup IP
    const arpMap = new Map();
    for (const a of arp) {
      const normalized = normalizeMac(a.mac);
      // Prendi solo il più recente per ogni MAC
      const existing = arpMap.get(normalized);
      if (!existing || a.ipupdate > existing.ipupdate) {
        arpMap.set(normalized, a);
      }
    }

    // Processa nodes (deduplicando per MAC, prendi più recente)
    const macMap = new Map();
    for (const n of nodes) {
      const normalized = normalizeMac(n.mac);
      const existing = macMap.get(normalized);

      if (!existing || n.lastseen > existing.lastseen) {
        macMap.set(normalized, n);
      }
    }

    // Costruisci entries
    for (const [normalized, node] of macMap) {
      const device = deviceMap.get(node.device);
      const arpInfo = arpMap.get(normalized);

      const entry = {
        endpoint: {
          switch: node.device,
          switchIp: device?.devip || null,
          port: node.ifname,
          vlan: node.vlanid || null,
          macCount: node.macCount || 1,
          portType: (node.macCount || 1) <= 3 ? 'access' : 'uplink'
        },
        ip: arpInfo ? MacCache._convertNeDiIp(arpInfo.nodip) : null,
        hostname: arpInfo?.aname || null,
        vendor: node.oui || null,
        lastSeen: node.lastseen,
        liveVerified: null,
        history: []  // Popolato separatamente se necessario
      };

      cache.set(normalized, entry);
    }

    cache.lastSyncDuration = Date.now() - startTime;

    return cache;
  }

  /**
   * Converte IP numerico NeDi in stringa
   * @param {number} numIp - IP numerico
   * @returns {string} IP stringa
   */
  static _convertNeDiIp(numIp) {
    if (!numIp) return null;
    return [
      (numIp >> 24) & 255,
      (numIp >> 16) & 255,
      (numIp >> 8) & 255,
      numIp & 255
    ].join('.');
  }

  /**
   * Aggiunge entry agli indici secondari
   * @private
   */
  _addToIndexes(normalized, entry) {
    // Indice bySwitch
    if (entry.endpoint?.switch) {
      if (!this.bySwitch.has(entry.endpoint.switch)) {
        this.bySwitch.set(entry.endpoint.switch, new Set());
      }
      this.bySwitch.get(entry.endpoint.switch).add(normalized);
    }

    // Indice byIp
    if (entry.ip) {
      this.byIp.set(entry.ip, normalized);
    }

    // Indice byVlan
    if (entry.endpoint?.vlan) {
      if (!this.byVlan.has(entry.endpoint.vlan)) {
        this.byVlan.set(entry.endpoint.vlan, new Set());
      }
      this.byVlan.get(entry.endpoint.vlan).add(normalized);
    }
  }

  /**
   * Rimuove entry dagli indici secondari
   * @private
   */
  _removeFromIndexes(normalized, entry) {
    // Indice bySwitch
    if (entry.endpoint?.switch) {
      const set = this.bySwitch.get(entry.endpoint.switch);
      if (set) {
        set.delete(normalized);
        if (set.size === 0) {
          this.bySwitch.delete(entry.endpoint.switch);
        }
      }
    }

    // Indice byIp
    if (entry.ip) {
      this.byIp.delete(entry.ip);
    }

    // Indice byVlan
    if (entry.endpoint?.vlan) {
      const set = this.byVlan.get(entry.endpoint.vlan);
      if (set) {
        set.delete(normalized);
        if (set.size === 0) {
          this.byVlan.delete(entry.endpoint.vlan);
        }
      }
    }
  }

  /**
   * Aggiorna indici dopo update
   * @private
   */
  _updateIndexes(normalized, oldEntry, newEntry) {
    // Se switch cambiato
    if (oldEntry.endpoint?.switch !== newEntry.endpoint?.switch) {
      this._removeFromIndexes(normalized, oldEntry);
      this._addToIndexes(normalized, newEntry);
      return;
    }

    // Se IP cambiato
    if (oldEntry.ip !== newEntry.ip) {
      if (oldEntry.ip) this.byIp.delete(oldEntry.ip);
      if (newEntry.ip) this.byIp.set(newEntry.ip, normalized);
    }

    // Se VLAN cambiata
    if (oldEntry.endpoint?.vlan !== newEntry.endpoint?.vlan) {
      if (oldEntry.endpoint?.vlan) {
        const set = this.byVlan.get(oldEntry.endpoint.vlan);
        if (set) set.delete(normalized);
      }
      if (newEntry.endpoint?.vlan) {
        if (!this.byVlan.has(newEntry.endpoint.vlan)) {
          this.byVlan.set(newEntry.endpoint.vlan, new Set());
        }
        this.byVlan.get(newEntry.endpoint.vlan).add(normalized);
      }
    }
  }

  /**
   * Età cache in secondi
   * @returns {number}
   */
  getAgeSeconds() {
    if (!this.lastSync) return Infinity;
    return Math.floor((Date.now() - this.lastSync.getTime()) / 1000);
  }

  /**
   * Età cache formattata
   * @returns {string} Es: "5 min ago"
   */
  getAge() {
    const seconds = this.getAgeSeconds();

    if (seconds === Infinity) return 'never synced';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  /**
   * Cache è stale? (>20 minuti)
   * @returns {boolean}
   */
  isStale() {
    return this.getAgeSeconds() > 20 * 60;
  }

  /**
   * Stima memory usage
   * @returns {string} Es: "15MB"
   */
  getMemoryUsage() {
    // Stima: ~400 bytes per entry + overhead indici
    const entriesBytes = this.cache.size * 400;
    const indexesBytes = this.cache.size * 100;  // ~100 bytes overhead per entry
    const totalBytes = entriesBytes + indexesBytes;

    if (totalBytes < 1024) return `${totalBytes}B`;
    if (totalBytes < 1024 * 1024) return `${Math.round(totalBytes / 1024)}KB`;
    return `${Math.round(totalBytes / (1024 * 1024))}MB`;
  }

  /**
   * Statistiche complete
   * @returns {object}
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : '0.0';

    return {
      totalMacs: this.cache.size,
      totalSwitches: this.bySwitch.size,
      totalVlans: this.byVlan.size,
      totalIps: this.byIp.size,
      lastSync: this.lastSync?.toISOString() || null,
      lastSyncDuration: `${this.lastSyncDuration}ms`,
      cacheAge: this.getAge(),
      isStale: this.isStale(),
      memoryUsage: this.getMemoryUsage(),
      version: this.version,
      stats: {
        ...this.stats,
        hitRate: `${hitRate}%`
      }
    };
  }

  /**
   * Reset statistiche
   */
  resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      searches: 0,
      refreshes: 0
    };
  }

  /**
   * Clear cache (per testing)
   */
  clear() {
    this.cache.clear();
    this.bySwitch.clear();
    this.byIp.clear();
    this.byVlan.clear();
    this.lastSync = null;
    this.version = 0;
    this.resetStats();
  }
}

export { MacCache, normalizeMac, formatMacForDisplay };
