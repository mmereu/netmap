import NetMapSNMP from './libsnmp.js';

const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

// Test su device problematico
const testIp = process.argv[2] || '192.168.1.18';

console.log(`=== TEST LLDP FIX su ${testIp} ===\n`);

try {
  // Ottieni informazioni di base
  const sysName = await snmp.getSysName(testIp);
  console.log('SysName:', sysName);
  console.log('');

  // LLDP RemTable raw
  console.log('=== LLDP RemTable (raw) ===');
  const lldpRem = await snmp.walk(testIp, '1.0.8802.1.1.2.1.4.1.1', 20, 10000);
  console.log('Rows trovate:', lldpRem.rows.length);
  
  // Analizza meglio gli OID
  console.log('\n=== Analisi dettagliata OID (primi 20) ===');
  lldpRem.rows.slice(0, 20).forEach((row, i) => {
    const parts = row.oid.split('.');
    console.log(`${i+1}. OID: ${row.oid}`);
    console.log(`   Base: ${parts.slice(0,11).join('.')}`);
    console.log(`   Dopo base: [${parts.slice(11).join(', ')}]`);
    console.log(`   Parts totali: ${parts.length}`);
  });
  
  // Parsing corretto
  console.log('\n=== Parsing corretto con gestione Huawei ===');
  const entries = {};
  const OID_BASE = '1.0.8802.1.1.2.1.4.1.1';
  const BASE_PARTS = OID_BASE.split('.').length; // 11
  
  for (const vb of lldpRem.rows) {
    if (!vb?.oid) continue;
    const parts = vb.oid.split('.');
    const len = parts.length;
    
    // L'OID deve essere almeno: base (11) + attr (1) + timeMark (1) + localPort (1) + remIndex (1) = 15
    // O senza timeMark: base (11) + attr (1) + localPort (1) + remIndex (1) = 14
    if (len < BASE_PARTS + 3) continue;
    
    // Verifica che l'OID inizi con la base
    const oidBase = parts.slice(0, BASE_PARTS).join('.');
    if (oidBase !== OID_BASE) continue;
    
    const attr = parts[BASE_PARTS];
    let localPort, remIndex;
    
    // Controlla se dopo l'attributo c'è uno 0 (timeMark Huawei)
    // Se parts[BASE_PARTS+1] è '0' e ci sono almeno 4 elementi dopo la base
    if (len >= BASE_PARTS + 4 && parts[BASE_PARTS + 1] === '0') {
      // Formato Huawei: attr.0.localPort.remIndex
      localPort = parts[BASE_PARTS + 2];
      remIndex = parts[BASE_PARTS + 3];
    } else if (len >= BASE_PARTS + 3) {
      // Formato standard: attr.localPort.remIndex
      localPort = parts[BASE_PARTS + 1];
      remIndex = parts[BASE_PARTS + 2];
    } else {
      continue;
    }
    
    const key = `${localPort}-${remIndex}`;
    if (!entries[key]) {
      entries[key] = { localPort, remIndex };
    }
    
    const entry = entries[key];
    
    // Decodifica valore con gestione corretta dei tipi
    let decodedValue;
    if (Buffer.isBuffer(vb.value)) {
      if (vb.value.length === 6) {
        // MAC address
        decodedValue = Array.from(vb.value).map(b => b.toString(16).padStart(2, '0')).join(':');
      } else {
        // Prova come stringa UTF-8
        const txt = vb.value.toString('utf8');
        if (/^[\x20-\x7E]+$/.test(txt)) {
          decodedValue = txt;
        } else {
          decodedValue = vb.value.toString('hex');
        }
      }
    } else if (typeof vb.value === 'number') {
      decodedValue = vb.value;
    } else {
      decodedValue = vb.value?.toString() || '';
    }
    
    // Assegna il valore all'attributo corretto
    switch (attr) {
      case '4': entry.chassisSubtype = decodedValue; break;
      case '5': entry.chassisId = decodedValue; break;
      case '6': entry.portSubtype = decodedValue; break;
      case '7': entry.portId = decodedValue; break;
      case '8': entry.ttl = decodedValue; break;
      case '9': entry.sysName = decodedValue; break;
      case '10': entry.sysDesc = decodedValue; break;
      case '11': entry.sysCap = decodedValue; break;
    }
  }
  
  const neighbors = Object.values(entries);
  console.log(`\nNeighbor trovati: ${neighbors.length}`);
  
  console.log('\nDettagli neighbor:');
  neighbors.forEach((n, i) => {
    console.log(`${i+1}. Port ${n.localPort}:`);
    console.log(`   sysName: ${n.sysName || 'N/A'}`);
    console.log(`   chassisId: ${n.chassisId || 'N/A'}`);
    console.log(`   portId: ${n.portId || 'N/A'}`);
    console.log(`   TTL: ${n.ttl || 'N/A'}`);
  });

} catch (err) {
  console.error('Errore:', err);
  console.error(err.stack);
}