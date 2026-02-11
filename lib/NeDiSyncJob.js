/**
 * NeDiSyncJob.js - Background sync job per MAC-Tracker V3
 *
 * Sincronizza cache MAC da database NeDi ogni N minuti.
 * Supporta retry con exponential backoff e notifiche errore.
 */

import { MacCache } from './MacCache.js';

/**
 * Job di sincronizzazione background da NeDi
 */
class NeDiSyncJob {
  /**
   * @param {object} nediDb - Istanza NeDiDB
   * @param {MacCache} macCache - Cache MAC da popolare
   * @param {object} options - Opzioni configurazione
   */
  constructor(nediDb, macCache, options = {}) {
    this.nedi = nediDb;
    this.cache = macCache;

    // Configurazione
    this.interval = options.interval || 15 * 60 * 1000;  // 15 minuti default
    this.retryDelayBase = options.retryDelayBase || 60 * 1000;  // 1 minuto
    this.retryDelayMax = options.retryDelayMax || 15 * 60 * 1000;  // 15 minuti max
    this.maxConsecutiveFailures = options.maxConsecutiveFailures || 3;
    this.onError = options.onError || null;  // Callback per errori
    this.onSync = options.onSync || null;  // Callback dopo sync

    // Stato
    this.isRunning = false;
    this.isSyncing = false;
    this.consecutiveFailures = 0;
    this.retryDelay = this.retryDelayBase;
    this.lastError = null;
    this.intervalId = null;
    this.retryTimeoutId = null;

    // Statistiche
    this.stats = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      lastSyncTime: null,
      lastSyncDuration: 0,
      lastSyncEntries: 0
    };
  }

  /**
   * Avvia il job di sincronizzazione
   * @param {boolean} immediateSync - Esegui sync immediato all'avvio
   */
  async start(immediateSync = true) {
    if (this.isRunning) {
      console.log('[NeDiSync] Job già in esecuzione');
      return;
    }

    this.isRunning = true;
    console.log(`[NeDiSync] Avvio job (interval: ${this.interval / 1000}s)`);

    // Sync immediato all'avvio
    if (immediateSync) {
      await this.sync();
    }

    // Schedule sync periodico
    this.intervalId = setInterval(() => {
      this.sync().catch(err => {
        console.error('[NeDiSync] Errore nel sync schedulato:', err.message);
      });
    }, this.interval);
  }

  /**
   * Ferma il job di sincronizzazione
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    console.log('[NeDiSync] Job fermato');
  }

  /**
   * Esegue sincronizzazione
   * @returns {Promise<object>} Risultato sync
   */
  async sync() {
    if (this.isSyncing) {
      console.log('[NeDiSync] Sync già in corso, skip');
      return { skipped: true, reason: 'already syncing' };
    }

    this.isSyncing = true;
    this.stats.totalSyncs++;
    const startTime = Date.now();

    console.log('[NeDiSync] Inizio sincronizzazione...');

    try {
      // Query parallele a NeDi
      const [nodes, arp, devices] = await Promise.all([
        this.fetchNodes(),
        this.fetchArp(),
        this.fetchDevices()
      ]);

      console.log(`[NeDiSync] Dati ricevuti: ${nodes.length} nodes, ${arp.length} arp, ${devices.length} devices`);

      // Costruisci nuova cache
      const newCache = MacCache.buildFromNeDi(nodes, arp, devices);

      // Atomic swap
      this.cache.swap(newCache);

      // Aggiorna stato
      const duration = Date.now() - startTime;
      this.consecutiveFailures = 0;
      this.retryDelay = this.retryDelayBase;
      this.lastError = null;

      // Aggiorna statistiche
      this.stats.successfulSyncs++;
      this.stats.lastSyncTime = new Date();
      this.stats.lastSyncDuration = duration;
      this.stats.lastSyncEntries = newCache.size();

      console.log(`[NeDiSync] Sync completato: ${newCache.size()} MAC in ${duration}ms`);

      // Callback success
      if (this.onSync) {
        this.onSync({
          success: true,
          entries: newCache.size(),
          duration,
          timestamp: this.stats.lastSyncTime
        });
      }

      return {
        success: true,
        entries: newCache.size(),
        duration,
        nodes: nodes.length,
        arp: arp.length,
        devices: devices.length
      };

    } catch (error) {
      return this.handleSyncError(error, startTime);

    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Gestisce errore di sync
   * @private
   */
  handleSyncError(error, startTime) {
    const duration = Date.now() - startTime;
    this.consecutiveFailures++;
    this.lastError = error;

    // Exponential backoff
    this.retryDelay = Math.min(
      this.retryDelay * 2,
      this.retryDelayMax
    );

    // Aggiorna statistiche
    this.stats.failedSyncs++;

    console.error(`[NeDiSync] Sync fallito (${this.consecutiveFailures}x): ${error.message}`);
    console.log(`[NeDiSync] Retry in ${this.retryDelay / 1000}s`);

    // Notifica se troppi fallimenti
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      console.error(`[NeDiSync] ATTENZIONE: ${this.consecutiveFailures} fallimenti consecutivi!`);

      if (this.onError) {
        this.onError({
          message: `NeDi sync fallito ${this.consecutiveFailures} volte consecutive`,
          error: error.message,
          consecutiveFailures: this.consecutiveFailures,
          lastRetryDelay: this.retryDelay
        });
      }
    }

    // Schedule retry
    if (this.isRunning) {
      this.retryTimeoutId = setTimeout(() => {
        this.sync().catch(err => {
          console.error('[NeDiSync] Errore nel retry:', err.message);
        });
      }, this.retryDelay);
    }

    return {
      success: false,
      error: error.message,
      duration,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryIn: this.retryDelay
    };
  }

  /**
   * Fetch nodes da NeDi (tabella nodes)
   * @private
   */
  async fetchNodes() {
    // Usa metodo ottimizzato getAllNodesForCache
    if (typeof this.nedi.getAllNodesForCache === 'function') {
      return await this.nedi.getAllNodesForCache();
    }

    // Fallback: usa execQuery diretto
    throw new Error('NeDi instance non ha metodo getAllNodesForCache');
  }

  /**
   * Fetch ARP da NeDi (tabella nodarp)
   * @private
   */
  async fetchArp() {
    // Usa metodo ottimizzato getAllArpForCache
    if (typeof this.nedi.getAllArpForCache === 'function') {
      return await this.nedi.getAllArpForCache();
    }

    // Fallback: usa execQuery diretto
    throw new Error('NeDi instance non ha metodo getAllArpForCache');
  }

  /**
   * Fetch devices da NeDi
   * @private
   */
  async fetchDevices() {
    // Usa metodo ottimizzato getAllDevicesForCache
    if (typeof this.nedi.getAllDevicesForCache === 'function') {
      return await this.nedi.getAllDevicesForCache();
    }

    // Fallback: usa getAllDevices e converti
    if (typeof this.nedi.getAllDevices === 'function') {
      const devices = await this.nedi.getAllDevices();
      return devices.map(d => ({
        device: d.sysname,
        devip: d.ip
      }));
    }

    throw new Error('NeDi instance non ha metodo per fetch devices');
  }

  /**
   * Forza sync immediato (ignora schedule)
   * @returns {Promise<object>}
   */
  async forceSync() {
    console.log('[NeDiSync] Sync forzato richiesto');

    // Cancella eventuale retry pendente
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    return await this.sync();
  }

  /**
   * Stato corrente del job
   * @returns {object}
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      interval: this.interval,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError?.message || null,
      nextRetryIn: this.retryTimeoutId ? this.retryDelay : null,
      cacheSize: this.cache.size(),
      cacheAge: this.cache.getAge(),
      cacheIsStale: this.cache.isStale(),
      stats: { ...this.stats }
    };
  }

  /**
   * Reset statistiche
   */
  resetStats() {
    this.stats = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      lastSyncTime: null,
      lastSyncDuration: 0,
      lastSyncEntries: 0
    };
    this.consecutiveFailures = 0;
    this.retryDelay = this.retryDelayBase;
    this.lastError = null;
  }
}

export { NeDiSyncJob };
