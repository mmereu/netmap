#!/usr/bin/env node
/**
 * Test visualizzazione Access Point su tutti i siti
 * Verifica che gli AP siano correttamente identificati nella topologia
 */

const BASE_URL = 'http://localhost:4000';

// Pattern per riconoscere gli Access Point
const AP_PATTERNS = ['ap-', '-ap', 'ap_', '_ap', 'pdv', 'wifi', 'wireless', 'wlan'];

function isAccessPoint(sysname) {
  if (!sysname) return false;
  const lower = sysname.toLowerCase();
  return AP_PATTERNS.some(p => lower.includes(p)) || lower.startsWith('ap');
}

// Estrae il codice sito dal nome device (es. "03_L2_..." -> "03")
function extractSiteCode(name) {
  if (!name) return null;

  // Pattern 1: Codice sito all'inizio (XX_..., XX-..., SitoXX_...)
  let match = name.match(/^(?:sito)?(\d{2})[-_]/i);
  if (match) return match[1];

  // Pattern 2: PDV (Access Point) - es. "PDV010-..." -> sito 10
  const matchPDV = name.match(/PDV(\d{2,3})/i);
  if (matchPDV) {
    const siteNum = parseInt(matchPDV[1], 10);
    return siteNum.toString().padStart(2, '0');
  }

  // Pattern 3: Codice sito dopo prefisso noto
  match = name.match(/(?:L[23]|CORE|SW|AP)[-_]?(\d{2})[-_]/i);
  if (match) return match[1];

  return null;
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  console.log('='.repeat(80));
  console.log('TEST VISUALIZZAZIONE ACCESS POINT - TUTTI I SITI');
  console.log('='.repeat(80));
  console.log(`Data: ${new Date().toISOString()}`);
  console.log(`Pattern AP: ${AP_PATTERNS.join(', ')}, startsWith('ap')`);
  console.log('');

  // Ottieni tutti i nodi dalla mappa
  console.log('Caricamento dati mappa...');
  const mapData = await fetchJSON(`${BASE_URL}/api/map-db?lev=4&mde=f`);
  const nodes = mapData.nodes || [];

  console.log(`Nodi totali caricati: ${nodes.length}`);
  console.log('-'.repeat(80));

  // Raggruppa per sito
  const siteMap = new Map();

  for (const node of nodes) {
    const sysname = node.sysname || node.label || node.id;
    const siteCode = extractSiteCode(sysname);

    if (!siteCode) continue;

    if (!siteMap.has(siteCode)) {
      siteMap.set(siteCode, { nodes: [], aps: [] });
    }

    const siteData = siteMap.get(siteCode);
    siteData.nodes.push(node);

    if (isAccessPoint(sysname)) {
      siteData.aps.push(sysname);
    }
  }

  // Ordina siti numericamente
  const sortedSites = Array.from(siteMap.keys()).sort((a, b) => parseInt(a) - parseInt(b));

  console.log(`\nSiti identificati: ${sortedSites.length}`);
  console.log('');

  // Report risultati
  console.log('='.repeat(80));
  console.log('RISULTATI PER SITO');
  console.log('='.repeat(80));
  console.log('');
  console.log('Sito  | Tot.Nodi | AP  | Non-AP | Esempi AP (max 3)');
  console.log('-'.repeat(80));

  let totalAP = 0;
  let totalNodes = 0;
  let sitesWithAP = 0;
  const results = [];

  for (const siteCode of sortedSites) {
    const data = siteMap.get(siteCode);
    const nodeCount = data.nodes.length;
    const apCount = data.aps.length;
    const nonApCount = nodeCount - apCount;

    // Esempi di AP (max 3)
    const apExamples = data.aps.slice(0, 3).join(', ') || '-';
    const truncExamples = apExamples.length > 45 ? apExamples.substring(0, 42) + '...' : apExamples;

    console.log(
      `${siteCode.padEnd(5)} | ${String(nodeCount).padStart(8)} | ${String(apCount).padStart(3)} | ${String(nonApCount).padStart(6)} | ${truncExamples}`
    );

    results.push({ siteCode, nodeCount, apCount, apExamples: data.aps.slice(0, 5) });

    totalAP += apCount;
    totalNodes += nodeCount;
    if (apCount > 0) sitesWithAP++;
  }

  console.log('-'.repeat(80));
  console.log('');

  // Riepilogo
  console.log('='.repeat(80));
  console.log('RIEPILOGO');
  console.log('='.repeat(80));
  console.log(`Siti identificati:   ${sortedSites.length}`);
  console.log(`Siti con AP:         ${sitesWithAP}`);
  console.log(`Siti senza AP:       ${sortedSites.length - sitesWithAP}`);
  console.log(`Nodi totali:         ${totalNodes}`);
  console.log(`Access Point totali: ${totalAP}`);
  console.log(`Nodi non-AP:         ${totalNodes - totalAP}`);
  console.log(`% AP su totale:      ${totalNodes > 0 ? ((totalAP / totalNodes) * 100).toFixed(1) : 0}%`);
  console.log('');

  // Dettaglio siti con più AP
  const topApSites = results.filter(r => r.apCount > 0).sort((a, b) => b.apCount - a.apCount);
  if (topApSites.length > 0) {
    console.log('TOP 10 SITI PER NUMERO DI AP:');
    topApSites.slice(0, 10).forEach((r, i) => {
      const examples = r.apExamples.slice(0, 2).join(', ');
      console.log(`  ${(i + 1).toString().padStart(2)}. Sito ${r.siteCode}: ${r.apCount} AP (${examples}...)`);
    });
  }

  // Siti senza AP
  const sitesNoAP = results.filter(r => r.apCount === 0);
  if (sitesNoAP.length > 0) {
    console.log('\nSITI SENZA AP:');
    sitesNoAP.forEach(r => {
      console.log(`  - Sito ${r.siteCode}: ${r.nodeCount} nodi (nessun AP rilevato)`);
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('TEST COMPLETATO');
  console.log('='.repeat(80));

  // Verifica consistenza con checkbox AP
  console.log('\n--- VERIFICA CHECKBOX AP ---');
  console.log('Per ogni sito con AP, quando checkbox AP attivato:');
  console.log(`  Nodi visibili aumentano del numero di AP rilevati`);

  // Calcola incremento atteso per Sito 10 (test documentato)
  const sito10 = results.find(r => r.siteCode === '10');
  if (sito10) {
    console.log(`\nSito 10 (test documentato):`);
    console.log(`  - Nodi senza AP: ${sito10.nodeCount - sito10.apCount}`);
    console.log(`  - Nodi con AP:   ${sito10.nodeCount}`);
    console.log(`  - Incremento:    +${sito10.apCount} nodi`);
    if (sito10.apCount === 30) {
      console.log(`  ✅ Confermato: 30 AP come da memoria Serena`);
    } else {
      console.log(`  ⚠️  Attesi 30 AP, trovati ${sito10.apCount}`);
    }
  }
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
