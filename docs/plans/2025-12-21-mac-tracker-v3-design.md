# MAC-Tracker V3 - Design Document

**Data**: 2025-12-21
**Versione**: 1.0
**Status**: Approvato per implementazione

---

## Executive Summary

MAC-Tracker V3 è un'evoluzione del sistema di ricerca MAC address che risolve il problema principale di V2: **la lentezza SSH**. L'approccio è "Cache First + Refresh On-Demand":

- **Lookup istantaneo** (<10ms) da cache in-memory
- **SSH solo su richiesta** esplicita dell'utente
- **Sync background** da NeDi ogni 15 minuti

### Confronto con V2

| Aspetto | V2 | V3 |
|---------|----|----|
| Tempo ricerca | 50-200ms (DB) + 2-5s (SSH auto) | <10ms (cache) |
| SSH | Automatico sempre | Solo bottone "Verifica Live" |
| Dati | Query on-demand | Pre-cached, sync ogni 15min |
| RAM | ~0 (query DB) | ~15MB (cache in-memory) |

---

## 1. Architettura Generale

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAC-Tracker V3                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Frontend   │───▶│  API Layer   │───▶│  MAC Cache   │       │
│  │  (UI Panel)  │    │  (server.js) │    │  (In-Memory) │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│         │                   │                   ▲               │
│         │                   │                   │               │
│         ▼                   ▼                   │               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ 🔄 Refresh   │───▶│  SSH Direct  │    │  NeDi Sync   │       │
│  │   Button     │    │  (on-demand) │    │  (ogni 15m)  │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Componenti

| Componente | Responsabilità |
|------------|----------------|
| **MAC Cache** | Map in-memory con ~25K entries, lookup O(1) |
| **NeDi Sync** | Job background ogni 15 min, popola cache da NeDi |
| **API Layer** | Endpoint `/api/v3/mac/search` - solo lettura cache |
| **SSH Direct** | Chiamato SOLO dal bottone "Verifica Live" |
| **Frontend** | UI con risultato istantaneo + bottone refresh |

### Flussi

**Flusso standard (99% dei casi):**
1. User cerca MAC → API legge cache → risposta <10ms

**Flusso refresh (1% dei casi):**
1. User clicca "🔄 Verifica Live" → SSH verso switch → aggiorna cache → risposta 2-5s

---

## 2. Struttura Cache

### Classe MacCache

```javascript
// lib/MacCache.js

class MacCache {
  constructor() {
    this.cache = new Map();        // MAC → entry (lookup primario)
    this.bySwitch = new Map();     // switch → Set<MAC> (lookup inverso)
    this.byIp = new Map();         // IP → MAC (ricerca per IP)
    this.byVlan = new Map();       // VLAN → Set<MAC> (ricerca per VLAN)
    this.lastSync = null;          // Timestamp ultimo sync NeDi
    this.stats = { hits: 0, misses: 0, refreshes: 0 };
  }

  // Lookup primario O(1)
  get(mac) { ... }

  // Ricerca parziale (prefix match)
  searchByMac(partial) { ... }

  // Lookup per IP
  searchByIp(ip) { ... }

  // Tutti i MAC su uno switch
  getBySwitch(switchName) { ... }

  // Atomic swap durante sync
  swap(newCache) { ... }

  // Aggiorna singolo entry (dopo SSH refresh)
  update(mac, data) { ... }

  // Statistiche
  getAge() { ... }
  getMemoryUsage() { ... }
}
```

### Struttura Entry

```javascript
{
  mac: "aa:bb:cc:dd:ee:ff",           // Chiave primaria (normalizzata)

  // Endpoint corrente (porta fisica)
  endpoint: {
    switch: "MI_SW_01",
    switchIp: "192.168.1.10",
    port: "GigabitEthernet0/0/3",
    vlan: 100,
    macCount: 1,                      // MAC su questa porta
    portType: "access"                // access|uplink
  },

  // Info aggiuntive
  ip: "192.168.1.50",                    // Da ARP table
  hostname: "client-pc",              // Reverse DNS
  vendor: "Apple Inc.",               // OUI lookup

  // Timestamp
  lastSeen: 1703404800,               // Ultimo avvistamento NeDi
  cacheUpdated: 1703405000,           // Quando inserito in cache
  liveVerified: null,                 // Ultimo refresh SSH (se fatto)

  // Storico compatto (ultimi 5 movimenti)
  history: [
    { switch: "MI_SW_01", port: "GE0/0/3", vlan: 100, seen: 1703404800 }
  ]
}
```

