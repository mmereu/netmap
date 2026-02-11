#!/usr/bin/env node
/**
 * Test diretto agli agenti (senza triage)
 */

import { run, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { discoveryAgent } from './discoveryAgent.js';

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

console.log('🤖 Test Diretto Discovery Agent\n');
console.log('='.repeat(50));

async function test() {
  try {
    console.log('\n📝 Query: Quanti dispositivi ci sono?');
    console.log('-'.repeat(40));

    const result = await run(discoveryAgent, 'Quanti dispositivi ci sono nella rete?', {
      maxTurns: 5  // Limita i turni
    });

    console.log(`Response: ${result.finalOutput}`);
    console.log(`Turns: ${result.rawResponses?.length || 'N/A'}`);

    console.log('\n✅ Test completato!');
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

test();
