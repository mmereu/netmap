#!/usr/bin/env node

/**
 * Test filtro porte fisiche vs VLAN interfaces
 * Verifica che l'endpoint /api/search/mac/hybrid preferisca porte fisiche
 */

// Simula la funzione isPhysicalPort
const isPhysicalPort = (ifname) => {
  if (!ifname) return false;
  const physical = /^(GE|XGE|10GE|Eth|Ethernet|Gi|Fa|Te|fo|ge|xe)/i.test(ifname);
  const vlanIf = /^(Vl|VLAN|Vlanif|Vlif)/i.test(ifname);
  return physical && !vlanIf;
};

// Test cases
const testCases = [
  // Porte fisiche (dovrebbero essere TRUE)
  { ifname: 'GE1/0/18', expected: true, description: 'Porta Huawei Gigabit Ethernet' },
  { ifname: 'XGE1/0/1', expected: true, description: 'Porta Huawei 10 Gigabit Ethernet' },
  { ifname: '10GE1/0/1', expected: true, description: 'Porta 10GE format alternativo' },
  { ifname: 'Eth-Trunk1', expected: true, description: 'Link aggregation Huawei' },
  { ifname: 'Ethernet1/1', expected: true, description: 'Porta Ethernet standard' },
  { ifname: 'GigabitEthernet0/0/1', expected: true, description: 'Porta Cisco GigabitEthernet' },
  { ifname: 'Gi1/0/1', expected: true, description: 'Porta Cisco Gi abbreviato' },
  { ifname: 'Fa0/1', expected: true, description: 'Porta Cisco FastEthernet' },
  { ifname: 'Te1/0/1', expected: true, description: 'Porta Cisco TenGigabitEthernet' },
  { ifname: 'ge-0/0/0', expected: true, description: 'Porta Juniper gigabit' },
  { ifname: 'xe-0/0/0', expected: true, description: 'Porta Juniper 10-gigabit' },

  // Interfacce VLAN (dovrebbero essere FALSE)
  { ifname: 'Vlanif1', expected: false, description: 'VLAN interface Huawei' },
  { ifname: 'Vlif100', expected: false, description: 'VLAN interface format abbreviato' },
  { ifname: 'VLAN10', expected: false, description: 'VLAN interface standard' },
  { ifname: 'Vl200', expected: false, description: 'VLAN interface abbreviato' },

  // Edge cases
  { ifname: null, expected: false, description: 'NULL ifname' },
  { ifname: '', expected: false, description: 'Empty string' },
  { ifname: 'Unknown', expected: false, description: 'Interfaccia sconosciuta' },
];

console.log('='.repeat(80));
console.log('TEST: Filtro Porte Fisiche vs VLAN Interfaces');
console.log('='.repeat(80));
console.log();

let passed = 0;
let failed = 0;

testCases.forEach((test, index) => {
  const result = isPhysicalPort(test.ifname);
  const status = result === test.expected ? '✅ PASS' : '❌ FAIL';

  if (result === test.expected) {
    passed++;
  } else {
    failed++;
  }

  console.log(`Test ${index + 1}: ${status}`);
  console.log(`  Interface: "${test.ifname}"`);
  console.log(`  Description: ${test.description}`);
  console.log(`  Expected: ${test.expected}, Got: ${result}`);
  console.log();
});

console.log('='.repeat(80));
console.log(`RISULTATI: ${passed} passed, ${failed} failed`);
console.log('='.repeat(80));

// Test sorting
console.log();
console.log('='.repeat(80));
console.log('TEST: Ordinamento Array con Porte Fisiche e VLAN');
console.log('='.repeat(80));
console.log();

const mockResults = [
  { interface: 'Vlanif1', device: 'SW-TEST-01', vlan: 1 },
  { interface: 'GE1/0/18', device: 'SW-TEST-01', vlan: 10 },
  { interface: 'Vlif100', device: 'SW-TEST-02', vlan: 100 },
  { interface: 'XGE1/0/1', device: 'SW-TEST-03', vlan: 20 },
  { interface: 'VLAN200', device: 'SW-TEST-04', vlan: 200 },
];

console.log('PRIMA dell\'ordinamento:');
mockResults.forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.interface} (${r.device}) - Physical: ${isPhysicalPort(r.interface)}`);
});

// Ordina
mockResults.sort((a, b) => {
  const aPhys = isPhysicalPort(a.interface);
  const bPhys = isPhysicalPort(b.interface);
  if (aPhys && !bPhys) return -1;
  if (!aPhys && bPhys) return 1;
  return 0;
});

console.log();
console.log('DOPO ordinamento (porte fisiche prima):');
mockResults.forEach((r, i) => {
  const isPhys = isPhysicalPort(r.interface);
  const label = isPhys ? '🔌 Physical' : '🌐 VLAN';
  console.log(`  ${i + 1}. ${r.interface} (${r.device}) - ${label}`);
});

console.log();
console.log(`Risultato migliore (best): ${mockResults[0].interface} (${mockResults[0].device})`);
console.log();

if (isPhysicalPort(mockResults[0].interface)) {
  console.log('✅ SUCCESSO: Il primo risultato è una porta fisica!');
} else {
  console.log('⚠️ WARNING: Il primo risultato è una VLAN interface (potrebbero non esserci porte fisiche)');
}

console.log();
console.log('='.repeat(80));

process.exit(failed > 0 ? 1 : 0);
