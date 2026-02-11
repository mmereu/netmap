#!/usr/bin/env node
/**
 * Benchmark performance NetMap
 *
 * Misura:
 * - Tempo query DB (devices, links)
 * - Tempo elaborazione dati API
 * - Throughput query/secondo
 * - Memoria utilizzata
 */

import NetMapDB from './libdb.js';
import { performance } from 'perf_hooks';

console.log('📊 NetMap Performance Benchmark\n');

// Inizializza DB
const db = new NetMapDB('./netmap.db');

// Helper per formattare memoria
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Helper per misurare tempo esecuzione
function benchmark(name, fn, iterations = 1) {
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const memBefore = process.memoryUsage().heapUsed;
    const start = performance.now();

    const result = fn();

    const end = performance.now();
    const memAfter = process.memoryUsage().heapUsed;

    times.push({
      time: end - start,
      memDelta: memAfter - memBefore,
      result,
    });
  }

  const avgTime = times.reduce((sum, t) => sum + t.time, 0) / times.length;
  const minTime = Math.min(...times.map(t => t.time));
  const maxTime = Math.max(...times.map(t => t.time));
  const avgMemDelta = times.reduce((sum, t) => sum + t.memDelta, 0) / times.length;

  return {
    name,
    avgTime,
    minTime,
    maxTime,
    avgMemDelta,
    iterations,
    result: times[0].result,
  };
}

console.log('🔍 Test 1: Query getAllDevices()');
const test1 = benchmark('getAllDevices()', () => db.getAllDevices(), 10);
console.log(`   ⏱️  Tempo medio: ${test1.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test1.minTime.toFixed(2)}ms / ${test1.maxTime.toFixed(2)}ms`);
console.log(`   📦 Devices: ${test1.result.length}`);
console.log(`   💾 Memoria: ${formatBytes(test1.avgMemDelta)}`);
console.log();

console.log('🔍 Test 2: Query getAllLinks()');
const test2 = benchmark('getAllLinks()', () => db.getAllLinks(), 10);
console.log(`   ⏱️  Tempo medio: ${test2.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test2.minTime.toFixed(2)}ms / ${test2.maxTime.toFixed(2)}ms`);
console.log(`   🔗 Links: ${test2.result.length}`);
console.log(`   💾 Memoria: ${formatBytes(test2.avgMemDelta)}`);
console.log();

console.log('🔍 Test 3: Query getLinksForMap() (ottimizzata)');
const test3 = benchmark('getLinksForMap()', () => db.getLinksForMap(), 10);
console.log(`   ⏱️  Tempo medio: ${test3.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test3.minTime.toFixed(2)}ms / ${test3.maxTime.toFixed(2)}ms`);
console.log(`   🔗 Links: ${test3.result.length}`);
console.log(`   💾 Memoria: ${formatBytes(test3.avgMemDelta)}`);
console.log(`   📈 Speedup vs getAllLinks: ${(test2.avgTime / test3.avgTime).toFixed(2)}x`);
console.log();

console.log('🔍 Test 4: Query paginata getDevicesPaginated(limit=100)');
const test4 = benchmark('getDevicesPaginated()', () => db.getDevicesPaginated({ limit: 100, offset: 0 }), 10);
console.log(`   ⏱️  Tempo medio: ${test4.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test4.minTime.toFixed(2)}ms / ${test4.maxTime.toFixed(2)}ms`);
console.log(`   📦 Devices: ${test4.result.length}`);
console.log(`   💾 Memoria: ${formatBytes(test4.avgMemDelta)}`);
console.log(`   📈 Speedup vs getAllDevices: ${(test1.avgTime / test4.avgTime).toFixed(2)}x`);
console.log();

