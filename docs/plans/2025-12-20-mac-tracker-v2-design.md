# MAC Tracker v2 - Design Document

> **Data**: 2025-12-20
> **Autore**: Claude Code + Marco
> **Status**: Approvato, in implementazione

---

## Problema

Il MAC Tracker attuale ha due problemi principali:

1. **Lentezza**: La ricerca impiega 1-2 minuti (SSH trace sequenziale)
2. **Informazioni mancanti**: Non mostra IP, storico movimenti, VLAN history, multi-switch, LLDP completo

---

## Soluzione: "Instant + Progressive"

### Flusso

```
User Input → FASE 1 (0-500ms) → FASE 2 (background)
                  ↓                    ↓
            Query parallele      SSH trace async
            SQLite + NeDi        Update UI live
                  ↓                    ↓
            Render immediato     Badge "⚡ Live"
            Badge "📦 Cache"
```

### Vantaggi

- Risultato istantaneo (<500ms) da database
- Refresh live in background senza bloccare UI
- Tutti i dati richiesti in un'unica vista

---

## Architettura

### Nuovo Endpoint API

```
POST /api/search/mac/instant
Body: { mac, network, liveRefresh: true }
```

### Response Structure

```javascript
{
  // Meta
  query: "aa:bb:cc:dd:ee:ff",
  phase: "db" | "live",
  elapsed: "0.3s",

  // Posizione attuale
  endpoint: {
    switch, switchIp, port, vlan, macCount, portType, source
  },

  // ARP / IP (NUOVO)
  arpInfo: {
    ip, lastSeen, source
  },

  // Vendor
  vendor: {
    name, oui, icon
  },

  // LLDP Details (NUOVO - espanso)
  lldpInfo: {
    sysName, sysDescription, capabilities, managementIp
  },

  // Tutti gli switch (NUOVO)
  allSwitches: [
    { switch, ip, port, vlan, macCount, isEndpoint, source }
  ],

  // Storico movimenti (NUOVO)
  history: [
    { date, switch, port, vlan, firstSeen, lastSeen }
  ],

  // VLAN history (NUOVO)
  vlanHistory: [
    { vlan, name, firstSeen, current }
  ],

  // Path trace
  path: [
    { hop, switch, ip, port, vlan }
  ]
}
```

---

## UI Layout

### Struttura

```
┌─────────────────────────────────────────────────────┐
│  [MAC Input] [Network ▼] [🔍 TRACE] [⏱️ 0.3s]      │
├─────────────────────────────────────────────────────┤
│                              │                      │
│   PATH VISUALIZATION (65%)   │  DETAIL PANEL (35%) │
│                              │                      │
│   🌐 ──▶ 📡 ──▶ 🔌          │  📍 Posizione       │
│   Core   Switch  Device      │  🌐 ARP/IP          │
│                              │  📡 LLDP Details    │
│   [📦 Cache] [⏳ Loading...] │                      │
│                              │                      │
├─────────────────────────────────────────────────────┤
│  [📊 Multi-Switch] [📅 Storico] [🏷️ VLAN] [📋 Logs]│
│  ┌─────────────────────────────────────────────────┐│
│  │ Switch        │ Porta    │ VLAN │ MAC# │ Source││
│  │ 31_L2_3100PWR │ GE0/0/11 │ 1001 │ 1    │ ⚡Live ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### Indicatori di Stato

| Badge | Significato |
|-------|-------------|
| `📦 Cache` | Dati da database (NeDi/SQLite) |
| `⏳ Refreshing...` | SSH trace in corso |
| `⚡ Live` | Dati aggiornati via SSH |
| `● Verde` | Endpoint trovato |
| `○ Grigio` | Non trovato |

---

## File da Modificare

| File | Tipo | Effort |
|------|------|--------|
| `libnedi.js` | Modifica | 30 min |
| `server.js` | Modifica | 45 min |
| `public/mac-tracker.css` | Nuovo | 20 min |
| `public/mac-tracker.html` | Riscrittura | 60 min |

### Ordine Implementazione

1. `libnedi.js` - Nuovi metodi query NeDi
2. `server.js` - Endpoint `/api/search/mac/instant`
3. `mac-tracker.css` - Stili nuovo layout
4. `mac-tracker.html` - Frontend completo
5. Test & Debug

---

## Nuovi Metodi libnedi.js

```javascript
// ARP lookup
async getArpInfo(mac)

