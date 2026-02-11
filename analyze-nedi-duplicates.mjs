#!/usr/bin/env node

/**
 * Script per analizzare i link duplicati direttamente in NeDi
 * Verifica se il problema è nel database NeDi (sorgente) o nel sync locale
 */

import { getNeDiDB } from './libnedi.js';

const TARGET_DEVICE = '32_L2_Cassa_31-32_108';

async function main() {
  console.log(`\n=== ANALISI LINK DUPLICATI IN NEDI ===`);
  console.log(`Device: ${TARGET_DEVICE}\n`);

  const nedi = await getNeDiDB();

  try {
    await nedi.init();

    // Query 1: Raw count con GROUP BY
    console.log('1. QUERY NEDI - Link con duplicati');
    console.log('─'.repeat(80));

    const sql = `
      SELECT device, ifname, neighbor, nbrifname, linktype, COUNT(*) as cnt
      FROM links 
      WHERE device = '${TARGET_DEVICE}'
      GROUP BY device, ifname, neighbor, nbrifname, linktype
      ORDER BY cnt DESC
      LIMIT 20
    `;

    console.log('SQL Eseguita:');
    console.log(sql);
    console.log();

    const output = await nedi.execQuery(sql);
    if (!output || !output.trim()) {
      console.log('❌ Nessun risultato. Device non trovato in NeDi?');
      return;
    }

    // Parse risultati
    const lines = output.trim().split('\n');
    const rows = lines.map(line => {
      const parts = line.split('\t');
      return {
        device: parts[0],
        ifname: parts[1],
        neighbor: parts[2],
        nbrifname: parts[3],
        linktype: parts[4],
        cnt: parseInt(parts[5])
      };
    });

    // Statistiche
    let totalLinks = 0;
    let duplicateRows = 0;
    let totalDuplicateInstances = 0;

    rows.forEach(row => {
      totalLinks += row.cnt;
      if (row.cnt > 1) {
        duplicateRows++;
        totalDuplicateInstances += (row.cnt - 1);
      }
    });

    console.log('RISULTATI:');
    rows.forEach(row => {
      const isDuplicate = row.cnt > 1 ? '⚠️ ' : '  ';
      console.log(
        `${isDuplicate}${row.device} -> ${row.ifname} | ${row.neighbor} (${row.nbrifname}) [${row.linktype}] = ${row.cnt}x`
      );
    });

    console.log();
    console.log('STATISTICHE NEDI:');
    console.log(`  Total link rows: ${totalLinks}`);
    console.log(`  Rows con duplicati (cnt > 1): ${duplicateRows}`);
    console.log(`  Total duplicate instances: ${totalDuplicateInstances}`);
    console.log(`  Unique link destinations: ${rows.length}`);

    // Query 2: Tutti i link (senza GROUP BY) per vedere le righe effettive
    console.log('\n2. TUTTI I LINK RAW (senza aggregazione)');
    console.log('─'.repeat(80));

    const sqlRaw = `
      SELECT id, device, ifname, neighbor, nbrifname, linktype, time
      FROM links
      WHERE device = '${TARGET_DEVICE}'
      ORDER BY ifname, neighbor
    `;

    const outputRaw = await nedi.execQuery(sqlRaw);
    const linesRaw = outputRaw.trim().split('\n');

    console.log(`Total righe raw: ${linesRaw.length}\n`);

    // Mostra primi 30 link raw
    linesRaw.slice(0, 30).forEach(line => {
      const parts = line.split('\t');
      console.log(
        `  ID:${parts[0]} | ${parts[1]} -> ${parts[2]} (${parts[3]}) [${parts[4]}] t=${parts[5]}`
      );
    });

    if (linesRaw.length > 30) {
      console.log(`  ... e altri ${linesRaw.length - 30} link`);
    }

    // Query 3: Cerca link reversi (neighbor -> device)
    console.log('\n3. LINK REVERSI (A -> B vs B -> A)');
    console.log('─'.repeat(80));

    const sqlReverse = `
      SELECT 
        l1.device as device_a,
        l1.ifname as ifname_a,
        l1.neighbor as device_b,
        l1.nbrifname as ifname_b,
        COUNT(l1.id) as cnt_forward,
        (SELECT COUNT(l2.id) FROM links l2 
         WHERE l2.device = l1.neighbor 
         AND l2.neighbor = l1.device
         AND l2.ifname = l1.nbrifname
         AND l2.nbrifname = l1.ifname) as cnt_reverse
      FROM links l1
      WHERE l1.device = '${TARGET_DEVICE}'
      GROUP BY l1.device, l1.ifname, l1.neighbor, l1.nbrifname
      ORDER BY cnt_forward DESC, cnt_reverse DESC
      LIMIT 20
    `;

    const outputReverse = await nedi.execQuery(sqlReverse);
    if (outputReverse && outputReverse.trim()) {
      const linesReverse = outputReverse.trim().split('\n');
      linesReverse.forEach(line => {
        const parts = line.split('\t');
        console.log(
          `  ${parts[0]} -> ${parts[2]}: fwd=${parts[4]}x, rev=${parts[5]}x`
        );
      });
    }

    // Conclusione
    console.log('\n4. ANALISI CONCLUSIVA');
    console.log('─'.repeat(80));

    if (duplicateRows === 0) {
      console.log('✅ NEDI: Nessun duplicato trovato. Il problema è nel SYNC LOCALE.');
    } else {
      console.log(`❌ NEDI: Contiene ${duplicateRows} link duplicati (${totalDuplicateInstances} istanze extra)`);
      console.log('   → Il problema ORIGINA da NeDi, non dal sync locale');
    }

  } catch (err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
