#!/usr/bin/env node
const BASE_URL = 'http://localhost:4000';
const AP_PATTERNS = ['ap-', '-ap', 'ap_', '_ap', 'pdv', 'wifi', 'wireless', 'wlan'];

function isAccessPoint(sysname) {
  if (!sysname) return false;
  const lower = sysname.toLowerCase();
  return AP_PATTERNS.some(p => lower.includes(p)) || lower.startsWith('ap');
}

function extractSiteCode(name) {
  if (!name) return null;
  let match = name.match(/^(?:sito)?(\d{2})[-_]/i);
  if (match) return match[1];
  const matchPDV = name.match(/PDV(\d{2,3})/i);
  if (matchPDV) {
    const siteNum = parseInt(matchPDV[1], 10);
    return siteNum.toString().padStart(2, '0');
  }
  match = name.match(/(?:L[23]|CORE|SW|AP)[-_]?(\d{2})[-_]/i);
  if (match) return match[1];
  return null;
}

async function main() {
  const response = await fetch(`${BASE_URL}/api/map-db?lev=4&mde=f`);
  const data = await response.json();
  const nodes = data.nodes || [];

  const siteAPs = new Map();

  for (const node of nodes) {
    const sysname = node.sysname || node.label || node.id;
    const siteCode = extractSiteCode(sysname);
    if (!siteCode) continue;

    if (isAccessPoint(sysname)) {
      if (!siteAPs.has(siteCode)) siteAPs.set(siteCode, []);
      siteAPs.get(siteCode).push(sysname);
    }
  }

  const sortedSites = Array.from(siteAPs.keys()).sort((a, b) => parseInt(a) - parseInt(b));

  console.log('='.repeat(80));
  console.log('ELENCO COMPLETO ACCESS POINT PER SITO');
  console.log('='.repeat(80));

  let totalAP = 0;
  for (const site of sortedSites) {
    const aps = siteAPs.get(site).sort();
    totalAP += aps.length;
    console.log('');
    console.log(`SITO ${site} (${aps.length} AP)`);
    console.log('-'.repeat(40));
    aps.forEach((ap, i) => console.log(`  ${(i+1).toString().padStart(2)}. ${ap}`));
  }

  console.log('');
  console.log('='.repeat(80));
  console.log(`TOTALE: ${totalAP} Access Point su ${sortedSites.length} siti`);
  console.log('='.repeat(80));
}

main().catch(console.error);