### Indici Secondari

| Indice | Tipo | Use Case |
|--------|------|----------|
| `bySwitch` | Map<string, Set> | "Tutti i MAC su switch X" |
| `byIp` | Map<string, string> | Ricerca per IP invece di MAC |
| `byVlan` | Map<number, Set> | "Tutti i MAC in VLAN 100" |

### Memory Footprint

- 25K entries × ~400 bytes = ~10MB
- Indici secondari: ~5MB
- **Totale: ~15MB RAM**

---

## 3. NeDi Sync Background

```
┌─────────────────────────────────────────────────────────────────┐
│                     NeDi Sync Job (ogni 15 min)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  nodes   │    │  nodarp  │    │  links   │    │ devices  │  │
│  │  table   │    │  table   │    │  table   │    │  table   │  │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘  │
│       │               │               │               │         │
│       └───────────────┴───────────────┴───────────────┘         │
│                           │                                      │
│                           ▼                                      │
│                   ┌───────────────┐                              │
│                   │  Aggregator   │  ← Merge + deduplica         │
│                   └───────┬───────┘                              │
│                           │                                      │
│                           ▼                                      │
│                   ┌───────────────┐                              │
│                   │   MacCache    │  ← Atomic swap               │
│                   └───────────────┘                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Implementazione

```javascript
// lib/NeDiSyncJob.js

class NeDiSyncJob {
  constructor(nediDb, macCache) {
    this.nedi = nediDb;
    this.cache = macCache;
    this.interval = 15 * 60 * 1000;  // 15 minuti
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.retryDelay = 60000;
  }

  async start() {
    // Sync immediato all'avvio
    await this.sync();
    // Poi ogni 15 minuti
    setInterval(() => this.sync(), this.interval);
  }

  async sync() {
    if (this.isRunning) return;  // Evita overlap
    this.isRunning = true;

    try {
      // Query parallele (come v2, già ottimizzato)
      const [nodes, arp, devices] = await Promise.all([
        this.nedi.getAllNodes(),      // ~24K rows, ~500ms
        this.nedi.getAllArp(),        // ~20K rows, ~400ms
        this.nedi.getAllDevices()     // ~1.3K rows, ~100ms
      ]);

      // Build nuova cache (non tocca quella attiva)
      const newCache = this.buildCache(nodes, arp, devices);

      // Atomic swap (zero downtime)
      this.cache.swap(newCache);

      this.consecutiveFailures = 0;
      this.retryDelay = 60000;

    } catch (error) {
      this.handleSyncError(error);
    }

    this.isRunning = false;
  }

  handleSyncError(error) {
    this.consecutiveFailures++;

    // Exponential backoff: 1min → 2min → 4min → max 15min
    this.retryDelay = Math.min(
      this.retryDelay * 2,
      15 * 60 * 1000
    );

    console.error(`[NeDi Sync] Fallito (${this.consecutiveFailures}x), retry in ${this.retryDelay/1000}s`);

    // Notifica admin se 3+ fallimenti consecutivi
    if (this.consecutiveFailures >= 3) {
      this.notifyAdmin('NeDi sync fallito 3+ volte');
    }

    setTimeout(() => this.sync(), this.retryDelay);
  }
}
```

### Query NeDi Ottimizzata

```javascript
// Nuovo metodo in libnedi.js

