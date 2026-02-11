# Come NeDi Gestisce i MAC Address

> Documento tecnico completo sulla raccolta, storage e query dei MAC address in NeDi e NetMap.

**Data:** 2025-12-30
**Versione:** 1.0

---

## Indice

1. [Overview Architettura](#overview-architettura)
2. [Schema Database NeDi](#schema-database-nedi)
3. [SNMP Discovery NeDi](#snmp-discovery-nedi)
4. [SSH MAC Collector (NetMap)](#ssh-mac-collector-netmap)
5. [Sincronizzazione NeDi → NetMap](#sincronizzazione-nedi--netmap)
6. [Ricerca MAC](#ricerca-mac)
7. [Problemi Noti e Soluzioni](#problemi-noti-e-soluzioni)
8. [Comandi Utili](#comandi-utili)

---

## Overview Architettura

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FLUSSO MAC ADDRESS                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌────────────────┐         ┌────────────────┐                         │
│   │   Switch       │ SNMP    │   NeDi         │ (Discovery automatico)  │
│   │   Huawei       │ ──────▶ │   your-nedi-host  │                         │
│   │   1092 device  │         │   MySQL `nedi` │                         │
│   └────────────────┘         └───────┬────────┘                         │
│          │                           │                                   │
│          │ SSH                       │                                   │
│          │ (fallback)                │ Sync ogni 5 min                  │
│          ▼                           ▼                                   │
│   ┌────────────────┐         ┌────────────────┐                         │
│   │  SSH MAC       │ INSERT  │   NetMap       │                         │
│   │  Collector     │ ──────▶ │   SQLite       │                         │
│   │  ogni 15 min   │         │   netmap.db    │                         │
│   └────────────────┘         └───────┬────────┘                         │
│                                      │                                   │
│                                      ▼                                   │
│                              ┌────────────────┐                         │
│                              │  API REST      │                         │
│                              │  /api/search/* │                         │
│                              └────────────────┘                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Componenti Principali

| Componente | Ruolo | Location |
|------------|-------|----------|
| **NeDi** | Discovery SNMP, storage principale | `your-nedi-host` |
| **SSH MAC Collector** | Raccolta MAC via SSH (fallback) | `lib/sshMacCollector.js` |
| **NetMap SQLite** | Cache locale + query veloci | `netmap.db` |
| **libnedi.js** | Adapter NeDi MySQL | `lib/libnedi.js` |

---

## Schema Database NeDi

### Tabella `nodes` (MAC Address)

Questa è la tabella principale dove NeDi memorizza i MAC address appresi.

```sql
CREATE TABLE nodes (
  mac       VARCHAR(12) NOT NULL,   -- Formato: 00e60e5be740 (senza separatori)
  oui       VARCHAR(32),            -- Vendor OUI (es: "Hewlett-Packard")
  firstseen INT UNSIGNED,           -- Unix timestamp prima volta visto
  lastseen  INT UNSIGNED,           -- Unix timestamp ultima volta visto
  device    VARCHAR(64),            -- Nome switch (es: "01_L2_CASSA_15")
  ifname    VARCHAR(32),            -- Nome porta (es: "GE0/0/5")
  vlanid    SMALLINT,               -- VLAN ID (es: 1001)
  noduser   VARCHAR(32),            -- Username 802.1x (se presente)
  nodesc    VARCHAR(255),           -- Descrizione nodo

  PRIMARY KEY (mac, device, ifname)
);
```

**Formato MAC NeDi:** 12 caratteri esadecimali lowercase, senza separatori.
- Input Huawei: `00e6-0e5b-e740`
- Storage NeDi: `00e60e5be740`

### Tabella `nodarp` (ARP/IP Mapping)

Mapping IP ↔ MAC dalla cache ARP dei router.

```sql
CREATE TABLE nodarp (
  mac       VARCHAR(12),    -- MAC address
  ip        VARCHAR(15),    -- IP address
  device    VARCHAR(64),    -- Router/L3 switch
  ifname    VARCHAR(32),    -- VLAN interface
  lastseen  INT UNSIGNED,   -- Timestamp

  PRIMARY KEY (mac, ip)
);
```

### Statistiche Tipiche

| Tabella | Record | Note |
|---------|--------|------|
| `nodes` | ~2.2M | Post-cleanup 2025-12-30 |
| `nodarp` | ~15K | IP-MAC da router |
| `devices` | ~1,300 | Switch + router |
| `interfaces` | ~58K | Porte fisiche + virtuali |

---

## SNMP Discovery NeDi

### Processo Discovery

NeDi esegue discovery periodica (default ogni 30 min) usando questi OID SNMP:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Sistema Info                                                 │
│     OID: 1.3.6.1.2.1.1 (sysDescr, sysObjectID, sysName...)     │
├─────────────────────────────────────────────────────────────────┤
│  2. Interface Table                                              │
│     OID: 1.3.6.1.2.1.2.2.1 (ifIndex, ifName, ifOperStatus)     │
├─────────────────────────────────────────────────────────────────┤
│  3. Bridge FDB Table (MAC)                                       │
│     OID Standard: 1.3.6.1.2.1.17.4.3.1.1 (dot1dTpFdbAddress)   │
│     OID Huawei:   1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4           │
│                   (HUAWEI-L2MAM-MIB::hwDynFdbPort)              │
├─────────────────────────────────────────────────────────────────┤
│  4. LLDP Neighbors                                               │
│     OID: 1.0.8802.1.1.2.1.4.1.1 (lldpRemTable)                 │
└─────────────────────────────────────────────────────────────────┘
```

### File `.def` Huawei

NeDi usa file `.def` per definire gli OID per ogni vendor. Per Huawei:

**Location:** `/var/nedi/sysobj/1.3.6.1.4.1.2011.*.def`

**Contenuto tipico:**
```
# HUAWEI-MIB S5700 definition
Type    S5700-28C-EI-AC
Dispro  LLDP
CPU     1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5.65536
Mem     1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7.65536
Bridge  huaweiV
```

**Bridge mode:** `huaweiV` indica uso OID Huawei-specific per FDB.

### Codice Discovery (libsnmp.pm)

```perl
# /var/nedi/inc/libsnmp.pm - Linea ~2100

# OID per Bridge FDB Huawei
my $hwDynFdbPort = '1.3.6.1.4.1.2011.5.25.42.2.1.3.1.4';

# Walk FDB table
my @fdb = snmpwalk($device, $community, $hwDynFdbPort);
foreach my $entry (@fdb) {
    my ($mac, $port) = parse_fdb_entry($entry);
    # Validazione e insert in nodes table
    db_insert_node($mac, $device, $port, $vlan, time());
}
```

### Limitazioni SNMP

| Problema | Causa | Impatto |
|----------|-------|---------|
| ~70% MAC persi | Bridge-MIB non vede tutte le VLAN | 27% coverage vs SSH |
| VLAN mismatch | SNMP ritorna solo VLAN default | VLAN errato in DB |
| Dati stale | Discovery ogni 30 min | MAC vecchi di ore |
| Virtual interfaces | Include Vlanif, MEth | Falsi positivi |

---

## SSH MAC Collector (NetMap)

### Perché SSH?

Test empirico 2025-12-27:
- **SNMP Bridge-MIB:** 6/22 MAC trovati (27%)
- **SSH `display mac-address`:** 22/22 MAC (100%)

### Implementazione

**File:** `lib/sshMacCollector.js`

```javascript
class SshMacCollector {
  constructor(nediDb) {
    this.nedi = nediDb;
    this.interval = 15 * 60 * 1000;  // 15 minuti
    this.concurrency = 5;            // switch paralleli
  }

  async collectFromSwitch(ip, credentials) {
    // 1. SSH connect con algoritmi legacy Huawei
    // 2. Esegue: display mac-address
    // 3. Parse output
    // 4. Upsert in NeDi MySQL
  }
}
```

### Comandi SSH Huawei

```bash
# Tutti i MAC
display mac-address

# MAC su porta specifica
display mac-address interface GE0/0/5

# MAC in VLAN specifica
display mac-address vlan 1001

# Cerca MAC specifico
display mac-address | include 00e6-0e5b-e740
```

### Output Esempio

```
-------------------------------------------------------------------------------
MAC Address    VLAN/VSI/BD   Learned-From        Type
-------------------------------------------------------------------------------
00e6-0e5b-e740 1001/-        GE0/0/5             dynamic
00e6-0e5b-e780 1/-           GE0/0/23            dynamic
4883-c750-0001 1/-           GE0/0/1             static
a4bb-6d7e-1234 233/-         GE0/0/12            dynamic
-------------------------------------------------------------------------------
Total items: 4
```

### Parser MAC Table

```javascript
// lib/huaweiLldpParser.js

function parseHuaweiMacTable(output) {
  const RE_MAC_LINE = /^([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})\s+(\d+)(?:\/[^\s]*)?\s+(\S+)\s+(dynamic|static)/gmi;

  const macs = [];
  let match;
  while ((match = RE_MAC_LINE.exec(output)) !== null) {
    macs.push({
      mac: match[1].replace(/-/g, '').toLowerCase(),  // 00e60e5be740
      vlan: parseInt(match[2]),
      port: match[3],
      type: match[4]
    });
  }
  return macs;
}
```

### Gestione Errori

```javascript
const retryableErrors = [
  'Connection closed',      // Switch sovraccarico
  'Connection reset',       // Timeout
  'Connection refused',     // SSH disabilitato
  'SSH timeout',           // Rete lenta
  'No prompt after login'  // Banner diverso
];

// Retry con backoff: 2s, 4s, 6s
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    return await collectFromSwitch(ip);
  } catch (err) {
    if (retryableErrors.some(e => err.message.includes(e))) {
      await sleep(2000 * attempt);
      continue;
    }
    throw err;
  }
}
```

### Telnet Fallback

Switch con STELNET (non SSH standard) falliscono. Fallback automatico:

```javascript
// Se SSH fallisce con errori specifici → prova Telnet
if (shouldFallbackToTelnet(error)) {
  return await executeViaTelnet(ip, credentials);
}
```

**Success rate Telnet fallback:** ~30% switch recuperati.

---

## Sincronizzazione NeDi → NetMap

### Endpoint API

```http
POST /api/admin/sync-mac-nedi
Content-Type: application/json

{
  "limit": 1000,      // Max record da sync
  "daysBack": 7       // Filtra MAC visti negli ultimi N giorni
}
```

### Processo Sync

```
┌──────────────────────────────────────────────────────────────┐
│  1. Query NeDi MySQL                                          │
│     SELECT mac, device, ifname, vlanid, lastseen              │
│     FROM nodes                                                │
│     WHERE lastseen >= NOW() - 7 days                         │
├──────────────────────────────────────────────────────────────┤
│  2. Per ogni MAC:                                             │
│     a) Normalizza formato (00e60e5be740 → 00:e6:0e:5b:e7:40) │
│     b) Trova device_id locale                                 │
│     c) Trova interface_id locale                              │
├──────────────────────────────────────────────────────────────┤
│  3. UPSERT in SQLite                                          │
│     INSERT INTO fdb (...) ON CONFLICT DO UPDATE              │
└──────────────────────────────────────────────────────────────┘
```

### Schema SQLite (NetMap)

```sql
CREATE TABLE fdb (
  id INTEGER PRIMARY KEY,
  device_id INTEGER,
  interface_id INTEGER,
  mac TEXT,              -- Formato: 00:e6:0e:5b:e7:40
  vlan INTEGER,
  firstseen INTEGER,
  lastseen INTEGER,

  FOREIGN KEY (device_id) REFERENCES devices(id),
  UNIQUE (device_id, mac, vlan)
);

CREATE INDEX idx_fdb_mac ON fdb(mac);
```

---

## Ricerca MAC

### Metodi Disponibili

| Metodo | Endpoint | Velocità | Fonte |
|--------|----------|----------|-------|
| **DB Search** | `GET /api/search/mac/:mac` | ~50ms | SQLite locale |
| **Hybrid** | `POST /api/search/mac/hybrid` | 50ms-60s | NeDi + SSH fallback |
| **MAC Trace** | `GET /api/mac/trace/:mac` | 5-30s | SSH live hop-by-hop |
| **Instant** | `POST /api/search/mac/instant` | ~200ms | NeDi diretto |

### Flow Ricerca Ibrida

```
┌─────────────────────────────────────────────────────────────┐
│                    Ricerca Ibrida                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   Input: MAC address                                         │
│         ▼                                                    │
│   ┌─────────────────┐                                       │
│   │ 1. Query NeDi   │ (~10ms)                               │
│   │    MySQL        │                                       │
│   └────────┬────────┘                                       │
│            │                                                 │
│   ┌────────▼────────┐                                       │
│   │ MAC trovato?    │                                       │
│   └────────┬────────┘                                       │
│     SI │        │ NO                                        │
│        ▼        ▼                                            │
│   ┌─────────┐  ┌─────────────────┐                          │
│   │ Return  │  │ 2. SSH Fallback │ (30-60s)                 │
│   │ Result  │  │    Trace live   │                          │
│   └─────────┘  └─────────────────┘                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Normalizzazione Formato MAC

```javascript
function normalizeMac(mac) {
  // Rimuovi tutti i separatori
  const clean = mac.replace(/[:.\-]/g, '').toLowerCase();

  // Valida lunghezza
  if (clean.length !== 12) return null;

  // Ritorna formato standard xx:xx:xx:xx:xx:xx
  return clean.match(/.{2}/g).join(':');
}

// Formati supportati:
// Input: "00:E6:0E:5D:7D:80" → Output: "00:e6:0e:5d:7d:80"
// Input: "00-E6-0E-5D-7D-80" → Output: "00:e6:0e:5d:7d:80"
// Input: "00e6.0e5d.7d80"    → Output: "00:e6:0e:5d:7d:80"
// Input: "00e60e5d7d80"      → Output: "00:e6:0e:5d:7d:80"
// Input: "00e6-0e5d-7d80"    → Output: "00:e6:0e:5d:7d:80" (Huawei)
```

### Filtro Interfacce Virtuali

La ricerca esclude automaticamente interfacce virtuali:

```javascript
const VIRTUAL_INTERFACES = [
  'Vlanif%',
  'Vlif%',
  'Vlan%',
  'NULL%',
  'Loop%',
  'MEth%',
  'Stack-Port%',
  'Bridge-Aggregation%'
];

// Query SQL con filtro
WHERE ifname NOT LIKE 'Vlanif%'
  AND ifname NOT LIKE 'Vlif%'
  AND ifname NOT LIKE 'MEth%'
  ...
```

---

## Problemi Noti e Soluzioni

### 1. Timestamp Corrotti in NeDi

**Problema:** Record con `lastseen = 4294967295` (overflow UINT32).

**Causa:** Perl `$main::now` non inizializzato → -1 → unsigned overflow.

**Fix applicato:** Validazione timestamp in `/var/nedi/inc/libdb.pm`:

```perl
# Linee 2103, 2108, 2114
my $ts = ($main::now > 0 && $main::now < 4000000000) ? $main::now : time;
```

**Cleanup query:**
```sql
DELETE FROM nodes WHERE lastseen > 4000000000;
```

### 2. Accumulo Record Storici

**Problema:** Tabella `nodes` cresce indefinitamente (era 7M record).

**Soluzione:** Cron cleanup ogni 2 ore:

```bash
# /var/nedi/cleanup-corrupted-nodes.sh
mysql -unedi -p$NEDI_MYSQL_PASS nedi -e "DELETE FROM nodes WHERE lastseen < UNIX_TIMESTAMP() - 7776000" # 90 giorni
mysql -unedi -p$NEDI_MYSQL_PASS nedi -e "OPTIMIZE TABLE nodes"
```

### 3. Switch Non Raggiungibili via SSH

**Problema:** ~20% switch richiedono STELNET (non OpenSSH standard).

**Soluzione:** Telnet fallback in `sshMacCollector.js`.

### 4. PVID Sempre 0

**Problema:** NeDi mostra PVID=0 per switch Huawei.

**Causa:** OID errato nei file `.def` (IEEE invece di Huawei).

**Fix:** Aggiornato OID in 68 file `.def`:
```
# Errato:  1.3.6.1.2.1.17.7.1.4.5.1.1 (IEEE 802.1Q)
# Corretto: 1.3.6.1.4.1.2011.5.25.42.1.1.1.3.1.4 (HUAWEI-L2IF-MIB::hwL2IfPVID)
```

---

## Comandi Utili

### Query NeDi MySQL

```bash
# Connessione
ssh $NEDI_SSH_USER@$NEDI_HOST "mysql -unedi -p$NEDI_MYSQL_PASS nedi"

# Statistiche
SELECT
  (SELECT COUNT(*) FROM nodes) as mac_count,
  (SELECT COUNT(*) FROM devices) as device_count,
  (SELECT COUNT(DISTINCT device) FROM nodes) as devices_with_mac;

# MAC recenti (ultimi 7 giorni)
SELECT mac, device, ifname, vlanid,
       FROM_UNIXTIME(lastseen) as last_seen
FROM nodes
WHERE lastseen > UNIX_TIMESTAMP() - 604800
ORDER BY lastseen DESC
LIMIT 100;

# Cerca MAC specifico
SELECT * FROM nodes WHERE mac = '00e60e5be740';

# MAC per switch
SELECT mac, ifname, vlanid FROM nodes WHERE device = '01_L2_CASSA_15';

# IP da MAC (via ARP)
SELECT n.mac, na.ip, n.device, n.ifname
FROM nodes n
LEFT JOIN nodarp na ON n.mac = na.mac
WHERE n.mac = '00e60e5be740';
```

### Comandi SSH Switch

```bash
# Display tutti i MAC
display mac-address

# Display MAC su porta
display mac-address interface GE0/0/5

# Display MAC in VLAN
display mac-address vlan 1001

# Cerca MAC
display mac-address | include 00e6-0e5b

# ARP table
display arp

# LLDP neighbors
display lldp neighbor brief
```

### API NetMap

```bash
# Ricerca MAC
curl "http://localhost:4000/api/search/mac/00:e6:0e:5b:e7:40"

# Ricerca ibrida
curl -X POST "http://localhost:4000/api/search/mac/hybrid" \
  -H "Content-Type: application/json" \
  -d '{"mac": "00:e6:0e:5b:e7:40"}'

# Stato MAC Collector
curl "http://localhost:4000/api/admin/mac-collector/status"

# Trigger sync manuale
curl -X POST "http://localhost:4000/api/admin/sync-mac-nedi"
```

---

## Appendice: Configurazione

### NeDi Server
- **IP:** your-nedi-host
- **Database:** MySQL `nedi`
- **User:** nedi / $NEDI_MYSQL_PASS (see .env)
- **Config:** `/var/nedi/nedi.conf`
- **Logs:** `/var/log/nedi/`

### NetMap Server
- **Produzione:** your-netmap-host
- **Database:** SQLite `netmap.db`
- **Service:** `systemctl status netmap`
- **WorkDir:** `/var/netmap`

### Credenziali Switch
- **Source:** `/var/www/html/Pdv.CSV`
- **Format:** `Sito;Network;Admin;Password;User;Password2`
- **Special:** Switch .251 (CORE) usano credenziali separate

---

*Documento generato per NetMap - Network Topology Management*
