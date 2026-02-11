#!/usr/bin/env node
/**
 * Lista completa PDV da NeDi (tabella links.neighbor - LLDP discovery)
 */
import { getNeDiDB } from './libnedi.js';

async function main() {
  const nedi = await getNeDiDB();

  try {
    console.log('='.repeat(70));
    console.log('ELENCO COMPLETO ACCESS POINT PDV DA NEDI');
    console.log('(Tabella: links.neighbor - LLDP discovery)');
    console.log('='.repeat(70));
    console.log('');

    // Ottieni tutti i neighbors con PDV
    const query = `
      SELECT DISTINCT neighbor
      FROM links
      WHERE neighbor LIKE '%PDV%'
      ORDER BY neighbor
    `;
    const output = await nedi.execQuery(query);
    const rows = output.trim().split('\n').filter(r => r);

    console.log(`Trovati: ${rows.length} AP PDV\n`);

    // Raggruppa per sito (PDV001 -> Sito 01, PDV005 -> Sito 05, ecc.)
    const sites = new Map();
    rows.forEach(name => {
      const match = name.match(/PDV(\d{3})/i);
      if (match) {
        const siteNum = parseInt(match[1], 10);
        const siteCode = siteNum.toString().padStart(2, '0');
        if (!sites.has(siteCode)) sites.set(siteCode, []);
        sites.get(siteCode).push(name);
      }
    });

    // Mostra per sito
    const sortedSites = Array.from(sites.keys()).sort();
    sortedSites.forEach(site => {
      const aps = sites.get(site).sort();
      console.log(`\nSITO ${site} (${aps.length} AP)`);
      console.log('-'.repeat(50));
      aps.forEach((ap, i) => console.log(`  ${(i+1).toString().padStart(2)}. ${ap}`));
    });

    // Riepilogo
    console.log('\n' + '='.repeat(70));
    console.log('RIEPILOGO');
    console.log('='.repeat(70));
    sortedSites.forEach(site => {
      console.log(`  Sito ${site}: ${sites.get(site).length} AP`);
    });
    console.log(`\n  TOTALE: ${rows.length} Access Point PDV`);
    console.log('='.repeat(70));

  } catch (err) {
    console.error('Errore:', err.message);
    console.error(err.stack);
  } finally {
    await nedi.close();
  }
}

main();
