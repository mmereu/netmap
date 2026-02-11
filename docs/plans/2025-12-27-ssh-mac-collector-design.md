# SSH MAC Collector - Design Document

**Data:** 2025-12-27
**Autore:** Claude + Marco Mereu
**Status:** Approvato

## Problema

NeDi raccoglie MAC via SNMP Bridge-MIB ma perde ~70% dei MAC sugli switch Huawei:
- Test: 22 MAC cercati → solo 6 trovati in NeDi (27%)
- SSH `display mac-address` → trova tutti i 22 (100%)

**Causa:** SNMP Bridge-MIB non include tutti i MAC da tutte le VLAN sugli Huawei.

## Soluzione

Approccio **ibrido**: NeDi per topologia + SSH collector per MAC completi.

### Architettura

```
┌─────────────────────────────────────────────────────────┐
│                    NetMap Server                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                  │
│  │ NeDi Sync    │    │ SSH MAC      │                  │
│  │ (esistente)  │    │ Collector    │  ← NUOVO         │
│  │ ogni 5min    │    │ ogni 15min   │                  │
│  └──────┬───────┘    └──────┬───────┘                  │
│         │                   │                          │
│         │    ┌──────────────┘                          │
│         ▼    ▼                                         │
│  ┌─────────────────┐                                   │
│  │  NeDi MySQL     │  ← tabella `nodes`                │
│  │  nedi-host      │    (MAC unificati)                │
│  └─────────────────┘                                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Decisioni di Design

| Aspetto | Scelta | Motivazione |
|---------|--------|-------------|
| Frequenza | Ogni 15 minuti | Bilancia freshness e carico SSH |
| Scope | Solo switch Huawei | Focus sul problema reale |
| Storage | NeDi MySQL diretto | Tutto unificato in un DB |
| Conflitti | SSH vince sempre | Dati real-time più affidabili |
| Concorrenza | ON DUPLICATE KEY UPDATE | MySQL gestisce atomicamente |

## Componenti

### 1. SSH MAC Collector (`lib/sshMacCollector.js`)

```javascript
class SshMacCollector {
  constructor(nediDb) {
    this.nedi = nediDb;
    this.interval = 15 * 60 * 1000; // 15 minuti
    this.concurrency = 5; // switch in parallelo
  }

  // Ottieni lista switch Huawei da NeDi
  async getHuaweiSwitches() {
    // SELECT device, devip FROM devices
    // WHERE sysobjid LIKE '1.3.6.1.4.1.2011%'
  }

  // SSH e parse MAC table
  async collectMacsFromSwitch(ip, credentials) {
    // ssh admin@ip "display mac-address"
    // Parse: MAC | VLAN | Port | Type
  }

  // Upsert in NeDi
  async upsertMacs(macs) {
    // INSERT INTO nodes ... ON DUPLICATE KEY UPDATE
  }

  // Job principale
  async run() {
    const switches = await this.getHuaweiSwitches();
    // Process in batch di 5 paralleli
  }
}
```

### 2. Parser Huawei MAC Table

**Input (output `display mac-address`):**
```
MAC Address    VLAN/VSI/BD   Learned-From        Type
-------------------------------------------------------------------------------
00e6-0e5b-e740 1001          GE0/0/5             dynamic
00e6-0e5b-e780 1             GE0/0/23            dynamic
```

**Parser:**
```javascript
function parseHuaweiMacTable(output) {
  const regex = /^([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\s+(\d+)\s+(\S+)\s+(dynamic|static)/gmi;
  // Normalizza MAC: 00e6-0e5b-e740 → 00e60e5be740 (formato NeDi)
  return matches.map(m => ({
    mac: m[1].replace(/-/g, '').toLowerCase(),
    vlan: parseInt(m[2]),
    port: m[3],
    type: m[4]
  }));
}
```

### 3. Schema NeDi `nodes`

```sql
-- Tabella esistente
nodes (
  mac       VARCHAR(12) PRIMARY KEY,  -- formato: 00e60e5be740
  device    VARCHAR(64),              -- nome switch
  ifname    VARCHAR(32),              -- porta (GE0/0/5)
  vlanid    INT,                      -- VLAN ID
  firstseen DATETIME,
  lastseen  DATETIME
)

-- Query upsert
INSERT INTO nodes (mac, device, ifname, vlanid, firstseen, lastseen)
VALUES (?, ?, ?, ?, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  device = VALUES(device),
  ifname = VALUES(ifname),
  vlanid = VALUES(vlanid),
  lastseen = NOW()
```

### 4. Scheduling

```javascript
// In server.js
import { SshMacCollector } from './lib/sshMacCollector.js';

const macCollector = new SshMacCollector(nediDb);

// Ogni 15 minuti
setInterval(() => macCollector.run(), 15 * 60 * 1000);

// Prima esecuzione dopo 2 minuti dall'avvio
setTimeout(() => macCollector.run(), 2 * 60 * 1000);
```

### 5. API Endpoints

| Endpoint | Metodo | Descrizione |
|----------|--------|-------------|
| `/api/admin/mac-collector/status` | GET | Stato e statistiche |
| `/api/admin/mac-collector/run` | POST | Trigger manuale |
| `/api/admin/mac-collector/logs` | GET | Ultimi 100 log |

**Response `/status`:**
```json
{
  "lastRun": "2025-12-27T20:15:00Z",
  "nextRun": "2025-12-27T20:30:00Z",
  "stats": {
    "switchesTotal": 44,
    "switchesOk": 42,
    "switchesFailed": 2,
    "macsInserted": 156,
    "macsUpdated": 1203,
    "macsTotal": 1359,
    "duration": 45000
  }
}
```

## Error Handling

```javascript
async collectFromSwitch(ip) {
  try {
    const result = await sshExec(ip, 'display mac-address', { timeout: 30000 });
    return { success: true, macs: parse(result) };
  } catch (err) {
    console.error(`[MAC-Collector] ${ip} failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
```

**Retry Logic:**
- 1 retry dopo 5 secondi se SSH fallisce
- Skip switch se fallisce 2 volte consecutive
- Alert se >20% switch falliscono in un run

**Health Check:**
- Se 3 run consecutivi falliscono >50% switch → log WARNING
- Endpoint `/api/health` include stato collector

## File da Creare/Modificare

| File | Azione | Descrizione |
|------|--------|-------------|
| `lib/sshMacCollector.js` | CREATE | Collector principale |
| `lib/huaweiLldpParser.js` | MODIFY | Aggiungere parseHuaweiMacTable() |
| `server.js` | MODIFY | Scheduling + API endpoints |
| `public/admin.html` | MODIFY | Widget status collector |

## Test Plan

1. **Unit test parser:** Input sample → output corretto
2. **Integration test:** SSH a 1 switch → MAC in DB
3. **Full test:** Run completo → verifica 22 MAC originali ora in NeDi
4. **Stress test:** 44 switch in parallelo, verifica no timeout

## Metriche di Successo

- [ ] 100% dei MAC trovati via SSH ora in NeDi
- [ ] Run completo < 5 minuti per 44 switch
- [ ] Zero conflitti con NeDi sync esistente
- [ ] API status funzionante
