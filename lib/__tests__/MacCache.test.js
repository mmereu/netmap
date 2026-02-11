/**
 * MacCache.test.js - Test suite per MacCache
 *
 * Usa Node.js test runner nativo
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { MacCache, normalizeMac, formatMacForDisplay } from '../MacCache.js';

describe('normalizeMac', () => {
  it('normalizza formato colon (aa:bb:cc:dd:ee:ff)', () => {
    assert.strictEqual(normalizeMac('aa:bb:cc:dd:ee:ff'), 'aabbccddeeff');
  });

  it('normalizza formato dash (aa-bb-cc-dd-ee-ff)', () => {
    assert.strictEqual(normalizeMac('aa-bb-cc-dd-ee-ff'), 'aabbccddeeff');
  });

  it('normalizza formato Huawei (aabb-ccdd-eeff)', () => {
    assert.strictEqual(normalizeMac('aabb-ccdd-eeff'), 'aabbccddeeff');
  });

  it('normalizza formato Cisco (aabb.ccdd.eeff)', () => {
    assert.strictEqual(normalizeMac('aabb.ccdd.eeff'), 'aabbccddeeff');
  });

  it('normalizza uppercase', () => {
    assert.strictEqual(normalizeMac('AA:BB:CC:DD:EE:FF'), 'aabbccddeeff');
  });

  it('passa through formato già normalizzato', () => {
    assert.strictEqual(normalizeMac('aabbccddeeff'), 'aabbccddeeff');
  });

  it('gestisce null/undefined', () => {
    assert.strictEqual(normalizeMac(null), '');
    assert.strictEqual(normalizeMac(undefined), '');
  });
});

describe('formatMacForDisplay', () => {
  it('formatta MAC completo', () => {
    assert.strictEqual(formatMacForDisplay('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
  });

  it('gestisce MAC incompleto', () => {
    assert.strictEqual(formatMacForDisplay('aabbcc'), 'aabbcc');
  });

  it('gestisce stringa vuota', () => {
    assert.strictEqual(formatMacForDisplay(''), '');
  });
});

describe('MacCache', () => {
  let cache;

  beforeEach(() => {
    cache = new MacCache();
  });

  describe('operazioni base', () => {
    it('size iniziale è 0', () => {
      assert.strictEqual(cache.size(), 0);
    });

    it('set e get funzionano', () => {
      cache.set('aa:bb:cc:dd:ee:ff', {
        endpoint: { switch: 'SW1', port: 'GE0/0/1', vlan: 100 },
        ip: '10.0.0.1'
      });

      assert.strictEqual(cache.size(), 1);

      const result = cache.get('aa:bb:cc:dd:ee:ff');
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.endpoint.switch, 'SW1');
      assert.strictEqual(result.ip, '10.0.0.1');
    });

    it('get con MAC non esistente ritorna null', () => {
      assert.strictEqual(cache.get('ff:ff:ff:ff:ff:ff'), null);
    });

    it('get normalizza formato MAC', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });

      // Stesso MAC in formati diversi
      assert.notStrictEqual(cache.get('aa-bb-cc-dd-ee-ff'), null);
      assert.notStrictEqual(cache.get('aabb-ccdd-eeff'), null);
      assert.notStrictEqual(cache.get('AABBCCDDEEFF'), null);
    });

    it('set sovrascrive entry esistente', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW2' } });

      assert.strictEqual(cache.size(), 1);
      assert.strictEqual(cache.get('aa:bb:cc:dd:ee:ff').endpoint.switch, 'SW2');
    });
  });

  describe('ricerca per MAC', () => {
    beforeEach(() => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });
      cache.set('aa:bb:cc:dd:ee:00', { endpoint: { switch: 'SW2' } });
      cache.set('11:22:33:44:55:66', { endpoint: { switch: 'SW3' } });
    });

    it('searchByMac con MAC completo', () => {
      const results = cache.searchByMac('aa:bb:cc:dd:ee:ff');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].endpoint.switch, 'SW1');
    });

    it('searchByMac con MAC parziale', () => {
      const results = cache.searchByMac('aabbcc');
      assert.strictEqual(results.length, 2);  // aabbccddeeff e aabbccddee00
    });

    it('searchByMac rispetta limit', () => {
      const results = cache.searchByMac('aabbcc', 1);
      assert.strictEqual(results.length, 1);
    });

    it('searchByMac non trovato', () => {
      const results = cache.searchByMac('ffffff');
      assert.strictEqual(results.length, 0);
    });
  });

  describe('indice bySwitch', () => {
    beforeEach(() => {
      cache.set('aa:bb:cc:dd:ee:01', { endpoint: { switch: 'SW1', port: 'GE0/0/1' } });
      cache.set('aa:bb:cc:dd:ee:02', { endpoint: { switch: 'SW1', port: 'GE0/0/2' } });
      cache.set('aa:bb:cc:dd:ee:03', { endpoint: { switch: 'SW2', port: 'GE0/0/1' } });
    });

    it('getBySwitch ritorna tutti i MAC su uno switch', () => {
      const results = cache.getBySwitch('SW1');
      assert.strictEqual(results.length, 2);
    });

    it('getBySwitch su switch non esistente', () => {
      const results = cache.getBySwitch('SW99');
      assert.strictEqual(results.length, 0);
    });

    it('getBySwitch rispetta limit', () => {
      const results = cache.getBySwitch('SW1', 1);
      assert.strictEqual(results.length, 1);
    });
  });

  describe('indice byIp', () => {
    beforeEach(() => {
      cache.set('aa:bb:cc:dd:ee:01', { endpoint: { switch: 'SW1' }, ip: '10.0.0.1' });
      cache.set('aa:bb:cc:dd:ee:02', { endpoint: { switch: 'SW1' }, ip: '10.0.0.2' });
      cache.set('aa:bb:cc:dd:ee:03', { endpoint: { switch: 'SW2' }, ip: null });
    });

    it('searchByIp trova MAC', () => {
      const result = cache.searchByIp('10.0.0.1');
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.mac, 'aa:bb:cc:dd:ee:01');
    });

    it('searchByIp non trovato', () => {
      assert.strictEqual(cache.searchByIp('10.0.0.99'), null);
    });
  });

  describe('indice byVlan', () => {
    beforeEach(() => {
      cache.set('aa:bb:cc:dd:ee:01', { endpoint: { switch: 'SW1', vlan: 100 } });
      cache.set('aa:bb:cc:dd:ee:02', { endpoint: { switch: 'SW1', vlan: 100 } });
      cache.set('aa:bb:cc:dd:ee:03', { endpoint: { switch: 'SW2', vlan: 200 } });
    });

    it('getByVlan ritorna tutti i MAC in una VLAN', () => {
      const results = cache.getByVlan(100);
      assert.strictEqual(results.length, 2);
    });

    it('getByVlan su VLAN non esistente', () => {
      const results = cache.getByVlan(999);
      assert.strictEqual(results.length, 0);
    });
  });

  describe('ricerca con filtri', () => {
    beforeEach(() => {
      cache.set('aa:bb:cc:dd:ee:01', { endpoint: { switch: 'SW1', vlan: 100 }, ip: '10.0.0.1' });
      cache.set('aa:bb:cc:dd:ee:02', { endpoint: { switch: 'SW1', vlan: 200 }, ip: '10.0.0.2' });
      cache.set('aa:bb:cc:dd:ee:03', { endpoint: { switch: 'SW2', vlan: 100 }, ip: '10.0.0.3' });
    });

    it('search con filtro MAC + VLAN', () => {
      const results = cache.search({ mac: 'aabbcc', vlan: 100 });
      assert.strictEqual(results.length, 2);
    });

    it('search con filtro switch + VLAN', () => {
      const results = cache.search({ switch: 'SW1', vlan: 100 });
      assert.strictEqual(results.length, 1);
    });

    it('search per IP', () => {
      const results = cache.search({ ip: '10.0.0.1' });
      assert.strictEqual(results.length, 1);
    });
  });

  describe('update', () => {
    it('update modifica entry esistente', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1', port: 'GE0/0/1' } });

      cache.update('aa:bb:cc:dd:ee:ff', { endpoint: { port: 'GE0/0/2' } });

      const result = cache.get('aa:bb:cc:dd:ee:ff');
      assert.strictEqual(result.endpoint.port, 'GE0/0/2');
      assert.strictEqual(result.endpoint.switch, 'SW1');  // Preservato
      assert.notStrictEqual(result.liveVerified, null);
    });

    it('update crea entry se non esiste', () => {
      cache.update('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });

      assert.strictEqual(cache.size(), 1);
      assert.notStrictEqual(cache.get('aa:bb:cc:dd:ee:ff'), null);
    });

    it('update incrementa refreshes stat', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });
      cache.update('aa:bb:cc:dd:ee:ff', { endpoint: { port: 'GE0/0/2' } });

      assert.strictEqual(cache.stats.refreshes, 1);
    });
  });

  describe('swap', () => {
    it('swap sostituisce intera cache', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });

      const newCache = new MacCache();
      newCache.set('11:22:33:44:55:66', { endpoint: { switch: 'SW2' } });

      cache.swap(newCache);

      assert.strictEqual(cache.size(), 1);
      assert.strictEqual(cache.get('aa:bb:cc:dd:ee:ff'), null);
      assert.notStrictEqual(cache.get('11:22:33:44:55:66'), null);
    });

    it('swap aggiorna lastSync', () => {
      assert.strictEqual(cache.lastSync, null);

      cache.swap(new MacCache());

      assert.notStrictEqual(cache.lastSync, null);
    });

    it('swap incrementa version', () => {
      assert.strictEqual(cache.version, 0);

      cache.swap(new MacCache());
      assert.strictEqual(cache.version, 1);

      cache.swap(new MacCache());
      assert.strictEqual(cache.version, 2);
    });
  });

  describe('buildFromNeDi', () => {
    it('costruisce cache da dati NeDi', () => {
      const nodes = [
        { mac: 'aa:bb:cc:dd:ee:ff', device: 'SW1', ifname: 'GE0/0/1', vlanid: 100, lastseen: 1000, oui: 'Apple' },
        { mac: '11:22:33:44:55:66', device: 'SW2', ifname: 'GE0/0/2', vlanid: 200, lastseen: 2000, oui: 'Intel' }
      ];
      const arp = [
        { mac: 'aa:bb:cc:dd:ee:ff', nodip: 167772161, aname: 'client1', ipupdate: 1000 }  // 10.0.0.1
      ];
      const devices = [
        { device: 'SW1', devip: '10.0.0.10' },
        { device: 'SW2', devip: '10.0.0.20' }
      ];

      const newCache = MacCache.buildFromNeDi(nodes, arp, devices);

      assert.strictEqual(newCache.size(), 2);

      const entry1 = newCache.get('aa:bb:cc:dd:ee:ff');
      assert.strictEqual(entry1.endpoint.switch, 'SW1');
      assert.strictEqual(entry1.endpoint.switchIp, '10.0.0.10');
      assert.strictEqual(entry1.ip, '10.0.0.1');
      assert.strictEqual(entry1.hostname, 'client1');
      assert.strictEqual(entry1.vendor, 'Apple');
    });

    it('deduplicazione per MAC (prende più recente)', () => {
      const nodes = [
        { mac: 'aa:bb:cc:dd:ee:ff', device: 'SW1', ifname: 'GE0/0/1', lastseen: 1000 },
        { mac: 'aa:bb:cc:dd:ee:ff', device: 'SW2', ifname: 'GE0/0/2', lastseen: 2000 }  // Più recente
      ];

      const newCache = MacCache.buildFromNeDi(nodes, [], []);

      assert.strictEqual(newCache.size(), 1);
      assert.strictEqual(newCache.get('aa:bb:cc:dd:ee:ff').endpoint.switch, 'SW2');
    });
  });

  describe('statistiche e utility', () => {
    it('getAgeSeconds con cache non sincronizzata', () => {
      assert.strictEqual(cache.getAgeSeconds(), Infinity);
    });

    it('getAge formattazione', () => {
      assert.strictEqual(cache.getAge(), 'never synced');

      cache.lastSync = new Date(Date.now() - 30 * 1000);  // 30 secondi fa
      assert.strictEqual(cache.getAge(), '30s ago');

      cache.lastSync = new Date(Date.now() - 5 * 60 * 1000);  // 5 minuti fa
      assert.strictEqual(cache.getAge(), '5 min ago');

      cache.lastSync = new Date(Date.now() - 2 * 60 * 60 * 1000);  // 2 ore fa
      assert.strictEqual(cache.getAge(), '2h ago');
    });

    it('isStale', () => {
      assert.strictEqual(cache.isStale(), true);  // Mai sincronizzata

      cache.lastSync = new Date();
      assert.strictEqual(cache.isStale(), false);

      cache.lastSync = new Date(Date.now() - 25 * 60 * 1000);  // 25 min fa
      assert.strictEqual(cache.isStale(), true);
    });

    it('getMemoryUsage', () => {
      // Cache vuota
      assert.strictEqual(cache.getMemoryUsage(), '0B');

      // Aggiungi entries
      for (let i = 0; i < 100; i++) {
        cache.set(`aa:bb:cc:dd:${i.toString().padStart(2, '0')}:ff`, { endpoint: { switch: 'SW1' } });
      }

      // ~50KB per 100 entries
      assert.match(cache.getMemoryUsage(), /\d+KB/);
    });

    it('getStats', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1', vlan: 100 }, ip: '10.0.0.1' });
      cache.get('aa:bb:cc:dd:ee:ff');
      cache.get('ff:ff:ff:ff:ff:ff');  // Miss

      const stats = cache.getStats();

      assert.strictEqual(stats.totalMacs, 1);
      assert.strictEqual(stats.totalSwitches, 1);
      assert.strictEqual(stats.totalVlans, 1);
      assert.strictEqual(stats.totalIps, 1);
      assert.strictEqual(stats.stats.hits, 1);
      assert.strictEqual(stats.stats.misses, 1);
      assert.strictEqual(stats.stats.hitRate, '50.0%');
    });

    it('resetStats', () => {
      cache.get('aa:bb:cc:dd:ee:ff');  // Miss
      assert.strictEqual(cache.stats.misses, 1);

      cache.resetStats();
      assert.strictEqual(cache.stats.misses, 0);
    });

    it('clear', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });
      cache.swap(new MacCache());  // Imposta version e lastSync

      cache.clear();

      assert.strictEqual(cache.size(), 0);
      assert.strictEqual(cache.version, 0);
      assert.strictEqual(cache.lastSync, null);
    });
  });

  describe('aggiornamento indici', () => {
    it('update che cambia switch aggiorna indici', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' } });
      assert.strictEqual(cache.getBySwitch('SW1').length, 1);
      assert.strictEqual(cache.getBySwitch('SW2').length, 0);

      cache.update('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW2' } });

      assert.strictEqual(cache.getBySwitch('SW1').length, 0);
      assert.strictEqual(cache.getBySwitch('SW2').length, 1);
    });

    it('update che cambia IP aggiorna indici', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1' }, ip: '10.0.0.1' });
      assert.notStrictEqual(cache.searchByIp('10.0.0.1'), null);

      cache.update('aa:bb:cc:dd:ee:ff', { ip: '10.0.0.2' });

      assert.strictEqual(cache.searchByIp('10.0.0.1'), null);
      assert.notStrictEqual(cache.searchByIp('10.0.0.2'), null);
    });

    it('update che cambia VLAN aggiorna indici', () => {
      cache.set('aa:bb:cc:dd:ee:ff', { endpoint: { switch: 'SW1', vlan: 100 } });
      assert.strictEqual(cache.getByVlan(100).length, 1);

      cache.update('aa:bb:cc:dd:ee:ff', { endpoint: { vlan: 200 } });

      assert.strictEqual(cache.getByVlan(100).length, 0);
      assert.strictEqual(cache.getByVlan(200).length, 1);
    });
  });
});

describe('Performance', () => {
  it('lookup O(1) con 25K entries', () => {
    const cache = new MacCache();

    // Popola con 25K entries
    for (let i = 0; i < 25000; i++) {
      const mac = i.toString(16).padStart(12, '0');
      cache.set(mac, { endpoint: { switch: `SW${i % 100}`, vlan: i % 1000 } });
    }

    assert.strictEqual(cache.size(), 25000);

    // Benchmark lookup
    const start = performance.now();
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const mac = (i * 2).toString(16).padStart(12, '0');
      cache.get(mac);
    }

    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    console.log(`  Average lookup time: ${avgMs.toFixed(4)}ms (${iterations} lookups in ${elapsed.toFixed(2)}ms)`);

    // Target: <0.1ms per lookup
    assert.ok(avgMs < 0.1, `Lookup too slow: ${avgMs.toFixed(4)}ms`);
  });

  it('buildFromNeDi performance con 25K nodes', () => {
    const nodes = [];
    const arp = [];
    const devices = [];

    // Genera 100 switch
    for (let s = 0; s < 100; s++) {
      devices.push({ device: `SW${s}`, devip: `10.0.${s}.1` });
    }

    // Genera 25K nodes
    for (let i = 0; i < 25000; i++) {
      const mac = i.toString(16).padStart(12, '0');
      nodes.push({
        mac: mac,
        device: `SW${i % 100}`,
        ifname: `GE0/0/${i % 48}`,
        vlanid: i % 100,
        lastseen: Date.now() - i * 1000,
        oui: 'Test Vendor'
      });

      if (i % 2 === 0) {
        arp.push({
          mac: mac,
          nodip: 167772160 + i,  // 10.0.0.0 + i
          aname: `host${i}`,
          ipupdate: Date.now() - i * 1000
        });
      }
    }

    const start = performance.now();
    const cache = MacCache.buildFromNeDi(nodes, arp, devices);
    const elapsed = performance.now() - start;

    console.log(`  buildFromNeDi: ${elapsed.toFixed(2)}ms for 25K nodes, 12.5K ARP`);

    assert.strictEqual(cache.size(), 25000);
    assert.ok(elapsed < 1000, `buildFromNeDi too slow: ${elapsed.toFixed(2)}ms`);  // Target: <1s
  });
});
