#!/usr/bin/env node
/**
 * Test con un singolo tool
 */

import { run, Agent, tool, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

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

console.log('🤖 Test Tool - Groq + OpenAI Agents SDK\n');

// Tool semplice
const getNetworkStats = tool({
  name: 'get_network_stats',
  description: 'Ottiene statistiche della rete: numero dispositivi, switch, router, access point',
  parameters: z.object({}),
  async execute() {
    // Dati mock per test
    return JSON.stringify({
      totalDevices: 1314,
      switches: 890,
      routers: 24,
      accessPoints: 400,
      lastSync: '2025-12-21T10:30:00Z'
    });
  }
});

// Agent con tool
const statsAgent = new Agent({
  name: 'Stats Agent',
  model: 'llama-3.3-70b-versatile',
  instructions: `Sei un assistente di rete. Usa il tool get_network_stats per rispondere alle domande sulle statistiche.
Rispondi in italiano in modo chiaro e conciso.`,
  tools: [getNetworkStats]
});

async function test() {
  try {
    console.log('📝 Test: Agent con tool');
    console.log('-'.repeat(40));

    const result = await run(statsAgent, 'Quanti dispositivi ci sono nella rete?');
    console.log(`Response: ${result.finalOutput}`);

    console.log('\n✅ Test completato!');
  } catch (error) {
    console.error('❌ Errore:', error.message);
    if (error.cause) console.error('Causa:', error.cause);
  }
}

test();
