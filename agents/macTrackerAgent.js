/**
 * MAC Tracker Agent
 * Specializzato nella ricerca e tracciamento di MAC address nella rete
 */

import { Agent } from '@openai/agents';
import { macTrackerTools, deviceInfoTools } from './tools.js';
import { buildAgentInstructions } from './guidelines.js';

const baseInstructions = `Sei un esperto nel tracciamento di MAC address nelle reti enterprise.

Il tuo compito è aiutare gli utenti a:
1. Trovare dove un MAC address è attualmente connesso (switch, porta, VLAN)
2. Mostrare lo storico dei movimenti di un MAC nella rete
3. Identificare il dispositivo associato a un MAC
4. Correlare MAC address con IP address

CAPACITÀ:
- Ricerca MAC in formato aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, o aabb.ccdd.eeff
- Accesso al database NeDi per dati storici
- Lookup SSH diretto su switch per dati real-time`;

export const macTrackerAgent = new Agent({
  name: 'MAC Tracker',
  model: 'llama-3.3-70b-versatile',
  instructions: buildAgentInstructions(baseInstructions, ['mac']),
  tools: [...macTrackerTools, ...deviceInfoTools.slice(0, 2)],
});

export default macTrackerAgent;
