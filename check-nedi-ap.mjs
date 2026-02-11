import NeDiDB from './libnedi.js';

const siteNum = process.argv[2] || '21';
const sitePattern = `PDV${siteNum.padStart(3, '0')}%`;

console.log(`\n=== AP Sito ${siteNum} in NeDi ===\n`);

const nedi = new NeDiDB();

// Query diretta per neighbor PDV del sito
const sql = `SELECT DISTINCT neighbor, device, ifname FROM links WHERE neighbor LIKE '${sitePattern}' ORDER BY neighbor`;
const output = await nedi.execQuery(sql);

const rows = output.trim().split('\n').filter(l => l);
console.log(`AP in tabella links: ${rows.length}`);
rows.forEach(r => {
  const [neighbor, device, ifname] = r.split('\t');
  console.log(`  ${neighbor} (da ${device} [${ifname}])`);
});

// Query per nodes
const sql2 = `SELECT DISTINCT name, device, mac FROM nodes WHERE name LIKE '${sitePattern}' ORDER BY name`;
const output2 = await nedi.execQuery(sql2);

const rows2 = output2.trim().split('\n').filter(l => l);
console.log(`\nAP in tabella nodes: ${rows2.length}`);
rows2.forEach(r => {
  const [name, device, mac] = r.split('\t');
  console.log(`  ${name} (MAC: ${mac}) da ${device}`);
});
