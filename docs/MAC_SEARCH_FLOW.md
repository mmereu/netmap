# MAC Address Search Flow - NetMap

## Overview

NetMap offre due metodi per la ricerca MAC address:

| Metodo | Endpoint | Uso | Velocità |
|--------|----------|-----|----------|
| **DB Search** | `GET /api/search/mac/:mac` | Ricerca storica in FDB/ARP/Interfaces | Immediato |
| **MAC Trace** | `GET /api/mac/trace/:mac` | Tracciamento live hop-by-hop via SSH | 5-30 sec |

---

## Metodo 1: Ricerca nel Database Locale (SQLite)

**Endpoint:** `GET /api/search/mac/:mac`

```
                    ┌───────────────────────────────┐
                    │   Normalizza formato MAC      │
                    │   aa:bb:cc → aabbcc → aa:bb:cc│
                    │   Supporta: : - . plain       │
                    └───────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │  FDB      │   │   ARP     │   │ Interfaces│
            │  Table    │   │   Table   │   │   Table   │
            │           │   │           │   │           │
            │ mac       │   │ mac       │   │ ifphys    │
            │ device    │   │ ip        │   │ address   │
            │ port      │   │ device    │   │ device    │
            │ vlan      │   │ lastseen  │   │ ifname    │
            └───────────┘   └───────────┘   └───────────┘
                    │               │               │
                    └───────────────┴───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │   RISULTATO JSON:             │
                    │   { fdb: [], arp: [], if: [] }│
                    └───────────────────────────────┘
```

---

## Metodo 2: MAC Trace Live (SSH agli switch)

**Endpoint:** `GET /api/mac/trace/:mac`

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Connessione CORE Switch (es: 192.168.1.251)                        │
│          └── Credenziali da Pdv.CSV                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Cerca MAC sulla FDB                                                │
│          display mac-address | include 00e6-0e5d-7d80                       │
│          └── Output: porta (GE2/0/21 o Eth-TrunkN), VLAN                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌─────────────────┐             ┌─────────────────┐
          │  Porta Fisica   │             │   Eth-Trunk     │
          │  (GE/XGE/10GE)  │             │   (aggregato)   │
          └────────┬────────┘             └────────┬────────┘
                   │                               │
                   │                               ▼
                   │               ┌─────────────────────────┐
                   │               │ display eth-trunk <ID>  │
                   │               │ Trova porte membro      │
                   │               │ (GE0/0/1, GE0/0/2...)   │
                   │               └───────────┬─────────────┘
                   │                           │
                   └───────────┬───────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Conta MAC sulla porta                                              │
│          display mac-address interface <porta>                              │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
     ┌─────────────────┐             ┌─────────────────┐
     │   1 MAC         │             │   2+ MAC        │
     │   ─────────     │             │   ─────────     │
     │   ENDPOINT!     │             │   Switch/Hub/AP │
     │   Fine ricerca  │             │   collegato     │
     └─────────────────┘             └────────┬────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: LLDP Neighbor Discovery                                            │
│          display lldp neighbor interface <porta>                            │
│          └── Trova: switch downstream, IP management                        │
└─────────────────────────────────────────────────────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
     ┌─────────────────┐             ┌─────────────────┐
     │  LLDP trovato   │             │  No LLDP        │
     │  ─────────────  │             │  ─────────────  │
     │  Hop ricorsivo  │             │  Device non     │
     │  → torna STEP 1 │             │  gestito (AP,   │
     │  su nuovo switch│             │  hub, PC...)    │
     └─────────────────┘             └─────────────────┘
```

---

## Criteri di Terminazione

| Condizione | Risultato |
|------------|-----------|
| MAC su porta con 1 solo MAC | ENDPOINT DIRETTO |
| Nessun LLDP su porta non-trunk | Device non gestito/endpoint |
| Loop detection (switch già visitato) | STOP |
| Max 10 hop raggiunti | STOP |
| MAC non trovato | Non presente su questo switch |

---

## Formati MAC Supportati

| Input utente | Normalizzato | Huawei CLI |
|--------------|--------------|------------|
| `00:E6:0E:5D:7D:80` | `00:e6:0e:5d:7d:80` | `00e6-0e5d-7d80` |
| `00-E6-0E-5D-7D-80` | `00:e6:0e:5d:7d:80` | `00e6-0e5d-7d80` |
| `00e6.0e5d.7d80` | `00:e6:0e:5d:7d:80` | `00e6-0e5d-7d80` |
| `00e60e5d7d80` | `00:e6:0e:5d:7d:80` | `00e6-0e5d-7d80` |

---

## Esempio Path Trace

```
MAC: 00e6-0e5d-7d80

┌──────────────────┐    LLDP     ┌──────────────────┐
│  29_L3_CORE      │ ─────────▶  │  29_L2_SW01      │
│  192.168.1.251   │             │  192.168.1.1     │
│  ────────────    │             │  ────────────    │
│  Eth-Trunk10     │             │  GE0/0/21        │
│  VLAN 1000       │             │  VLAN 1000       │
│  150 MAC         │             │  1 MAC           │
└──────────────────┘             └──────────────────┘
                                         │
                                         ▼
                                 ┌──────────────────┐
                                 │   ENDPOINT       │
                                 │   PC/Telefono/   │
                                 │   Device finale  │
                                 └──────────────────┘
```

---

## Comandi Huawei Utilizzati

```bash
# Cerca MAC nella FDB
display mac-address | include 00e6-0e5d-7d80

# Vedi tutti i MAC su una porta
display mac-address interface GE2/0/21

# Vedi membri Eth-Trunk
display eth-trunk 10

# Vedi LLDP neighbor
display lldp neighbor interface GE2/0/21

# Correlazione IP-MAC (ARP)
display arp | include 00e6-0e5d-7d80

# Configurazione interfaccia
display current-configuration interface GE2/0/21
```

---

## Output JSON (MAC Trace)

```json
{
  "mac": "00e6-0e5d-7d80",
  "path": [
    {
      "switch": "29_L3_CORE",
      "ip": "192.168.1.251",
      "port": "Eth-Trunk10",
      "vlan": 1000,
      "macCount": 150,
      "lldpNeighbor": "29_L2_SW01"
    },
    {
      "switch": "29_L2_SW01",
      "ip": "192.168.1.1",
      "port": "GE0/0/21",
      "vlan": 1000,
      "macCount": 1,
      "isEndpoint": true
    }
  ],
  "endpoint": {
    "switch": "29_L2_SW01",
    "port": "GE0/0/21",
    "vlan": 1000
  }
}
```

---

## Note Implementative

- **Timeout SSH**: 30s per comando
- **Retry**: max 2 tentativi per switch
- **Max Hops**: 10 (prevenzione loop)
- **Credenziali**: caricate da `Pdv.CSV` per sito
