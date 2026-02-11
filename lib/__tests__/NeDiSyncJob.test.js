/**
 * NeDiSyncJob.test.js - Test suite per NeDiSyncJob
 *
 * Usa mock per NeDiDB per test isolati
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { NeDiSyncJob } from '../NeDiSyncJob.js';
import { MacCache } from '../MacCache.js';

/**
 * Mock NeDiDB per testing
 */
function createMockNeDi(options = {}) {
  const {
    nodesData = [],
    arpData = [],
    devicesData = [],
    shouldFail = false,
    failCount = 0
  } = options;

  let callCount = 0;

  return {
    getAllNodesForCache: async () => {
      callCount++;
      if (shouldFail || (failCount > 0 && callCount <= failCount)) {
        throw new Error('Mock NeDi connection error');
      }
      return nodesData;
    },
    getAllArpForCache: async () => {
      if (shouldFail || (failCount > 0 && callCount <= failCount)) {
        throw new Error('Mock NeDi connection error');
      }
      return arpData;
    },
    getAllDevicesForCache: async () => {
      if (shouldFail || (failCount > 0 && callCount <= failCount)) {
        throw new Error('Mock NeDi connection error');
      }
      return devicesData;
    },
    getCallCount: () => callCount
  };
}

/**
 * Genera dati mock realistici
 */
function generateMockData(count = 100) {
  const nodes = [];
  const arp = [];
  const devices = [];

  // Genera devices
  for (let s = 0; s < Math.min(count / 10, 100); s++) {
    devices.push({
      device: `SW${s}`,
      devip: `10.0.${s}.1`
    });
  }

  // Genera nodes
  for (let i = 0; i < count; i++) {
    const mac = i.toString(16).padStart(12, '0');
    nodes.push({
      mac: mac,
      device: `SW${i % devices.length}`,
      ifname: `GE0/0/${i % 48}`,
      vlanid: (i % 100) + 1,
      lastseen: Date.now() / 1000 - i * 60,
      oui: 'Test Vendor',
      devip: devices[i % devices.length].devip,
      macCount: 1
    });

    // 50% hanno ARP
    if (i % 2 === 0) {
      arp.push({
        mac: mac,
        nodip: 167772160 + i,  // 10.0.0.0 + i
        aname: `host${i}`,
        ipupdate: Date.now() / 1000 - i * 60
      });
    }
  }

  return { nodes, arp, devices };
}

