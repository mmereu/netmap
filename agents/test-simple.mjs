#!/usr/bin/env node
/**
 * Test semplificato - solo chat senza tools
 */

import { run } from '@openai/agents';
import { Agent, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';

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

console.log('🤖 Test Semplificato - Groq + OpenAI Agents SDK\n');

// Agent semplice senza tools
const simpleAgent = new Agent({
  name: 'Simple Assistant',
  model: 'llama-3.3-70b-versatile',
  instructions: `Sei un assistente di rete. Rispondi in italiano in modo conciso.
Quando ti chiedono informazioni sulla rete, spiega che puoi aiutare con:
- Ricerca MAC address
- Info dispositivi
- Statistiche rete
- Troubleshooting`
});

async function test() {
  try {
    console.log('📝 Test: Chat semplice senza tools');
    console.log('-'.repeat(40));

    const result = await run(simpleAgent, 'Ciao! Cosa puoi fare?');
    console.log(`Response: ${result.finalOutput}`);

    console.log('\n✅ Test completato!');
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

test();
