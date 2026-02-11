import { chatWithGroq } from './agents/groqDirect.js';

console.log('\n=== TEST FINALE: Cerebras con timeout 60s ===\n');

const start = Date.now();
try {
  const result = await chatWithGroq('Cerca MAC aa:bb:cc:dd:ee:ff', []);
  const elapsed = Date.now() - start;
  console.log('\n=== RISULTATO (tempo:', elapsed, 'ms) ===');
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
