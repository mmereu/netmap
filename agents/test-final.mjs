#!/usr/bin/env node
/**
 * Test finale sistema multi-agent
 */

import { run, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { discoveryAgent } from './discoveryAgent.js';
import { macTrackerAgent } from './macTrackerAgent.js';
import { deviceAgent } from './deviceAgent.js';

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error('❌ GROQ_API_KEY non configurata!');
  process.exit(1);
}

// Setup Groq client
const client = new OpenAI({
  apiKey,
  baseURL: 'https://api.groq.com/openai/v1'
});
setDefaultOpenAIClient(client);

console.log('🤖 Test Finale NetMap AI Agents\n');
console.log('Provider: GROQ | Model: llama-3.3-70b-versatile');
console.log('='.repeat(50));

async function runTest(name, agent, query) {
  console.log(`\n📝 ${name}`);
  console.log(`Query: "${query}"`);
  console.log('-'.repeat(40));

  try {
    const start = Date.now();
    const result = await run(agent, query, { maxTurns: 5 });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`✅ Response (${elapsed}s):`);
    console.log(result.finalOutput.slice(0, 300) + (result.finalOutput.length > 300 ? '...' : ''));
  } catch (error) {
    console.error(`❌ Errore: ${error.message}`);
  }
}

async function main() {
  // Test 1: Discovery Agent
  await runTest(
    'Discovery Agent - Statistiche',
    discoveryAgent,
    'Dammi un riepilogo della rete'
  );

  // Test 2: Discovery Agent - Lista dispositivi
  await runTest(
    'Discovery Agent - Lista',
    discoveryAgent,
    'Lista 5 dispositivi'
  );

  // Test 3: MAC Tracker
  await runTest(
    'MAC Tracker - Ricerca',
    macTrackerAgent,
    'Cerca il MAC 00:11:22:33:44:55'
  );

  // Test 4: Device Agent
  await runTest(
    'Device Agent - Info',
    deviceAgent,
    'Mostra info sul primo dispositivo disponibile'
  );

  console.log('\n' + '='.repeat(50));
  console.log('✅ Test completati!');
}

main();
