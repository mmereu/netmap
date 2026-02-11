import NetMapSNMP from './libsnmp.js';

const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

// Test su device problematico
const testIp = process.argv[2] || '192.168.1.18';

console.log(`=== TEST LLDP DEBUG su ${testIp} ===\n`);

try {
  // Ottieni informazioni di base
  const sysName = await snmp.getSysName(testIp);
  const sysDescr = await snmp.getSysDescr(testIp);
  console.log('SysName:', sysName);
  console.log('SysDescr:', sysDescr?.substring(0, 80) || 'N/A');
  console.log('');

  // LLDP RemTable raw
  console.log('=== LLDP RemTable (raw) ===');
  const lldpRem = await snmp.walk(testIp, '1.0.8802.1.1.2.1.4.1.1', 20, 10000);
  console.log('Rows trovate:', lldpRem.rows.length);
  console.log('Errore:', lldpRem.err || 'nessuno');
  
  // Analizza la struttura degli OID
  console.log('\n=== Analisi struttura OID ===');
  const oidPatterns = new Map();
  
  lldpRem.rows.forEach(row => {
    const parts = row.oid.split('.');
    // Conta le parti dopo la base (1.0.8802.1.1.2.1.4.1.1 = 11 parti)
    const extraParts = parts.slice(11);
    const pattern = `attr=${extraParts[0]} timeMark=${extraParts[1]} localPort=${extraParts[2]} remIndex=${extraParts[3]}`;
    
    if (!oidPatterns.has(pattern)) {
      oidPatterns.set(pattern, []);
    }
    oidPatterns.get(pattern).push(row.oid);
  });
  
  console.log('Pattern trovati:');
  let count = 0;
  for (const [pattern, oids] of oidPatterns) {
    if (count++ < 5) {
      console.log(`  ${pattern} - Esempio: ${oids[0]}`);
    }
  }
  
  // Test parsing manuale con gestione timeMark
  console.log('\n=== Test Parsing Manuale (con gestione timeMark) ===');
  const entries = {};
  const OID_BASE = '1.0.8802.1.1.2.1.4.1.1';
  const BASE_PARTS = OID_BASE.split('.').length; // 11
  
  for (const vb of lldpRem.rows.slice(0, 50)) { // Solo prime 50 per debug
    if (!vb?.oid) continue;
    const parts = vb.oid.split('.');
    const len = parts.length;
    
    // Verifica che l'OID inizi con la base
    const oidBase = parts.slice(0, BASE_PARTS).join('.');
    if (oidBase !== OID_BASE) continue;
    
    // Gestione formato con timeMark (Huawei e altri vendor)
    const attr = parts[BASE_PARTS];
    let localPort, remIndex;
    
    // Controlla se c'è un timeMark (sempre 0 per Huawei)
    if (parts[BASE_PARTS + 1] === '0' && len >= BASE_PARTS + 4) {
      // Formato: ATTR.0.localPort.remIndex
      localPort = parts[BASE_PARTS + 2];
      remIndex = parts[BASE_PARTS + 3];
    } else if (len >= BASE_PARTS + 3) {
      // Formato standard: ATTR.localPort.remIndex
      localPort = parts[BASE_PARTS + 1];
      remIndex = parts[BASE_PARTS + 2];
    } else {
      console.log(`OID troppo corto: ${vb.oid}`);
      continue;
    }
    
    const key = `${localPort}-${remIndex}`;
    if (!entries[key]) {
      entries[key] = { localPort, remIndex };
    }
    
    const entry = entries[key];
    
    // Decodifica valore
    let decodedValue;
    if (Buffer.isBuffer(vb.value)) {
      if (vb.value.length === 6) {
        decodedValue = Array.from(vb.value).map(b => b.toString(16).padStart(2, '0')).join(':');
      } else {
        const txt = vb.value.toString('utf8');
        if (/^[\x20-\x7E]+$/.test(txt)) {
          decodedValue = txt;
        } else {
          decodedValue = vb.value.toString('hex');
        }
      }
    } else {
      decodedValue = vb.value?.toString() || '';
    }
    
    switch (attr) {
      case '4': entry.chassisSubtype = decodedValue; break;
      case '5': entry.chassisId = decodedValue; break;
      case '6': entry.portSubtype = decodedValue; break;
      case '7': entry.portId = decodedValue; break;
      case '8': entry.ttl = vb.value; break;
      case '9': entry.sysName = decodedValue; break;
      case '10': entry.sysDesc = decodedValue; break;
    }
  }
  
  console.log(`\nNeighbor trovati: ${Object.keys(entries).length}`);
  Object.values(entries).slice(0, 5).forEach((n, i) => {
    console.log(`${i+1}. localPort=${n.localPort} remIndex=${n.remIndex} sysName="${n.sysName || 'NULL'}" chassisId="${n.chassisId || 'NULL'}" portId="${n.portId || 'NULL'}"`);
  });

} catch (err) {
  console.error('Errore:', err);
  console.error(err.stack);
}