console.log('🔍 Test 5: Query paginata getLinksPaginated(limit=200)');
const test5 = benchmark('getLinksPaginated()', () => db.getLinksPaginated({ limit: 200, offset: 0 }), 10);
console.log(`   ⏱️  Tempo medio: ${test5.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test5.minTime.toFixed(2)}ms / ${test5.maxTime.toFixed(2)}ms`);
console.log(`   🔗 Links: ${test5.result.length}`);
console.log(`   💾 Memoria: ${formatBytes(test5.avgMemDelta)}`);
console.log(`   📈 Speedup vs getAllLinks: ${(test2.avgTime / test5.avgTime).toFixed(2)}x`);
console.log();

// Test combinato (simula chiamata API /map-db)
console.log('🔍 Test 6: Carico completo API (devices + links)');
const test6 = benchmark('API /map-db equivalent', () => {
  const devices = db.getAllDevices();
  const links = db.getLinksForMap();
  return { devices, links };
}, 10);
console.log(`   ⏱️  Tempo medio: ${test6.avgTime.toFixed(2)}ms`);
console.log(`   ⚡ Min/Max: ${test6.minTime.toFixed(2)}ms / ${test6.maxTime.toFixed(2)}ms`);
console.log(`   📦 Devices: ${test6.result.devices.length}`);
console.log(`   🔗 Links: ${test6.result.links.length}`);
console.log(`   💾 Memoria: ${formatBytes(test6.avgMemDelta)}`);
console.log();

// Test throughput
console.log('🔍 Test 7: Throughput query/secondo');
const throughputIterations = 100;
const throughputStart = performance.now();
for (let i = 0; i < throughputIterations; i++) {
  db.getLinksForMap();
}
const throughputEnd = performance.now();
const throughputTime = throughputEnd - throughputStart;
const qps = (throughputIterations / (throughputTime / 1000)).toFixed(2);
console.log(`   ⚡ Query/secondo: ${qps} qps`);
console.log(`   ⏱️  Tempo totale: ${throughputTime.toFixed(2)}ms per ${throughputIterations} query`);
console.log();

// Memoria totale utilizzata
const memUsage = process.memoryUsage();
console.log('💾 Utilizzo memoria:');
console.log(`   Heap Used: ${formatBytes(memUsage.heapUsed)}`);
console.log(`   Heap Total: ${formatBytes(memUsage.heapTotal)}`);
console.log(`   RSS: ${formatBytes(memUsage.rss)}`);
console.log(`   External: ${formatBytes(memUsage.external)}`);
console.log();

// Statistiche DB
console.log('📊 Statistiche Database:');
const totalDevices = db.getAllDevices().length;
const totalLinks = db.getAllLinks().length;
console.log(`   📦 Totale Devices: ${totalDevices}`);
console.log(`   🔗 Totale Links: ${totalLinks}`);
console.log(`   📊 Rapporto Links/Device: ${(totalLinks / totalDevices).toFixed(2)}`);
console.log();

// Calcolo metriche target
console.log('🎯 Valutazione Target Performance:');
console.log(`   ✅ First render <2s per 500 nodi: ${test6.avgTime < 2000 ? 'OK' : 'FAIL'} (${test6.avgTime.toFixed(2)}ms)`);
console.log(`   ✅ Memory <200MB: ${memUsage.heapUsed < 200 * 1024 * 1024 ? 'OK' : 'FAIL'} (${formatBytes(memUsage.heapUsed)})`);
console.log(`   ✅ Throughput >50 qps: ${qps > 50 ? 'OK' : 'FAIL'} (${qps} qps)`);
console.log();

// Report finale
const avgQueryTime = (test1.avgTime + test2.avgTime + test3.avgTime) / 3;
console.log('📈 Report Finale:');
console.log(`   🏆 Query time medio: ${avgQueryTime.toFixed(2)}ms`);
console.log(`   🏆 Ottimizzazione getLinksForMap: ${((test2.avgTime - test3.avgTime) / test2.avgTime * 100).toFixed(1)}% più veloce`);
console.log(`   🏆 Memoria media per query: ${formatBytes((test1.avgMemDelta + test2.avgMemDelta + test3.avgMemDelta) / 3)}`);

db.close();
