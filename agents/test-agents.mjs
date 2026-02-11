#!/usr/bin/env node
/**
 * Test script per il sistema multi-agent NetMap
 *
 * Uso con Groq (default, gratis):
 *   GROQ_API_KEY=gsk_... node agents/test-agents.mjs
 *
 * Uso con OpenAI:
 *   AI_PROVIDER=openai OPENAI_API_KEY=sk-... node agents/test-agents.mjs
 */

import { chat, queryAgent, initAgents } from './index.js';

// Check API key
const provider = process.env.AI_PROVIDER || 'groq';
const apiKey = provider === 'groq'
  ? process.env.GROQ_API_KEY
  : process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error(`❌ ${provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY'} non configurata!`);
  console.error(`   Esporta la variabile: export ${provider === 'groq' ? 'GROQ_API_KEY=gsk_...' : 'OPENAI_API_KEY=sk-...'}`);
  process.exit(1);
}

console.log('🤖 Test NetMap AI Agents System\n');
console.log(`Provider: ${provider.toUpperCase()}`);
console.log(`Model: ${provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini'}`);
console.log('=' .repeat(50));

async function runTests() {
  try {
    // Test 1: Chat con triage
    console.log('\n📝 Test 1: Chat con Triage Agent');
    console.log('-'.repeat(40));

    const result1 = await chat('Quanti dispositivi ci sono nella rete?');
    console.log(`Agent: ${result1.agent}`);
    console.log(`Response: ${result1.response.slice(0, 200)}...`);

    // Test 2: Query diretta a MAC Tracker
    console.log('\n📝 Test 2: Query diretta a MAC Tracker');
    console.log('-'.repeat(40));

    const result2 = await queryAgent('mac', 'Cerca il MAC 00:11:22:33:44:55');
    console.log(`Response: ${result2.slice(0, 200)}...`);

    // Test 3: Query diretta a Device Agent
    console.log('\n📝 Test 3: Query diretta a Device Agent');
    console.log('-'.repeat(40));

    const result3 = await queryAgent('device', 'Lista i siti disponibili');
    console.log(`Response: ${result3.slice(0, 200)}...`);

    // Test 4: Conversazione con storia
    console.log('\n📝 Test 4: Conversazione con storia');
    console.log('-'.repeat(40));

    const history = [];
    const r1 = await chat('Mostrami le statistiche della rete', history);
    console.log(`1. ${r1.agent}: ${r1.response.slice(0, 100)}...`);

    const r2 = await chat('Quanti switch ci sono?', history);
    console.log(`2. ${r2.agent}: ${r2.response.slice(0, 100)}...`);

    console.log('\n' + '='.repeat(50));
    console.log('✅ Tutti i test completati!');

  } catch (error) {
    console.error('\n❌ Errore durante i test:', error.message);
    process.exit(1);
  }
}

runTests();
