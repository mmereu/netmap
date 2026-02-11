# NetMap - Network Intelligence Platform

Real-time MAC address tracking, network topology visualization, and device discovery for enterprise environments with 1200+ network devices.

---

**[English](#english)** | **[Italiano](#italiano)**

---

## English

### Overview

NetMap is an enterprise network intelligence platform that provides:

- **MAC Address Tracking** - Locate any device on the network by MAC address, trace the path from core to access port, identify endpoints vs uplinks
- **Network Topology** - Interactive topology maps with LLDP/CDP link discovery, multi-layer visualization
- **Device Discovery** - SSH-based switch discovery with Huawei, Cisco, Extreme, and other vendor support
- **NeDi Integration** - Direct MySQL integration with NeDi for enriched network data
- **AI-Powered Chat** - Natural language queries via AI agents (Groq/OpenAI) for network troubleshooting

### Architecture

```
Browser (port 4000)
  |
  +-- Express.js (REST API + WebSocket)
  |     |
  |     +-- SQLite (netmap.db) - local device/topology cache
  |     +-- NeDi MySQL - network discovery data
  |     +-- SSH Agent - switch CLI interaction
  |     +-- MAC Cache - in-memory MAC tracking
  |     +-- AI Agents - LLM-powered network assistant
  |
  +-- Static HTML/JS/CSS (no build step)
```

### Quick Start

```bash
# Clone
git clone https://github.com/mmereu/netmap.git
cd netmap

# Configure
cp .env.example .env
# Edit .env with your credentials

# For NeDi integration, also configure:
cp nedi-config.json.example nedi-config.json  # optional, .env takes precedence

# Install & run
npm install
node server.js
# Open http://localhost:4000
```

### Pages

| URL | Description |
|-----|-------------|
| `/mac-tracker.html` | MAC address search and tracking |
| `/index.html` | Network overview dashboard |
| `/discovery.html` | Device discovery interface |
| `/topology-nedi-layer.html` | Interactive topology map |
| `/admin.html` | Administration panel |
| `/ai/chat.html` | AI-powered network assistant |

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search/mac/hybrid?mac=...` | MAC address lookup |
| GET | `/api/devices` | List all discovered devices |
| GET | `/api/devices/:name/detail` | Device detail with interfaces |
| GET | `/api/topology` | Network topology data |
| POST | `/api/agent/chat` | AI agent chat |
| GET | `/api/nedi/sync/status` | NeDi sync status |

### Environment Variables

See [`.env.example`](.env.example) for the complete list. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 4000 |
| `NEDI_MYSQL_HOST` | NeDi MySQL server | - |
| `NEDI_MYSQL_PASS` | NeDi MySQL password | - |
| `NEDI_SSH_HOST` | NeDi SSH server | - |
| `SWITCH_SSH_USER` | Switch SSH username | admin |
| `AI_PROVIDER` | LLM provider (groq/openai) | groq |

### Tech Stack

- **Runtime**: Node.js (ESM)
- **Framework**: Express.js 5
- **Database**: SQLite (better-sqlite3) + MySQL (mysql2)
- **SSH**: ssh2
- **Real-time**: Socket.IO
- **AI**: OpenAI Agents SDK, Groq
- **Frontend**: Vanilla HTML/CSS/JS (no build step)

---

## Italiano

### Panoramica

NetMap e' una piattaforma di network intelligence enterprise che offre:

- **Tracciamento MAC Address** - Localizza qualsiasi dispositivo sulla rete tramite MAC address, traccia il percorso dal core alla porta di accesso, identifica endpoint vs uplink
- **Topologia di Rete** - Mappe topologiche interattive con discovery dei link LLDP/CDP, visualizzazione multi-layer
- **Discovery Dispositivi** - Discovery degli switch via SSH con supporto Huawei, Cisco, Extreme e altri vendor
- **Integrazione NeDi** - Integrazione diretta MySQL con NeDi per dati di rete arricchiti
- **Chat AI** - Query in linguaggio naturale tramite agenti AI (Groq/OpenAI) per troubleshooting di rete

### Avvio Rapido

```bash
# Clona
git clone https://github.com/mmereu/netmap.git
cd netmap

# Configura
cp .env.example .env
# Modifica .env con le tue credenziali

# Installa e avvia
npm install
node server.js
# Apri http://localhost:4000
```

### Struttura Progetto

```
netmap/
  server.js          # Server Express principale (API + routing)
  libdb.js           # Database SQLite (cache locale)
  libnedi.js         # Adapter NeDi MySQL
  libsnmp.js         # Libreria SNMP (legacy)
  libmap.js          # Generazione mappe
  libping.js         # Ping utility
  sshAgent.js        # Agente SSH per comandi remoti
  sshConfig.js       # Configurazione server SSH
  lib/               # Moduli core
    switchSSH.js         # Client SSH per switch
    switchTelnet.js      # Client Telnet per switch
    huaweiLldpParser.js  # Parser LLDP Huawei
    directMacSearch.js   # Ricerca MAC diretta su NeDi
    sshMacCollector.js   # Collettore MAC via SSH
    MacCache.js          # Cache MAC in-memory
    NeDiSyncJob.js       # Job sincronizzazione NeDi
    vendors/             # Parser vendor-specific
  agents/             # Agenti AI
  routes/             # Route Express modulari
  public/             # Frontend statico
    mac-tracker.html     # Interfaccia tracciamento MAC
    discovery.html       # Interfaccia discovery
    topology-*.html      # Mappe topologiche
    ai/                  # Chat AI
  docs/               # Documentazione tecnica
```

### Requisiti

- Node.js >= 18
- Accesso SSH agli switch di rete
- (Opzionale) Server NeDi con database MySQL
- (Opzionale) API key Groq o OpenAI per funzionalita' AI

### Licenza

[MIT](LICENSE)
