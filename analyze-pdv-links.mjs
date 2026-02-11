#!/usr/bin/env node
/**
 * Analizza la struttura dei link LLDP per PDV AP
 * Query: device -> neighbor (AP) con dettagli collegamento
 */
import { getNeDiDB } from './libnedi.js';

async function main() {
  const nedi = await getNeDiDB();

  try {
    console.log('='.repeat(90));
    console.log('ANALISI STRUTTURA LINK LLDP PER PDV ACCESS POINT');
    console.log('='.repeat(90));
    console.log('');

    // Query 1: Struttura dei dati - Campi disponibili
    console.log('\n1. STRUTTURA DEI DATI - Campi nella tabella links');
    console.log('-'.repeat(90));
    
    const linksSql = `
      SELECT device, ifname, neighbor, nbrifname, linktype, bandwidth
      FROM links 
      WHERE neighbor LIKE '%PDV%' 
      LIMIT 5
    `;
    
    const linksOutput = await nedi.execQuery(linksSql);
    const linksRows = linksOutput.trim().split('\n').filter(r => r);
    
    console.log(`\nEsempi di link (primi 5 con PDV):`);
    console.log(`Campi ritornati: device | ifname | neighbor | nbrifname | linktype | bandwidth\n`);
    
    linksRows.forEach((row, i) => {
      const parts = row.split('\t');
      console.log(`${(i+1).toString().padStart(2)}. Device: ${parts[0]}`);
      console.log(`    Local Interface: ${parts[1]}`);
      console.log(`    Neighbor (AP): ${parts[2]}`);
      console.log(`    Neighbor Interface: ${parts[3]}`);
      console.log(`    Link Type: ${parts[4]}`);
      console.log(`    Bandwidth: ${parts[5] || 'N/A'}`);
      console.log('');
    });

    // Query 2: Statistiche per tipo di connessione
    console.log('\n2. STATISTICHE - Tipi di link per PDV');
    console.log('-'.repeat(90));
    
    const typeStatsSql = `
      SELECT linktype, COUNT(*) as count
      FROM links
      WHERE neighbor LIKE '%PDV%'
      GROUP BY linktype
      ORDER BY count DESC
    `;
    
    const typeStatsOutput = await nedi.execQuery(typeStatsSql);
    const typeStatsRows = typeStatsOutput.trim().split('\n').filter(r => r);
    
    console.log(`\nTipi di link LLDP per PDV:\n`);
    typeStatsRows.forEach(row => {
      const parts = row.split('\t');
      console.log(`  ${parts[0]}: ${parts[1]} link`);
    });

    // Query 3: Analisi per sito
    console.log('\n\n3. ANALISI PER SITO - Distribuzione AP');
    console.log('-'.repeat(90));
    
    const siteSql = `
      SELECT 
        SUBSTRING_INDEX(neighbor, '_', 1) as sito,
        COUNT(*) as ap_count,
        COUNT(DISTINCT device) as switch_count
      FROM links
      WHERE neighbor LIKE '%PDV%'
      GROUP BY sito
      ORDER BY sito
    `;
    
    const siteOutput = await nedi.execQuery(siteSql);
    const siteRows = siteOutput.trim().split('\n').filter(r => r);
    
    console.log(`\nDistribuzione per sito:\n`);
    let totalAps = 0;
    let totalSwitches = 0;
    siteRows.forEach(row => {
      const parts = row.split('\t');
      const sito = parts[0];
      const apCount = parseInt(parts[1]) || 0;
      const switchCount = parseInt(parts[2]) || 0;
      console.log(`  Sito ${sito}: ${apCount} link da ${switchCount} switch`);
      totalAps += apCount;
      totalSwitches += switchCount;
    });
    console.log(`\n  TOTALE: ${totalAps} link, ${totalSwitches} switch coinvolti`);

    // Query 4: Esempio concreto di collegamento
    console.log('\n\n4. ESEMPIO CONCRETO - Collegamento Switch -> AP');
    console.log('-'.repeat(90));
    
    const exampleSql = `
      SELECT device, ifname, neighbor, nbrifname, linktype, bandwidth, time
      FROM links 
      WHERE neighbor LIKE '%PDV%' 
      LIMIT 3
    `;
    
    const exampleOutput = await nedi.execQuery(exampleSql);
    const exampleRows = exampleOutput.trim().split('\n').filter(r => r);
    
    console.log(`\nEsempi dettagliati:\n`);
    exampleRows.forEach((row, idx) => {
      const parts = row.split('\t');
      const device = parts[0];
      const ifname = parts[1];
      const neighbor = parts[2];
      const nbrifname = parts[3];
      const linktype = parts[4];
      const bandwidth = parts[5];
      const time = parts[6];
      
      console.log(`Esempio ${idx + 1}:`);
      console.log(`  SORGENTE (Device/Switch):`);
      console.log(`    Sysname: ${device}`);
      console.log(`    Interfaccia: ${ifname}`);
      console.log(`  DESTINAZIONE (Neighbor/AP):`);
      console.log(`    Sysname: ${neighbor}`);
      console.log(`    Interfaccia: ${nbrifname}`);
      console.log(`  COLLEGAMENTO:`);
      console.log(`    Protocollo: ${linktype}`);
      console.log(`    Bandwidth: ${bandwidth || 'Not configured'}`);
      console.log(`    Scoperto: ${time ? new Date(parseInt(time) * 1000).toLocaleString('it-IT') : 'Unknown'}`);
      console.log('');
    });

    // Query 5: Dettagli device -> AP
    console.log('\n5. MAPPING DEVICE-AP - Chi si collega a chi');
    console.log('-'.repeat(90));
    
    const mappingSql = `
      SELECT 
        device,
        COUNT(DISTINCT neighbor) as ap_count,
        GROUP_CONCAT(DISTINCT neighbor ORDER BY neighbor) as ap_list
      FROM links
      WHERE neighbor LIKE '%PDV%'
      GROUP BY device
      ORDER BY ap_count DESC
      LIMIT 10
    `;
    
    const mappingOutput = await nedi.execQuery(mappingSql);
    const mappingRows = mappingOutput.trim().split('\n').filter(r => r);
    
    console.log(`\nTop 10 switch con piu' AP collegati:\n`);
    mappingRows.forEach((row, idx) => {
      const parts = row.split('\t');
      const device = parts[0];
      const apCount = parts[1];
      const apList = parts[2] ? parts[2].split(',') : [];
      
      console.log(`${(idx + 1).toString().padStart(2)}. ${device} (${apCount} AP)`);
      if (apList.length > 0) {
        apList.slice(0, 5).forEach(ap => {
          console.log(`     - ${ap}`);
        });
        if (apList.length > 5) {
          console.log(`     - ... e altri ${apList.length - 5}`);
        }
      }
    });

    console.log('\n' + '='.repeat(90));
    console.log('ANALISI COMPLETATA');
    console.log('='.repeat(90));

  } catch (err) {
    console.error('\nERRORE:', err.message);
    console.error(err.stack);
  } finally {
    await nedi.close();
  }
}

main();
