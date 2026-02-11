#!/usr/bin/env node

import NetMapSNMP from './libsnmp.js';
import DB from './libdb.js';

const db = new DB('./netmap.db');
const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

console.log('=== TEST COMPLETO LLDP CON FIX HUAWEI ===\n');

try {
  // Ottieni tutti i device con IP
  const devices = await db.all(`
    SELECT ip, sysName, sysObjectID 
    FROM devices 
    WHERE ip IS NOT NULL AND ip != ''
    ORDER BY ip
  `);
  
  console.log(`Trovati ${devices.length} device da testare\n`);
  
  const results = [];
  let processed = 0;
  
  for (const device of devices) {
    try {
      // Discovery LLDP con timeout breve
      const discovery = await snmp.discoverProtocols(device.ip, 3000);
      
      const result = {
        ip: device.ip,
        sysName: device.sysName,
        lldpCount: discovery.lldp.length,
        cdpCount: discovery.cdp.length,
        protocols: discovery.protocols.join(','),
        status: 'OK'
      };
      
      results.push(result);
      processed++;
      
      // Mostra progresso ogni 10 device
      if (processed % 10 === 0) {
        console.log(`Processati ${processed}/${devices.length} device...`);
      }
      
    } catch (err) {
      results.push({
        ip: device.ip,
        sysName: device.sysName,
        lldpCount: 0,
        cdpCount: 0,
        protocols: '',
        status: 'ERROR: ' + err.message
      });
    }
  }
  
  // Statistiche finali
  console.log('\n=== RISULTATI ===\n');
  
  const withLLDP = results.filter(r => r.lldpCount > 0);
  const withCDP = results.filter(r => r.cdpCount > 0);
  const withErrors = results.filter(r => r.status.startsWith('ERROR'));
  
  console.log(`Device totali testati: ${results.length}`);
  console.log(`Device con LLDP: ${withLLDP.length}`);
  console.log(`Device con CDP: ${withCDP.length}`);
  console.log(`Device con errori: ${withErrors.length}`);
  
  console.log('\n=== DEVICE CON LLDP (Top 20) ===');
  withLLDP
    .sort((a, b) => b.lldpCount - a.lldpCount)
    .slice(0, 20)
    .forEach((r, i) => {
      console.log(`${i+1}. ${r.sysName} (${r.ip}): ${r.lldpCount} neighbor LLDP`);
    });
  
  // Verifica specifica del device problematico
  const rackE18 = results.find(r => r.ip === '192.168.10.18');
  if (rackE18) {
    console.log('\n=== VERIFICA DEVICE PROBLEMATICO ===');
    console.log(`10_L2_RackE_18 (192.168.10.18):`);
    console.log(`  - LLDP neighbors: ${rackE18.lldpCount}`);
    console.log(`  - Status: ${rackE18.status}`);
    
    if (rackE18.lldpCount > 0) {
      console.log('  ✅ FIX FUNZIONANTE! Il device ora riporta i neighbor LLDP.');
    } else {
      console.log('  ❌ PROBLEMA PERSISTE! Il device non riporta neighbor LLDP.');
    }
  }
  
  // Salva risultati in database
  console.log('\n=== AGGIORNAMENTO DATABASE ===');
  
  for (const result of results) {
    if (result.lldpCount > 0 || result.cdpCount > 0) {
      await db.run(`
        UPDATE devices 
        SET 
          lldp_neighbors = ?,
          cdp_neighbors = ?,
          discovery_protocols = ?,
          last_discovery = datetime('now')
        WHERE ip = ?
      `, [result.lldpCount, result.cdpCount, result.protocols, result.ip]);
    }
  }
  
  console.log('Database aggiornato con i nuovi dati LLDP/CDP.');
  
} catch (err) {
  console.error('Errore:', err);
} finally {
  await db.close();
}