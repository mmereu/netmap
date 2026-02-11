#!/usr/bin/env node
/**
 * Test script per verificare le tabelle nel database NeDi MySQL
 * e trovare dove sono salvate le porte fisiche
 */
import mysql from 'mysql2/promise';

const config = {
  host: process.env.NEDI_MYSQL_HOST || 'localhost',
  port: parseInt(process.env.NEDI_MYSQL_PORT || '3306', 10),
  user: process.env.NEDI_MYSQL_USER || 'nedi',
  password: process.env.NEDI_MYSQL_PASS || '',
  database: process.env.NEDI_MYSQL_DB || 'nedi',
  connectTimeout: 10000
};

async function main() {
  console.log('='.repeat(60));
  console.log('TEST DATABASE NEDI - Analisi Tabelle e Porte Fisiche');
  console.log('='.repeat(60));
  console.log(`\nConnessione a ${config.host}:${config.port}/${config.database}...\n`);

  const conn = await mysql.createConnection(config);

  try {
    // 1. Lista tutte le tabelle
    console.log('1. TABELLE DISPONIBILI:');
    console.log('-'.repeat(40));
    const [tables] = await conn.query('SHOW TABLES');
    tables.forEach(t => {
      const tableName = Object.values(t)[0];
      console.log(`   - ${tableName}`);
    });

    // 2. Verifica esistenza mac_current_position
    console.log('\n2. VERIFICA mac_current_position:');
    console.log('-'.repeat(40));
    const hasMacCurrent = tables.some(t => Object.values(t)[0] === 'mac_current_position');
    if (hasMacCurrent) {
      console.log('   ✓ ESISTE! Tabella mac_current_position trovata');
      const [count] = await conn.query('SELECT COUNT(*) as cnt FROM mac_current_position');
      console.log(`   Records: ${count[0].cnt}`);

      // Mostra struttura
      const [cols] = await conn.query('DESCRIBE mac_current_position');
      console.log('   Colonne:', cols.map(c => c.Field).join(', '));

      // Mostra esempio con porta fisica
      const [sample] = await conn.query(`
        SELECT mac, device, ifname, vlanid
        FROM mac_current_position
        WHERE ifname REGEXP '^(GE|XGE|Gi|Eth|Te|fo)'
        LIMIT 5
      `);
      if (sample.length > 0) {
        console.log('   Esempio porte fisiche:');
        sample.forEach(r => console.log(`     ${r.mac} -> ${r.device} ${r.ifname}`));
      }
    } else {
      console.log('   ✗ NON ESISTE! Tabella mac_current_position non trovata');
    }

    // 3. Verifica tabella nodes
    console.log('\n3. ANALISI TABELLA nodes:');
    console.log('-'.repeat(40));
    const [nodesCount] = await conn.query('SELECT COUNT(*) as cnt FROM nodes');
    console.log(`   Records totali: ${nodesCount[0].cnt}`);

    // Conta porte fisiche vs VLAN
    const [nodesPorts] = await conn.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN ifname REGEXP '^(GE|XGE|10GE|Gi|Fa|Te|Eth)' THEN 1 ELSE 0 END) as physical,
        SUM(CASE WHEN ifname REGEXP '^(Vl|VLAN|Vlanif|Vlif)' THEN 1 ELSE 0 END) as vlan
      FROM nodes
      WHERE device IS NOT NULL AND device != ''
    `);
    console.log(`   Porte fisiche: ${nodesPorts[0].physical}`);
    console.log(`   Porte VLAN: ${nodesPorts[0].vlan}`);

    // Mostra esempio
    const [nodesSample] = await conn.query(`
      SELECT mac, device, ifname, vlanid
      FROM nodes
      WHERE ifname REGEXP '^(GE|XGE|Gi|Eth|Te|fo)'
      LIMIT 5
    `);
    if (nodesSample.length > 0) {
      console.log('   Esempio porte fisiche in nodes:');
      nodesSample.forEach(r => console.log(`     ${r.mac} -> ${r.device} ${r.ifname}`));
    } else {
      console.log('   Nessuna porta fisica trovata in nodes!');
    }

    // 4. Verifica mac_history
    console.log('\n4. ANALISI TABELLA mac_history:');
    console.log('-'.repeat(40));
    const [macHistCount] = await conn.query('SELECT COUNT(*) as cnt FROM mac_history');
    console.log(`   Records totali: ${macHistCount[0].cnt}`);

    // Struttura
    const [macHistCols] = await conn.query('DESCRIBE mac_history');
    console.log('   Colonne:', macHistCols.map(c => c.Field).join(', '));

    // Esempio
    const [macHistSample] = await conn.query('SELECT * FROM mac_history LIMIT 3');
    if (macHistSample.length > 0) {
      console.log('   Esempio:');
      macHistSample.forEach(r => console.log(`     ${JSON.stringify(r)}`));
    }

    // 5. Cerca altre tabelle potenzialmente utili
    console.log('\n5. ALTRE TABELLE CON PORTE:');
    console.log('-'.repeat(40));
    for (const t of tables) {
      const tableName = Object.values(t)[0];
      if (['nodes', 'mac_current_position', 'mac_history', 'devices'].includes(tableName)) continue;

      // Controlla se ha colonne mac/ifname
      try {
        const [cols] = await conn.query(`DESCRIBE ${tableName}`);
        const colNames = cols.map(c => c.Field.toLowerCase());
        if (colNames.some(c => c.includes('mac') || c.includes('ifname') || c.includes('port'))) {
          console.log(`   ${tableName}:`);
          const [cnt] = await conn.query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
          console.log(`     Records: ${cnt[0].cnt}`);
          console.log(`     Colonne: ${colNames.filter(c => c.includes('mac') || c.includes('ifname') || c.includes('port')).join(', ')}`);
        }
      } catch (e) {
        // skip
      }
    }

    // 6. Test specifico per MAC di esempio
    console.log('\n6. RICERCA MAC SPECIFICO (00e60e749740):');
    console.log('-'.repeat(40));
    const testMac = '00e60e749740';

    // Cerca in nodes
    const [inNodes] = await conn.query(`
      SELECT mac, device, ifname, vlanid
      FROM nodes
      WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${testMac}%'
    `);
    console.log(`   In nodes: ${inNodes.length} risultati`);
    inNodes.forEach(r => console.log(`     ${r.mac} -> ${r.device} ${r.ifname} (VLAN ${r.vlanid})`));

    // Cerca in mac_current_position se esiste
    if (hasMacCurrent) {
      const [inMacCurrent] = await conn.query(`
        SELECT mac, device, ifname, vlanid
        FROM mac_current_position
        WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${testMac}%'
      `);
      console.log(`   In mac_current_position: ${inMacCurrent.length} risultati`);
      inMacCurrent.forEach(r => console.log(`     ${r.mac} -> ${r.device} ${r.ifname} (VLAN ${r.vlanid})`));
    }

    // Cerca in mac_history
    const [inHistory] = await conn.query(`
      SELECT * FROM mac_history
      WHERE REPLACE(REPLACE(REPLACE(mac, ':', ''), '-', ''), '.', '') LIKE '%${testMac}%'
    `);
    console.log(`   In mac_history: ${inHistory.length} risultati`);
    inHistory.forEach(r => console.log(`     ${JSON.stringify(r)}`));

  } finally {
    await conn.end();
  }

  console.log('\n' + '='.repeat(60));
  console.log('TEST COMPLETATO');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('ERRORE:', err.message);
  process.exit(1);
});
