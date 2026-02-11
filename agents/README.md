# NetMap AI Agents System

Sistema multi-agent basato su OpenAI Agents SDK per la gestione intelligente della rete.

## Architettura

```
                    ┌──────────────────┐
                    │   Triage Agent   │
                    │   (Entry Point)  │
                    └────────┬─────────┘
                             │ handoffs
        ┌───────────────┬────┴────┬───────────────┐
        ▼               ▼         ▼               ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │   MAC     │  │  Device   │  │ Discovery │  │  Trouble  │
  │  Tracker  │  │ Specialist│  │   Agent   │  │  shooter  │
  └───────────┘  └───────────┘  └───────────┘  └───────────┘
```

## Agenti Disponibili

| Agent | Ruolo | Casi d'uso |
|-------|-------|------------|
| **NetMap Assistant** | Triage | Entry point, smista le richieste |
| **MAC Tracker** | Specialist | Ricerca MAC, storico movimenti |
| **Device Specialist** | Specialist | Info dispositivi, porte, status |
| **Network Discovery** | Specialist | Inventario, statistiche, siti |
| **Network Troubleshooter** | Specialist | Diagnosi problemi, eventi |

## Requisiti

- Node.js 18+
- OpenAI API Key

## Setup

```bash
# Installa dipendenze (già fatto nel progetto)
npm install @openai/agents zod@3

# Configura API key
export OPENAI_API_KEY=sk-...
```

## Uso Programmatico

### Chat Semplice

```javascript
import { chat } from './agents/index.js';

const result = await chat('Dove si trova MAC aa:bb:cc:dd:ee:ff?');
console.log(result.response);
console.log(`Gestito da: ${result.agent}`);
```

### Conversazione con Storia

```javascript
import { chat } from './agents/index.js';

const history = [];

await chat('Cerca MAC 00:11:22:33:44:55', history);
await chat('Mostra lo stato del dispositivo trovato', history);
// L'agente ricorda il contesto precedente
```

### Query Diretta a Specialista

```javascript
import { queryAgent } from './agents/index.js';

// Bypassa il triage, vai diretto all'agente
const result = await queryAgent('mac', 'Cerca 00:11:22:33:44:55');
const devices = await queryAgent('discovery', 'Lista tutti gli switch');
```

## API REST

### POST /api/agent/chat

Chat con triage automatico.

```bash
curl -X POST http://localhost:4000/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Dove si trova MAC aa:bb:cc:dd:ee:ff?"}'
```

Response:
```json
{
  "response": "Il MAC aa:bb:cc:dd:ee:ff è stato trovato...",
  "agent": "MAC Tracker",
  "sessionId": "session-123..."
}
```

### POST /api/agent/query

Query diretta a uno specialista.

```bash
curl -X POST http://localhost:4000/api/agent/query \
  -H "Content-Type: application/json" \
  -d '{"agent": "device", "message": "Stato dello switch sw-core-01"}'
```

### GET /api/agent/status

Stato del sistema.

```bash
curl http://localhost:4000/api/agent/status
```

## Tools Disponibili

### MAC Tracker Tools
- `search_mac` - Cerca MAC nella rete
- `get_mac_history` - Storico movimenti MAC

### Device Info Tools
- `get_device_info` - Info dispositivo
- `get_device_full_status` - Status completo (CPU, mem, temp)
- `get_device_ports` - Lista porte/interfacce
- `get_device_connections` - Connessioni LLDP/CDP

### Discovery Tools
- `list_devices` - Lista dispositivi con filtri
- `get_network_stats` - Statistiche rete
- `get_sites` - Lista siti

### Troubleshooting Tools
- `get_device_events` - Eventi/allarmi
- `find_device_by_mac` - Trova device da MAC
- `get_topology` - Topologia rete

## Test

```bash
# Test base
OPENAI_API_KEY=sk-... node agents/test-agents.mjs

# Test API (server deve essere in esecuzione)
curl http://localhost:4000/api/agent/status
```

## Esempi di Richieste

```
"Dove si trova il MAC 00:11:22:33:44:55?"
"Mostra lo stato dello switch sw-core-01"
"Quanti access point ci sono?"
"Lista tutti i dispositivi del sito Milano"
"Il dispositivo 10.1.2.3 non risponde, cosa può essere?"
"Mostra gli ultimi eventi del router rt-edge-01"
```

## Modello

Gli agenti usano `gpt-4o-mini` per un buon bilanciamento tra costi e performance.
Per task più complessi, puoi modificare il modello in ogni agent file.
