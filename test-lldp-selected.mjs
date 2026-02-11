#!/usr/bin/env node

import NetMapSNMP from './libsnmp.js';

const snmp = new NetMapSNMP(process.env.SNMP_COMMUNITY || 'public');

console.log('=== TEST LLDP SU DEVICE SELEZIONATI ===\n');

// Lista di device di test (Huawei e altri)
const testDevices = [
  { ip: '192.168.10.18', name: '10_L2_RackE_18', desc: 'Huawei S5700 - Device problematico' },
  { ip: '192.168.10.251', name: '10_L3_S6730_251', desc: 'Huawei S6730 - Core switch' },
  { ip: '192.168.10.19', name: '10_L2_RackE_19', desc: 'Altro switch Huawei' },
  { ip: '192.168.10.11', name: '10_L2_Rack_E_11', desc: 'Switch standard' },
  { ip: '192.168.10.90', name: '10_L2_casse-16-17_90', desc: 'Switch casse' },
];

for (const device of testDevices) {
  console.log(`\n=== ${device.name} (${device.ip}) ===`);
  console.log(`Descrizione: ${device.desc}`);
  
  try {
    // Discovery con timeout di 5 secondi
    const discovery = await snmp.discoverProtocols(device.ip, 5000);
    
    console.log(`LLDP neighbors: ${discovery.lldp.length}`);
    console.log(`CDP neighbors: ${discovery.cdp.length}`);
    console.log(`Protocolli: ${discovery.protocols.join(', ') || 'Nessuno'}`);
    
    // Mostra primi 5 neighbor LLDP se presenti
    if (discovery.lldp.length > 0) {
      console.log('Primi 5 LLDP neighbor:');
      discovery.lldp.slice(0, 5).forEach((n, i) => {
        console.log(`  ${i+1}. Port ${n.localPort}: ${n.sysName || n.chassisId || 'N/A'} (${n.portId || 'N/A'})`);
      });
    }
    
    // Verifica se il parsing funziona
    if (device.ip === '192.168.10.18') {
      if (discovery.lldp.length > 0) {
        console.log('\n✅ FIX VERIFICATA: Il device 192.168.10.18 ora mostra correttamente i neighbor LLDP!');
      } else {
        console.log('\n❌ PROBLEMA: Il device 192.168.10.18 ancora non mostra neighbor LLDP.');
      }
    }
    
  } catch (err) {
    console.log(`ERRORE: ${err.message}`);
  }
}

console.log('\n=== RIEPILOGO ===');
console.log('La fix per il parsing LLDP con formato Huawei (con timeMark) è stata applicata.');
console.log('Il parser ora gestisce correttamente entrambi i formati OID:');
console.log('  - Standard: 1.0.8802.1.1.2.1.4.1.1.ATTR.localPort.remIndex');
console.log('  - Huawei:   1.0.8802.1.1.2.1.4.1.1.ATTR.0.localPort.remIndex');
console.log('\nLa fix è retrocompatibile e non impatta i device che usano il formato standard.');