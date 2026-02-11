#!/usr/bin/env node
/**
 * Test diretto della funzione syncFromNeDi con neighbor import
 *
 * Usage:
 *   node test-sync-direct.mjs
 */

import Database from 'better-sqlite3';
import { getNeDiDB } from './libnedi.js';

// Mock della struttura db (semplificato)
const dbPath = './netmap.db';
const db = new Database(dbPath);

// Funzione syncFromNeDi copiata da server.js (versione con FASE 3)
async function syncFromNeDi(options = {}) {
  const { prefix = '', fullSync = false } = options;
  const startTime = Date.now();

  console.log(`[NEDI-SYNC] Avvio sincronizzazione (prefix: ${prefix || 'tutti'}, fullSync: ${fullSync})...`);

  // Inizializza connessione NeDi
  const nediDB = await getNeDiDB();

  const stats = {
    devices: { inserted: 0, updated: 0, total: 0 },
    links: { inserted: 0, skipped: 0, deleted: 0, total: 0 },
    neighbors: { inserted: 0, skipped: 0, total: 0 },
    duration: 0
  };

  try {
    // ========== FASE 1: Sync devices ==========
    console.log('[NEDI-SYNC] Fase 1: Sincronizzazione devices...');
    const nediDevices = await nediDB.getAllDevices();
    stats.devices.total = nediDevices.length;
    console.log(`[NEDI-SYNC] Trovati ${stats.devices.total} devices in NeDi`);

    // ========== FASE 2: Sync links ==========
    console.log('[NEDI-SYNC] Fase 2: Sincronizzazione links...');
    const nediLinks = await nediDB.getAllLinks();
    stats.links.total = nediLinks.length;
    console.log(`[NEDI-SYNC] Trovati ${stats.links.total} links in NeDi`);

    // ========== FASE 3: Sync neighbors LLDP come devices ==========
    console.log('[NEDI-SYNC] Fase 3: Importazione neighbors LLDP...');

    const neighborDevices = await nediDB.getNeighborDevices();
    stats.neighbors.total = neighborDevices.length;
    console.log(`[NEDI-SYNC] Trovati ${stats.neighbors.total} neighbors LLDP da importare`);

    for (const neighbor of neighborDevices) {
      try {
        // Salta se già esiste
        const existing = db.prepare('SELECT id FROM devices WHERE sysname = ?').get(neighbor.sysname);
        if (existing) {
          stats.neighbors.skipped++;
          continue;
        }

        // Genera IP fittizio univoco per neighbor senza IP (192.168.255.x)
        const fakeIp = neighbor.ip || `192.168.255.${stats.neighbors.inserted % 255}`;

        // Inserisci come device virtuale
        db.prepare(`
          INSERT OR IGNORE INTO devices (sysname, ip, vendor, status, level, lastseen, firstseen)
          VALUES (?, ?, 'LLDP Neighbor', 'discovered', 1, strftime('%s','now'), strftime('%s','now'))
        `).run(neighbor.sysname, fakeIp);

        stats.neighbors.inserted++;
      } catch (err) {
        stats.neighbors.skipped++;
      }
    }

    console.log(`[NEDI-SYNC] Neighbors: ${stats.neighbors.inserted} inseriti, ${stats.neighbors.skipped} skippati`);

    stats.duration = Date.now() - startTime;

    console.log(`[NEDI-SYNC] Completato in ${stats.duration}ms: ${stats.devices.inserted} dev inseriti, ${stats.devices.updated} aggiornati, ${stats.links.inserted} link inseriti, ${stats.neighbors.inserted} neighbors importati`);

    return { success: true, stats };

  } catch (err) {
    console.error('[NEDI-SYNC] Errore:', err);
    return { success: false, error: err.message, stats };
  }
}

// Test
async function test() {
  console.log('='.repeat(60));
  console.log('TEST: Sync NeDi con Neighbor Import (FASE 3)');
  console.log('='.repeat(60));
  console.log('');

  try {
    const result = await syncFromNeDi({ prefix: '', fullSync: false });

    console.log('\n' + '='.repeat(60));
    console.log('RISULTATI:');
    console.log('='.repeat(60));
    console.log(`Success: ${result.success}`);
    console.log(`\nDevices: ${result.stats.devices.total} totali`);
    console.log(`Links: ${result.stats.links.total} totali`);
    console.log(`Neighbors: ${result.stats.neighbors.total} totali (${result.stats.neighbors.inserted} inseriti, ${result.stats.neighbors.skipped} skippati)`);
    console.log(`\nDurata: ${result.stats.duration}ms`);

    if (result.stats.neighbors.inserted > 0) {
      console.log(`\n✅ ${result.stats.neighbors.inserted} neighbors LLDP importati con successo!`);
    }

  } catch (error) {
    console.error('❌ Errore:', error);
  } finally {
    db.close();
  }
}

test();