async getAllNodes() {
  return this.query(`
    SELECT n.mac, n.device, n.ifname, n.vlanid, n.lastseen, n.oui,
           d.devip, d.type, d.vendor, d.location
    FROM nodes n
    LEFT JOIN devices d ON n.device = d.device
    WHERE n.ifname NOT LIKE 'Vlanif%'
      AND n.ifname NOT LIKE 'Vlif%'
      AND n.ifname NOT LIKE 'Loop%'
      AND n.ifname NOT LIKE 'NULL%'
      AND n.lastseen > UNIX_TIMESTAMP() - 86400 * 7
    ORDER BY n.lastseen DESC
  `);
}
```

### Caratteristiche

| Feature | Descrizione |
|---------|-------------|
| **Atomic swap** | Nuova cache costruita in background, swap istantaneo |
| **No downtime** | Lookup funziona durante sync |
| **Query parallele** | 3 query NeDi in parallelo (~500ms totale) |
| **Deduplicazione** | Filtra porte virtuali, prende lastSeen più recente |
| **Retry con backoff** | Se NeDi non risponde, exponential backoff fino a 15min |

---

## 4. API Endpoints

### Endpoints

```
GET  /api/v3/mac/search?q=aa:bb:cc        ← Ricerca cache
POST /api/v3/mac/refresh                   ← SSH on-demand
GET  /api/v3/mac/stats                     ← Statistiche cache
GET  /api/v3/mac/health                    ← Health check
GET  /api/v3/mac/switch/:name              ← MAC per switch
```

### GET /api/v3/mac/search

Ricerca veloce da cache (solo lettura).

**Parametri query:**
- `q` - MAC address (parziale o completo)
- `ip` - Ricerca per IP
- `vlan` - Filtro VLAN
- `switch` - Filtro switch

**Response:**
```json
{
  "query": { "q": "aabbcc", "ip": null, "vlan": null },
  "count": 1,
  "results": [
    {
      "mac": "aa:bb:cc:dd:ee:ff",
      "endpoint": {
        "switch": "MI_SW_01",
        "switchIp": "192.168.1.10",
        "port": "GigabitEthernet0/0/3",
        "vlan": 100,
        "macCount": 1,
        "portType": "access"
      },
      "ip": "192.168.1.50",
      "hostname": "client-pc",
      "vendor": "Apple Inc.",
      "lastSeen": 1703404800,
      "liveVerified": null
    }
  ],
  "elapsed": "6ms",
  "cacheAge": "5 min ago",
  "source": "cache"
}
```

### POST /api/v3/mac/refresh

SSH refresh on-demand per verifica live.

**Request body:**
```json
{
  "mac": "aa:bb:cc:dd:ee:ff",
  "switchIp": "192.168.1.10"
}
```

**Response:**
```json
{
  "mac": "aa:bb:cc:dd:ee:ff",
  "result": {
    "switch": "MI_SW_01",
    "port": "GigabitEthernet0/0/3",
    "vlan": 100,
    "verified": true
  },
  "elapsed": "2.3s",
  "source": "ssh-live"
}
```

### GET /api/v3/mac/stats

Statistiche cache.

**Response:**
```json
{
  "totalMacs": 24532,
  "lastSync": "2025-12-21T10:15:00Z",
  "nextSync": "2025-12-21T10:30:00Z",
  "cacheAge": "5 min ago",
  "memoryUsage": "15MB",
  "stats": {
    "hits": 1523,
    "misses": 23,
    "refreshes": 8,
    "hitRate": "98.5%"
  }
}
```

### GET /api/v3/mac/health

Health check per monitoring.

**Response:**
```json
{
  "status": "ok",
  "cache": {
    "size": 24532,
    "lastSync": "2025-12-21T10:15:00Z",
    "ageSeconds": 300,
    "isStale": false
  },
  "nedi": {
    "connected": true,
    "lastError": null
  }
}
```

### Response Headers

| Header | Valore | Descrizione |
|--------|--------|-------------|
| `X-Cache-Status` | `HIT` / `MISS` | Se trovato in cache |
| `X-Cache-Age` | `300` | Secondi dall'ultimo sync |
| `X-Response-Time` | `8ms` | Tempo elaborazione |

---

## 5. UI/Frontend

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  MAC Tracker V3                                    Cache: 2m ago │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────┐  ┌──────────────────┐  │
│  │ 🔍 aa:bb:cc:dd:ee:ff               │  │  🔄 Verifica Live │  │
│  └─────────────────────────────────────┘  └──────────────────┘  │
│                                                                  │
│  Risultato in 6ms                                    1 trovato   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  📍 ENDPOINT TROVATO                              ✓ cache   ││
│  │                                                              ││
│  │  MAC:      aa:bb:cc:dd:ee:ff                                ││
│  │  Vendor:   Apple Inc.                                       ││
│  │  IP:       192.168.1.50 (client-pc)                           ││
│  │                                                              ││
│  │  Switch:   MI_SW_01 (192.168.1.10)                            ││
│  │  Porta:    GigabitEthernet0/0/3                            ││
│  │  VLAN:     100                                              ││
│  │  Tipo:     🖥️ Access (1 MAC)                               ││
│  │                                                              ││
│  │  Visto:    5 minuti fa                                      ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┤
│  │  📜 Storico (ultimi 30 giorni)                      ▼       ││
│  ├──────────────────────────────────────────────────────────────┤
│  │  MI_SW_01 / GE0/0/3   VLAN 100   oggi                       ││
│  │  MI_SW_02 / GE0/0/7   VLAN 100   3 giorni fa                ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Componenti UI

| Elemento | Comportamento |
|----------|---------------|
| **Search box** | Ricerca live mentre digiti (debounce 300ms) |
| **🔄 Verifica Live** | Bottone per SSH refresh, disabilitato durante loading |
| **Badge source** | `✓ cache` verde, `✓ ssh` blu, `⚠ stale` giallo |
| **Tempo risposta** | Mostra ms per feedback immediato |
| **Cache age** | "2m ago" in header, avviso se >15min |

### Stati UI

| Stato | Visualizzazione |
|-------|-----------------|
| **Idle** | Search box vuoto, nessun risultato |
| **Searching** | Spinner nel search box |
| **Found (cache)** | Card verde, badge "✓ cache", tempo <10ms |
| **Found (ssh)** | Card blu, badge "✓ ssh live", tempo 2-5s |
| **Not found** | Card grigia, suggerimento "Prova Verifica Live" |
| **Stale** | Card gialla, badge "⚠ dati di 30min fa" |
| **Error** | Card rossa, messaggio errore |

### Implementazione

```javascript
// public/js/mac-tracker-v3.js

