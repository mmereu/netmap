#!/usr/bin/env node

/**
 * Test end-to-end per la ricerca MAC via AI Agent Chat
 *
 * Questo simula il flusso:
 * 1. Utente digita in /ai/chat.html: "trova 00:e6:0e:71:24:80"
 * 2. POST /api/agent/chat con il messaggio
 * 3. Triage Agent smista a MAC Tracker Agent
 * 4. MAC Tracker Agent chiama il tool search_mac
 * 5. search_mac chiama /api/search/mac/hybrid
 * 6. /api/search/mac/hybrid usa NeDi.searchMac() - ORA FIXATO
 */

import fetch from 'node-fetch';

const REMOTE_URL = process.env.NETMAP_URL || 'http://localhost:4000';

const tests = [
  {
    name: 'MAC standard colon format',
    message: 'Dove si trova il MAC address 00:e6:0e:71:24:80?'
  },
  {
    name: 'MAC con hyphen format',
    message: 'Cerca il MAC 00-e6-0e-71-24-80 nella rete'
  },
  {
    name: 'MAC dot format',
    message: 'Trova MAC 00e6.0e71.2480'
  },
  {
    name: 'Partial MAC search',
    message: 'Dove è il MAC che inizia con 00e6?'
  }
];

async function testAgentChat() {
  console.log('\n========================================');
  console.log('Testing AI Agent MAC Search');
  console.log(`Remote: ${REMOTE_URL}`);
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    console.log(`TEST: ${test.name}`);
    console.log(`  Message: "${test.message}"`);

    try {
      const response = await fetch(`${REMOTE_URL}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: test.message }),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.error) {
        console.log(`  ✗ FAIL - API error: ${result.error}`);
        failed++;
      } else if (!result.response) {
        console.log(`  ✗ FAIL - No response from agent`);
        failed++;
      } else {
        // Verifica che la risposta non contenga errori SQL
        if (result.response.includes('SYNTAX') || result.response.includes('SQL')) {
          console.log(`  ✗ FAIL - SQL error in response`);
          failed++;
        } else {
          console.log(`  ✓ PASS`);
          console.log(`    Agent: ${result.agent}`);
          console.log(`    Response (first 150 chars): ${result.response.substring(0, 150)}...`);
          passed++;
        }
      }
    } catch (err) {
      console.log(`  ✗ FAIL - ${err.message}`);
      failed++;
    }
    console.log();
  }

  console.log('========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

testAgentChat();
