#!/usr/bin/env node
/**
 * Test fix Eth-Trunk trace
 */

const mac = '00:00:48:32:51:e2';
const network = '192.168.7.0/24';

console.log('╔═══════════════════════════════════════════════════════════════════╗');
console.log('║         Test Fix Eth-Trunk Trace                                 ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

console.log(`🔍 MAC: ${mac}`);
console.log(`🌐 Network: ${network}\n`);

const start = Date.now();

try {
  const response = await fetch('http://localhost:4000/api/search/mac/hybrid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac, network })
  });

  const result = await response.json();
  const elapsed = Date.now() - start;

  console.log(`⏱ Tempo: ${elapsed}ms\n`);

  if (result.success) {
    console.log('✅ Trace completato!\n');

    if (result.endpoint) {
      console.log('═══ ENDPOINT ═══');
      console.log(`   IP: ${result.endpoint.ip}`);
      console.log(`   Device: ${result.endpoint.sysName}`);
      console.log(`   Port: ${result.endpoint.ifName}`);
      console.log(`   VLAN: ${result.endpoint.vlan}`);
    }

    if (result.path?.length > 0) {
      console.log(`\n═══ PATH (${result.path.length} hops) ═══`);
      result.path.forEach((hop, i) => {
        console.log(`   ${i + 1}. ${hop.sysName || hop.ip} → ${hop.ifName || 'N/A'}`);
      });
    }

    // Verifica se il trace ha seguito l'Eth-Trunk
    const hasEthTrunk = result.path?.some(h => /eth-trunk/i.test(h.ifName || ''));
    if (hasEthTrunk) {
      const foundNeighbor = result.path?.some(h => /07_L2_Rack11/i.test(h.sysName || ''));
      if (foundNeighbor) {
        console.log('\n🎯 FIX FUNZIONA: Trace ha seguito Eth-Trunk al neighbor!');
      } else if (result.path?.length > 1) {
        console.log('\n🎯 FIX FUNZIONA: Trace continua dopo Eth-Trunk!');
      } else {
        console.log('\n⚠ Trace si è fermato a Eth-Trunk (fix non applicato?)');
      }
    }
  } else {
    console.log('❌ Trace fallito:', result.error || 'Unknown error');
    if (result.message) console.log('   Message:', result.message);
  }

} catch (err) {
  console.error('❌ Errore:', err.message);
}

console.log('\n═══════════════════════════════════════════════════════════════════\n');
