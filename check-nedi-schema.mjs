#!/usr/bin/env node
import { getNeDiDB } from './libnedi.js';

async function main() {
  const nedi = await getNeDiDB();

  try {
    // Cerca PDV001 ovunque
    console.log('=== CERCA PDV001 IN TUTTE LE TABELLE ===\n');

    // In interfaces
    console.log('-- interfaces.alias:');
    let result = await nedi.execQuery("SELECT device, ifname, alias FROM interfaces WHERE alias LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

    // In links
    console.log('\n-- links.linkdesc:');
    result = await nedi.execQuery("SELECT device, ifname, neighbor, linkdesc FROM links WHERE linkdesc LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

    // In links.neighbor
    console.log('\n-- links.neighbor:');
    result = await nedi.execQuery("SELECT device, ifname, neighbor, nbrifname FROM links WHERE neighbor LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

    // In devices
    console.log('\n-- devices:');
    result = await nedi.execQuery("SELECT device, devip, location FROM devices WHERE device LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

    // In nodes
    console.log('\n-- nodes.nodesc:');
    result = await nedi.execQuery("SELECT mac, device, ifname, nodesc FROM nodes WHERE nodesc LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

    // In nodnd
    console.log('\n-- nodnd.aaaaname:');
    result = await nedi.execQuery("SELECT mac, nddevice, ndifname, aaaaname FROM nodnd WHERE aaaaname LIKE '%PDV001%' LIMIT 10");
    console.log(result || 'Nessun risultato');

  } catch (err) {
    console.error('Errore:', err.message);
  } finally {
    await nedi.close();
  }
}

main();
