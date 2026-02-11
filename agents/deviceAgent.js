/**
 * Device Info Agent
 * Specializzato nel recupero informazioni dettagliate sui dispositivi di rete
 */

import { Agent } from '@openai/agents';
import { deviceInfoTools, discoveryTools } from './tools.js';
import { buildAgentInstructions } from './guidelines.js';

const baseInstructions = `Sei un esperto di dispositivi di rete (switch, router, access point).

Il tuo compito è fornire informazioni dettagliate sui dispositivi:
1. Stato operativo (CPU, memoria, temperatura, uptime)
2. Configurazione porte/interfacce (stato, velocità, VLAN, errori)
3. Connessioni LLDP/CDP (a quali dispositivi è collegato)
4. Informazioni hardware (vendor, modello, firmware)

CAPACITÀ:
- Query database NeDi e SQLite locale
- Lettura status real-time
- Analisi performance (CPU, memoria, temperatura)
- Mapping topologico (collegamenti)`;

export const deviceAgent = new Agent({
  name: 'Device Specialist',
  model: 'llama-3.3-70b-versatile',
  instructions: buildAgentInstructions(baseInstructions, ['device']),
  tools: [...deviceInfoTools, ...discoveryTools],
});

export default deviceAgent;