describe('NeDiSyncJob', () => {
  let cache;
  let mockNeDi;
  let syncJob;

  beforeEach(() => {
    cache = new MacCache();
  });

  afterEach(() => {
    if (syncJob) {
      syncJob.stop();
      syncJob = null;
    }
  });

  describe('costruttore', () => {
    it('inizializza con valori default', () => {
      mockNeDi = createMockNeDi();
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      assert.strictEqual(syncJob.interval, 15 * 60 * 1000);
      assert.strictEqual(syncJob.isRunning, false);
      assert.strictEqual(syncJob.consecutiveFailures, 0);
    });

    it('accetta opzioni custom', () => {
      mockNeDi = createMockNeDi();
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        interval: 5 * 60 * 1000,
        retryDelayBase: 30 * 1000,
        maxConsecutiveFailures: 5
      });

      assert.strictEqual(syncJob.interval, 5 * 60 * 1000);
      assert.strictEqual(syncJob.retryDelayBase, 30 * 1000);
      assert.strictEqual(syncJob.maxConsecutiveFailures, 5);
    });
  });

  describe('sync', () => {
    it('popola cache con dati da NeDi', async () => {
      const { nodes, arp, devices } = generateMockData(100);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      const result = await syncJob.sync();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.entries, 100);
      assert.strictEqual(cache.size(), 100);
    });

    it('gestisce cache vuota dopo sync con dati vuoti', async () => {
      mockNeDi = createMockNeDi({ nodesData: [], arpData: [], devicesData: [] });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      const result = await syncJob.sync();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.entries, 0);
      assert.strictEqual(cache.size(), 0);
    });

    it('aggiorna statistiche dopo sync', async () => {
      const { nodes, arp, devices } = generateMockData(50);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      await syncJob.sync();

      assert.strictEqual(syncJob.stats.totalSyncs, 1);
      assert.strictEqual(syncJob.stats.successfulSyncs, 1);
      assert.strictEqual(syncJob.stats.failedSyncs, 0);
      assert.strictEqual(syncJob.stats.lastSyncEntries, 50);
      assert.notStrictEqual(syncJob.stats.lastSyncTime, null);
    });

    it('skip se sync già in corso', async () => {
      mockNeDi = createMockNeDi({ nodesData: [], arpData: [], devicesData: [] });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      // Simula sync in corso
      syncJob.isSyncing = true;

      const result = await syncJob.sync();

      assert.strictEqual(result.skipped, true);
      assert.strictEqual(result.reason, 'already syncing');
    });
  });

  describe('error handling', () => {
    it('gestisce errore NeDi e incrementa failures', async () => {
      mockNeDi = createMockNeDi({ shouldFail: true });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        retryDelayBase: 100  // Piccolo per test veloci
      });

      const result = await syncJob.sync();

      assert.strictEqual(result.success, false);
      assert.strictEqual(syncJob.consecutiveFailures, 1);
      assert.strictEqual(syncJob.stats.failedSyncs, 1);
      assert.notStrictEqual(syncJob.lastError, null);
    });

    it('exponential backoff dopo fallimenti', async () => {
      mockNeDi = createMockNeDi({ shouldFail: true });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        retryDelayBase: 100
      });

      await syncJob.sync();
      const delay1 = syncJob.retryDelay;

      // Simula secondo fallimento
      syncJob.isSyncing = false;
      await syncJob.sync();
      const delay2 = syncJob.retryDelay;

      assert.strictEqual(delay2, delay1 * 2);
    });

    it('rispetta retryDelayMax', async () => {
      mockNeDi = createMockNeDi({ shouldFail: true });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        retryDelayBase: 1000,
        retryDelayMax: 2000
      });

      // Simula molti fallimenti
      for (let i = 0; i < 10; i++) {
        syncJob.isSyncing = false;
        await syncJob.sync();
      }

      assert.ok(syncJob.retryDelay <= 2000);
    });

    it('chiama onError callback dopo maxConsecutiveFailures', async () => {
      mockNeDi = createMockNeDi({ shouldFail: true });

      let errorCallCount = 0;
      let lastError = null;

      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        retryDelayBase: 10,
        maxConsecutiveFailures: 2,
        onError: (err) => {
          errorCallCount++;
          lastError = err;
        }
      });

      // Non raggiunge ancora maxConsecutiveFailures
      await syncJob.sync();
      assert.strictEqual(errorCallCount, 0);

      // Ora lo raggiunge
      syncJob.isSyncing = false;
      await syncJob.sync();
      assert.strictEqual(errorCallCount, 1);
      assert.strictEqual(lastError.consecutiveFailures, 2);
    });

    it('reset failures dopo sync riuscito', async () => {
      // Prima fallisce, poi riesce
      mockNeDi = createMockNeDi({ failCount: 1 });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        retryDelayBase: 10
      });

      // Primo sync fallisce
      await syncJob.sync();
      assert.strictEqual(syncJob.consecutiveFailures, 1);

      // Secondo sync riesce
      syncJob.isSyncing = false;
      await syncJob.sync();
      assert.strictEqual(syncJob.consecutiveFailures, 0);
      assert.strictEqual(syncJob.lastError, null);
    });
  });

  describe('start/stop', () => {
    it('start avvia il job', async () => {
      const { nodes, arp, devices } = generateMockData(10);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        interval: 1000
      });

      await syncJob.start(true);

      assert.strictEqual(syncJob.isRunning, true);
      assert.strictEqual(cache.size(), 10);
    });

    it('start con immediateSync=false non fa sync subito', async () => {
      mockNeDi = createMockNeDi({ nodesData: [], arpData: [], devicesData: [] });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        interval: 60000
      });

      await syncJob.start(false);

      assert.strictEqual(syncJob.isRunning, true);
      assert.strictEqual(syncJob.stats.totalSyncs, 0);
    });

    it('stop ferma il job', async () => {
      mockNeDi = createMockNeDi({ nodesData: [], arpData: [], devicesData: [] });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      await syncJob.start(false);
      assert.strictEqual(syncJob.isRunning, true);

      syncJob.stop();
      assert.strictEqual(syncJob.isRunning, false);
      assert.strictEqual(syncJob.intervalId, null);
    });

    it('start ignora se già running', async () => {
      mockNeDi = createMockNeDi({ nodesData: [], arpData: [], devicesData: [] });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      await syncJob.start(false);
      await syncJob.start(false);  // Seconda chiamata

      // Dovrebbe comunque essere running una sola volta
      assert.strictEqual(syncJob.isRunning, true);
    });
  });

  describe('forceSync', () => {
    it('esegue sync immediato', async () => {
      const { nodes, arp, devices } = generateMockData(20);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      const result = await syncJob.forceSync();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.entries, 20);
    });
  });

  describe('getStatus', () => {
    it('ritorna stato corrente', async () => {
      const { nodes, arp, devices } = generateMockData(50);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });
      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        interval: 60000
      });

      await syncJob.sync();

      const status = syncJob.getStatus();

      assert.strictEqual(status.isRunning, false);
      assert.strictEqual(status.isSyncing, false);
      assert.strictEqual(status.interval, 60000);
      assert.strictEqual(status.consecutiveFailures, 0);
      assert.strictEqual(status.cacheSize, 50);
      assert.notStrictEqual(status.cacheAge, 'never synced');
      assert.strictEqual(status.stats.successfulSyncs, 1);
    });
  });

  describe('resetStats', () => {
    it('azzera tutte le statistiche', async () => {
      mockNeDi = createMockNeDi({ shouldFail: true });
      syncJob = new NeDiSyncJob(mockNeDi, cache);

      await syncJob.sync();
      assert.strictEqual(syncJob.stats.failedSyncs, 1);
      assert.strictEqual(syncJob.consecutiveFailures, 1);

      syncJob.resetStats();

      assert.strictEqual(syncJob.stats.totalSyncs, 0);
      assert.strictEqual(syncJob.stats.failedSyncs, 0);
      assert.strictEqual(syncJob.consecutiveFailures, 0);
      assert.strictEqual(syncJob.lastError, null);
    });
  });

  describe('callbacks', () => {
    it('chiama onSync dopo sync riuscito', async () => {
      const { nodes, arp, devices } = generateMockData(30);
      mockNeDi = createMockNeDi({ nodesData: nodes, arpData: arp, devicesData: devices });

      let syncCallCount = 0;
      let lastSyncResult = null;

      syncJob = new NeDiSyncJob(mockNeDi, cache, {
        onSync: (result) => {
          syncCallCount++;
          lastSyncResult = result;
        }
      });

      await syncJob.sync();

      assert.strictEqual(syncCallCount, 1);
      assert.strictEqual(lastSyncResult.success, true);
      assert.strictEqual(lastSyncResult.entries, 30);
    });
  });
});

describe('Performance NeDiSyncJob', () => {
  it('sync 25K entries in tempo ragionevole', async () => {
    const { nodes, arp, devices } = generateMockData(25000);

    const mockNeDi = createMockNeDi({
      nodesData: nodes,
      arpData: arp,
      devicesData: devices
    });

    const cache = new MacCache();
    const syncJob = new NeDiSyncJob(mockNeDi, cache);

    const start = performance.now();
    const result = await syncJob.sync();
    const elapsed = performance.now() - start;

    console.log(`  Sync 25K entries: ${elapsed.toFixed(2)}ms`);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.entries, 25000);
    assert.ok(elapsed < 500, `Sync too slow: ${elapsed.toFixed(2)}ms`);

    syncJob.stop();
  });
});
