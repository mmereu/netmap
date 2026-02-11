import SNMPLib from './libsnmp.js';

const snmp = new SNMPLib({ community: 'M0n!tor!nG24' });

async function test() {
  try {
    // Test con 21_L2_RACK 2_12 che sappiamo funziona
    console.log('=== Testing LLDP discovery su 21_L2_RACK 2_12 (192.168.21.12) ===\n');
    const result = await snmp.discoverProtocols('192.168.21.12', 30000);

    console.log('SysName:', result.sysName);
    console.log('LLDP neighbors trovati:', result.lldp?.length || 0);

    if (result.lldp && result.lldp.length > 0) {
      console.log('\n--- LLDP Neighbors (primi 30) ---');
      result.lldp.slice(0, 30).forEach(n => {
        console.log(`  Port ${n.localPort}: ${n.sysname || n.chassisId} (${n.remotePort || n.portId})`);
      });

      // Conta AP
      const aps = result.lldp.filter(n => n.sysname && (n.sysname.includes('AP') || n.sysname.includes('PDV')));
      console.log('\n--- AP trovati ---');
      console.log('Totale:', aps.length);
      aps.forEach(ap => console.log(`  ${ap.sysname} su porta ${ap.localPort}`));
    }

    console.log('\nCDP neighbors:', result.cdp?.length || 0);

  } catch(e) {
    console.error('Errore:', e.message);
    console.error(e.stack);
  }
}

test();