class MacTrackerV3 {
  constructor() {
    this.searchInput = document.getElementById('mac-search');
    this.refreshBtn = document.getElementById('refresh-btn');
    this.resultPanel = document.getElementById('result-panel');
    this.debounceTimer = null;
    this.currentResult = null;
  }

  init() {
    // Ricerca live con debounce
    this.searchInput.addEventListener('input', (e) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.search(e.target.value);
      }, 300);
    });

    // Refresh SSH on-demand
    this.refreshBtn.addEventListener('click', () => {
      this.refreshLive();
    });
  }

  async search(query) {
    if (query.length < 6) return;

    const start = performance.now();
    const res = await fetch(`/api/v3/mac/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    this.currentResult = data.results[0] || null;
    this.renderResult(data, performance.now() - start);
  }

  async refreshLive() {
    if (!this.currentResult) return;

    this.refreshBtn.disabled = true;
    this.refreshBtn.textContent = '⏳ Verifica...';

    const res = await fetch('/api/v3/mac/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mac: this.currentResult.mac,
        switchIp: this.currentResult.endpoint.switchIp
      })
    });

    const data = await res.json();
    this.renderResult({ results: [{ ...this.currentResult, ...data.result }] }, null, 'ssh');

    this.refreshBtn.disabled = false;
    this.refreshBtn.textContent = '🔄 Verifica Live';
  }

  renderResult(data, elapsed, source = 'cache') {
    // ... render HTML
  }
}
```

---

## 6. Error Handling

### Error Codes

```javascript
const ERROR_CODES = {
  INVALID_MAC: { status: 400, message: 'Formato MAC non valido' },
  NOT_FOUND: { status: 404, message: 'MAC non trovato in cache' },
  SSH_TIMEOUT: { status: 504, message: 'SSH timeout' },
  SSH_AUTH_FAIL: { status: 401, message: 'Credenziali SSH non valide' },
  SWITCH_UNREACHABLE: { status: 502, message: 'Switch non raggiungibile' },
  CACHE_STALE: { status: 200, message: 'Dati potrebbero essere obsoleti' }
};
```

### Scenari e Gestione

| Scenario | Rilevamento | Azione | UI Feedback |
|----------|-------------|--------|-------------|
| **NeDi non raggiungibile** | Sync fallisce | Mantieni cache esistente, riprova tra 1min | ⚠️ "Cache di 20min fa - NeDi offline" |
| **Cache vuota all'avvio** | `cache.size() === 0` | Blocca avvio, retry sync | 🔴 "Inizializzazione cache..." |
| **SSH timeout** | Timeout 10s | Mostra ultimo dato cache | ⚠️ "SSH timeout - dati da cache" |
| **SSH auth fail** | Error code | Skip, non riprova stesse creds | ❌ "Credenziali non valide" |
| **MAC non trovato** | Cache miss | Suggerisci refresh live | ℹ️ "Non in cache - prova Verifica Live" |
| **MAC formato invalido** | Regex fail | Feedback immediato | ❌ "Formato MAC non valido" |
| **Switch non raggiungibile** | SSH connection fail | Mostra errore specifico | ❌ "Switch 192.168.1.10 non raggiungibile" |

### Validazione MAC

```javascript
const MAC_PATTERNS = [
  /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/,      // aa:bb:cc:dd:ee:ff
  /^([0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}$/,      // aa-bb-cc-dd-ee-ff
  /^([0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}$/,     // aabb.ccdd.eeff
  /^([0-9A-Fa-f]{4}-){2}[0-9A-Fa-f]{4}$/,      // aabb-ccdd-eeff (Huawei)
  /^[0-9A-Fa-f]{12}$/                           // aabbccddeeff
];

function validateAndNormalize(input) {
  const clean = input.trim();

  // Check formati validi
  const isValid = MAC_PATTERNS.some(p => p.test(clean));
  if (!isValid && clean.length < 6) {
    throw new MacTrackerError('INVALID_MAC', `Input troppo corto: ${clean}`);
  }

  // Normalizza a lowercase senza separatori
  const normalized = clean.replace(/[:\-\.]/g, '').toLowerCase();

  // Formato display standard
  const display = normalized.match(/.{2}/g)?.join(':') || normalized;

  return { normalized, display, partial: normalized.length < 12 };
}
```

---

## 7. File da Creare/Modificare

### Nuovi File

| File | Descrizione |
|------|-------------|
| `lib/MacCache.js` | Classe cache in-memory |
| `lib/NeDiSyncJob.js` | Job sync background |
| `lib/macValidator.js` | Validazione/normalizzazione MAC |
| `public/js/mac-tracker-v3.js` | Frontend JavaScript |
| `public/css/mac-tracker-v3.css` | Stili UI |

### File da Modificare

| File | Modifiche |
|------|-----------|
| `server.js` | Aggiungere endpoints `/api/v3/mac/*` |
| `libnedi.js` | Aggiungere `getAllNodes()`, `getAllArp()` |
| `public/index.html` | Aggiungere tab/panel MAC Tracker V3 |

---

## 8. Piano di Implementazione

### Fase 1: Core Cache (2-3 ore)
1. Creare `lib/MacCache.js` con Map e indici
2. Unit test per operazioni CRUD
3. Test performance con 25K entries simulate

### Fase 2: NeDi Sync (2-3 ore)
1. Creare `lib/NeDiSyncJob.js`
2. Aggiungere query ottimizzate in `libnedi.js`
3. Integrare in startup `server.js`
4. Test sync con NeDi reale

### Fase 3: API Endpoints (2 ore)
1. Implementare `/api/v3/mac/search`
2. Implementare `/api/v3/mac/refresh`
3. Implementare `/api/v3/mac/stats` e `/health`
4. Test API con curl/Postman

### Fase 4: Frontend (2-3 ore)
1. Creare UI panel in `public/`
2. Implementare ricerca live + refresh button
3. Stili e stati UI
4. Test manuale end-to-end

### Fase 5: Migrazione (1 ora)
1. Deploy su produzione
2. Monitoraggio performance
3. Documentazione utente

**Tempo totale stimato: 10-12 ore**

---

## 9. Metriche di Successo

| Metrica | Target | Come Misurare |
|---------|--------|---------------|
| Tempo ricerca | <10ms | Header `X-Response-Time` |
| Hit rate cache | >95% | `/api/v3/mac/stats` |
| Refresh SSH | <5s | Log timing |
| Uptime sync | >99% | Health check monitoring |
| Memory usage | <20MB | Process memory stats |

---

## 10. Rischi e Mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| NeDi offline prolungato | Bassa | Alto | Cache sopravvive, alert admin |
| Memory leak cache | Bassa | Medio | Atomic swap, no append |
| SSH refresh fallisce | Media | Basso | Mostra dati cache, suggerisce retry |
| MAC non in NeDi | Media | Basso | Suggerisce "Verifica Live" |

---

## Appendice: Confronto con IP Fabric

Durante la ricerca è stato analizzato l'approccio di IP Fabric:

| Aspetto | IP Fabric | NetMap V3 |
|---------|-----------|-----------|
| **Architettura** | Snapshot completo in RAM | Cache incrementale da NeDi |
| **RAM richiesta** | 24GB+ | ~15MB |
| **Lookup time** | <10ms | <10ms |
| **Data freshness** | Snapshot ogni 30-60min | Sync ogni 15min + refresh on-demand |
| **Complessità** | Alta (microservices) | Bassa (singolo processo) |

**Conclusione**: L'approccio NetMap V3 offre performance comparabili a IP Fabric con requisiti hardware molto inferiori, mantenendo la possibilità di refresh on-demand per casi critici.

---

*Documento generato durante sessione brainstorming 2025-12-21*
