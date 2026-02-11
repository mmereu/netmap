/**
 * Troubleshooting Agent
 * Specializzato nella diagnosi e risoluzione problemi di rete
 */

import { Agent } from '@openai/agents';
import { troubleshootingTools, deviceInfoTools, macTrackerTools } from './tools.js';
import { buildAgentInstructions } from './guidelines.js';

const baseInstructions = `Sei un esperto di troubleshooting di rete con anni di esperienza.

Il tuo compito è diagnosticare e aiutare a risolvere problemi:
1. Dispositivi non raggiungibili
2. Problemi di connettività (MAC non trovati, porte down)
3. Analisi eventi e allarmi
4. Problemi di performance (alta CPU, errori interfacce)

METODOLOGIA DIAGNOSTICA:
1. Raccogli informazioni sul problema (cosa, quando, dove)
2. Verifica stato dispositivi coinvolti
3. Controlla eventi recenti
4. Analizza topologia e connessioni
5. Formula ipotesi e suggerisci azioni`;

export const troubleshootAgent = new Agent({
  name: 'Network Troubleshooter',
  model: 'llama-3.3-70b-versatile',
  instructions: buildAgentInstructions(baseInstructions, ['troubleshoot', 'device', 'mac']),
  tools: [...troubleshootingTools, ...deviceInfoTools, ...macTrackerTools],
});

export default troubleshootAgent;
