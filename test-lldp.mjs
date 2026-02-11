import NetMapSNMP from './libsnmp.js';

const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

// Test su un device L3 core - device con più link NULL
const testIp = process.argv[2] || '192.168.1.251';

console.log(`=== TEST LLDP su ${testIp} ===\n`);

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
  
  // Mostra primi 20 row raw
  if (lldpRem.rows.length > 0) {
    console.log('\nPrime 20 rows:');
    lldpRem.rows.slice(0, 20).forEach((row, i) => {
      let value = row.value;
      if (Buffer.isBuffer(value)) {
        // Prova a decodificare come stringa
        const txt = value.toString('utf8');
        if (/^[\x20-\x7E]+$/.test(txt)) {
          value = `"${txt}"`;
        } else if (value.length === 6) {
          value = `MAC: ${Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(':')}`;
        } else {
          value = `HEX: ${value.toString('hex')}`;
        }
      }
      console.log(`${i+1}. OID: ${row.oid} | Value: ${value}`);
    });
  }
  
  // LLDP parsed
  console.log('\n=== LLDP Parsed ===');
  const parsed = snmp.parseLLDPRemTable(lldpRem.rows);
  console.log('Neighbor trovati:', parsed.length);
  
  parsed.slice(0, 10).forEach((n, i) => {
    console.log(`${i+1}. localPort: ${n.localPort} | remIndex: ${n.remIndex} | sysName: ${n.sysName || 'NULL'} | chassisId: ${n.chassisId || 'NULL'} | portId: ${n.portId || 'NULL'}`);
  });

  // Test discovery completo
  console.log('\n=== Discovery completo ===');
  const discovery = await snmp.discoverProtocols(testIp, 15000);
  console.log('LLDP neighbors:', discovery.lldp.length);
  console.log('CDP neighbors:', discovery.cdp.length);
  console.log('Protocolli:', discovery.protocols.join(', '));
  
  discovery.lldp.slice(0, 10).forEach((n, i) => {
    console.log(`${i+1}. sysName: ${n.sysName || 'NULL'} | chassisId: ${n.chassisId || 'NULL'} | IP: ${n.ip || 'NULL'} | portId: ${n.portId || 'NULL'}`);
  });

} catch (err) {
  console.error('Errore:', err.message);
}



