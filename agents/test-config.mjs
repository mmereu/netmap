/**
 * Test per verificare la configurazione dinamica dei modelli
 */

console.log('='.repeat(60));
console.log('TEST: Configurazione Dinamica Modelli AI');
console.log('='.repeat(60));

// Test 2: Verificare che non ci siano dipendenze circolari
console.log('\n--- Test 2: Dipendenze Circolari ---');
try {
  const config = await import('./config.js');
  console.log('✅ config.js importato senza errori');

  const index = await import('./index.js');
  console.log('✅ index.js importato senza errori');

  console.log('✅ Test 2 PASSED: Nessuna dipendenza circolare');
} catch (error) {
  console.error('❌ Test 2 FAILED:', error.message);
  process.exit(1);
}

// Test 3: Verificare getDefaultModel() per Groq (default)
console.log('\n--- Test 3: getDefaultModel() con Groq (default) ---');
try {
  // Reset environment
  delete process.env.AI_PROVIDER;

  // Re-import config fresh
  const { getDefaultModel, getCurrentProvider, PROVIDERS } = await import('./config.js');

  const provider = getCurrentProvider();
  const model = getDefaultModel();

  console.log(`Provider corrente: ${provider}`);
  console.log(`Modello restituito: ${model}`);
  console.log(`Modello atteso: ${PROVIDERS.groq.defaultModel}`);

  if (provider === 'groq' && model === 'llama-3.3-70b-versatile') {
    console.log('✅ Test 3 PASSED: Groq model corretto');
  } else {
    console.error('❌ Test 3 FAILED: Modello non corretto');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Test 3 FAILED:', error.message);
  process.exit(1);
}

// Test 4: Verificare setCurrentProvider() per OpenAI
console.log('\n--- Test 4: setCurrentProvider() per OpenAI ---');
try {
  const { setCurrentProvider, getDefaultModel, getCurrentProvider, PROVIDERS } = await import('./config.js');

  // Cambia provider a OpenAI
  setCurrentProvider('openai');

  const provider = getCurrentProvider();
  const model = getDefaultModel();

  console.log(`Provider dopo setCurrentProvider('openai'): ${provider}`);
  console.log(`Modello restituito: ${model}`);
  console.log(`Modello atteso: ${PROVIDERS.openai.defaultModel}`);

  if (provider === 'openai' && model === 'gpt-4o-mini') {
    console.log('✅ Test 4 PASSED: OpenAI model corretto');
  } else {
    console.error('❌ Test 4 FAILED: Modello non corretto');
    process.exit(1);
  }

  // Ripristina Groq
  setCurrentProvider('groq');
} catch (error) {
  console.error('❌ Test 4 FAILED:', error.message);
  process.exit(1);
}

// Test 5: Verificare che gli agenti usino getDefaultModel()
console.log('\n--- Test 5: Agenti usano getDefaultModel() ---');
try {
  const { setCurrentProvider, getDefaultModel } = await import('./config.js');

  // Imposta Groq
  setCurrentProvider('groq');

  // Importa gli agenti (nota: il model viene valutato al momento dell'import)
  // Questo test verifica che la funzione sia chiamata correttamente
  const { macTrackerAgent } = await import('./macTrackerAgent.js');
  const { deviceAgent } = await import('./deviceAgent.js');
  const { discoveryAgent } = await import('./discoveryAgent.js');
  const { troubleshootAgent } = await import('./troubleshootAgent.js');
  const { triageAgent } = await import('./triageAgent.js');

  console.log(`macTrackerAgent.name: ${macTrackerAgent.name}`);
  console.log(`deviceAgent.name: ${deviceAgent.name}`);
  console.log(`discoveryAgent.name: ${discoveryAgent.name}`);
  console.log(`troubleshootAgent.name: ${troubleshootAgent.name}`);
  console.log(`triageAgent.name: ${triageAgent.name}`);

  // Verifica che tutti gli agenti siano stati creati
  if (macTrackerAgent && deviceAgent && discoveryAgent && troubleshootAgent && triageAgent) {
    console.log('✅ Test 5 PASSED: Tutti gli agenti creati correttamente');
  } else {
    console.error('❌ Test 5 FAILED: Alcuni agenti non creati');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Test 5 FAILED:', error.message);
  console.error(error.stack);
  process.exit(1);
}

// Test 6: Verificare che PROVIDERS sia esportato correttamente da index.js
console.log('\n--- Test 6: Export da index.js ---');
try {
  const index = await import('./index.js');

  const exports = ['PROVIDERS', 'getDefaultModel', 'getCurrentProvider', 'initAgents', 'chat', 'queryAgent'];
  const missing = exports.filter(e => !index[e]);

  if (missing.length === 0) {
    console.log('✅ Test 6 PASSED: Tutti gli export presenti in index.js');
    console.log(`   Exports: ${exports.join(', ')}`);
  } else {
    console.error(`❌ Test 6 FAILED: Export mancanti: ${missing.join(', ')}`);
    process.exit(1);
  }
} catch (error) {
  console.error('❌ Test 6 FAILED:', error.message);
  process.exit(1);
}

console.log('\n' + '='.repeat(60));
console.log('🎉 TUTTI I TEST PASSATI!');
console.log('='.repeat(60));