// Storico movimenti (ultimi N giorni)
async getMacHistory(mac, days = 30)

// VLAN history
async getVlanHistory(mac)

// Tutti gli switch con questo MAC
async getAllSwitchesForMac(mac)

// LLDP details completi
async getLldpDetails(device, port)
```

---

## Query SQL NeDi

```sql
-- ARP Info
SELECT ip, lastseen FROM nodarp
WHERE mac = ? ORDER BY lastseen DESC LIMIT 1;

-- Storico movimenti
SELECT device, ifname, vlan, firstseen, lastseen
FROM nodes WHERE mac = ?
AND lastseen > UNIX_TIMESTAMP() - 2592000
ORDER BY lastseen DESC;

-- VLAN History
SELECT DISTINCT vlan, MAX(lastseen) as lastSeen
FROM nodes WHERE mac = ? GROUP BY vlan;

-- Tutti gli switch
SELECT d.name, d.ip, n.ifname, n.vlan,
       (SELECT COUNT(*) FROM nodes n2
        WHERE n2.device = n.device AND n2.ifname = n.ifname) as macCount
FROM nodes n
JOIN devices d ON n.device = d.name
WHERE n.mac = ?;
```

---

## Fonti Dati

| Campo | Fonte Primaria | Fallback | Latenza |
|-------|---------------|----------|---------|
| endpoint | NeDi `nodes` | SSH trace | 50ms / 30s |
| arpInfo | NeDi `nodarp` | SQLite `arp` | 50ms |
| vendor | OUI Database | IEEE lookup | 1ms |
| lldpInfo | NeDi `links` | SSH | 50ms / 5s |
| allSwitches | NeDi `nodes` | SSH parallel | 50ms / 10s |
| history | NeDi `nodes` | SQLite `fdb` | 100ms |
| vlanHistory | NeDi `vlans` | SQLite | 50ms |

---

## Testing

### Test Cases

1. MAC noto in NeDi → risultato istantaneo
2. MAC non in NeDi → fallback SSH
3. MAC con storico movimenti → timeline popolata
4. MAC su multiple switch → tab Multi-Switch popolato
5. MAC con LLDP neighbor → dettagli LLDP completi
6. Network filter → ricerca limitata a subnet

### Comandi Test

```bash
# Test endpoint
curl -X POST http://localhost:3000/api/search/mac/instant \
  -H "Content-Type: application/json" \
  -d '{"mac":"00:e6:0e:5c:62:40","network":"192.168.1.0/24"}'

# Test con MAC noto
node test-mac-tracker-v2.mjs 00:e6:0e:5c:62:40

# Benchmark performance
node benchmark-mac-tracker.mjs
```

---

## Rollback Plan

Se necessario rollback:
1. Il file `mac-tracker.html` originale è in git history
2. L'endpoint `/api/search/mac/hybrid` rimane funzionante
3. Nessuna modifica al database schema

---

## Approvazione

- [x] Architettura approvata
- [x] UI Layout approvato
- [x] Struttura dati approvata
- [x] File da modificare approvati
- [x] Implementazione completata (2025-12-20)
- [ ] Testing completato

## Implementazione Completata

### File Modificati/Creati

| File | Tipo | Righe |
|------|------|-------|
| `libnedi.js` | Modifica | +270 righe (6 nuovi metodi) |
| `server.js` | Modifica | +115 righe (endpoint /api/search/mac/instant) |
| `public/mac-tracker.css` | Nuovo | 450 righe |
| `public/mac-tracker.html` | Riscrittura | 675 righe |

### Nuovi Metodi libnedi.js

- `getArpInfo(mac)` - IP associato al MAC
- `getMacHistory(mac, days)` - Storico movimenti
- `getVlanHistory(mac)` - VLAN history
- `getAllSwitchesForMac(mac)` - Tutti gli switch
- `getLldpDetails(device, port)` - Dettagli LLDP
- `searchMacInstant(mac)` - Aggregazione parallela
