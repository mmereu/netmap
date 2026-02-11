# LLDP SNMP Discovery - Quick Start

> Discovery automatica LLDP SNMP con import Access Point in NetMap

## Overview

Endpoint API REST per scansione automatica subnet con:
- Test connettività SNMP
- Verifica accesso MIB LLDP
- Conteggio neighbors LLDP
- Filtro e import automatico Access Point

## Quick Start

### 1. Avvia il server

```bash
node server.js
```

Server disponibile su `http://localhost:4000`

### 2. Esegui discovery

```bash
curl -X POST http://localhost:4000/api/discovery/lldp-snmp \
  -H "Content-Type: application/json" \
  -d '{"network": "192.168.1.0/24"}'
```

### 3. Analizza risultati

```json
{
  "success": true,
  "network": "192.168.1.0/24",
  "scanned": 254,
  "responsive": 15,
  "lldpEnabled": 8,
  "apImported": 42,
  "devices": [...],
  "duration": "45.3s"
}
```

## Uso con script di test

```bash
# Test base
node test-lldp-snmp-api.mjs 192.168.1.0/24

# Esempi d'uso
node examples/lldp-snmp-discovery-example.mjs

# Esempio specifico
node examples/lldp-snmp-discovery-example.mjs 1  # Singola subnet
node examples/lldp-snmp-discovery-example.mjs 4  # Filtro risultati
```

## Cosa fa l'endpoint

1. **Espande CIDR**: `192.168.1.0/24` → 254 IP (esclusi network/broadcast)
2. **Scansione parallela**: 10 worker contemporanei
3. **Per ogni IP**:
   - Test SNMP `sysName` (timeout 3s)
   - Se OK → Test LLDP MIB `1.0.8802.1.1.2.1.1.1.0`
   - Se LLDP OK → Walk `lldpRemSysName` (timeout 5s)
   - Filtra neighbors con pattern `/ap|pdv|wifi|wireless|wlan/i`
   - Import AP nel database come `status=neighbor`

## Risultati

### Device status

| Status | Descrizione |
|--------|-------------|
| `ok` | SNMP + LLDP funzionanti |
| `no-snmp` | Device non risponde a SNMP |
| `no-lldp` | SNMP OK, ma LLDP non accessibile |
| `error` | Errore generico |

### Database update

**Tabella `devices`:**
- Switch: `status=active`
- Access Point: `status=neighbor`

**Tabella `links`:**
- `protocol=LLDP`
- `device_id` → switch
- `remote_device_id` → AP

## Performance

| Subnet | Host | Tempo medio |
|--------|------|-------------|
| /24 | 254 | 45-60s |
| /25 | 126 | 25-35s |
| /26 | 62 | 15-20s |

**Concurrency**: 10 worker paralleli
**Timeout SNMP**: 3s (sysName), 5s (LLDP walk)

## Limitazioni

- Max 1024 host per richiesta (protezione `/16`)
- Community SNMP: configurabile via env `SNMP_COMMUNITY` (default: `public`)
- Solo SNMPv2c supportato
- Pattern AP non configurabile

## Troubleshooting

### "LLDP MIB non accessibile"

**Causa**: Switch senza configurazione SNMP LLDP

**Soluzione**: Vedi `docs/HUAWEI_DEF_FILE_SOLUTION.md`

```bash
# Su switch Huawei
system-view
snmp-agent mib-view included lldp-view iso
snmp-agent community read cipher YOUR_COMMUNITY mib-view lldp-view
commit
```

### "Subnet troppo grande"

**Causa**: CIDR > /22 (max 1024 host)

**Soluzione**: Spezzare in subnet più piccole

```bash
# Invece di /16
curl -d '{"network": "10.21.0.0/16"}'  # ✗ Errore

# Dividere in /24
curl -d '{"network": "10.21.0.0/24"}'  # ✓ OK
curl -d '{"network": "10.21.1.0/24"}'  # ✓ OK
```

## File Correlati

| File | Descrizione |
|------|-------------|
| `server.js` | Implementazione endpoint (righe 1536-1771) |
| `test-lldp-snmp-api.mjs` | Script test completo |
| `examples/lldp-snmp-discovery-example.mjs` | 5 esempi d'uso |
| `docs/API_LLDP_SNMP_DISCOVERY.md` | Documentazione completa API |
| `check-huawei-lldp-snmp.mjs` | Script verifica LLDP singolo device |
| `import-lldp-neighbors.mjs` | Import manuale neighbors |

## Integrazione Frontend

```javascript
// React/Vue/Angular
async function scanNetwork(network) {
  const response = await fetch('/api/discovery/lldp-snmp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network })
  });

  const result = await response.json();

  // Mostra risultati
  console.log(`AP importati: ${result.apImported}`);

  // Device con AP
  const withAP = result.devices.filter(d => d.aps > 0);
  return withAP;
}
```

## Next Steps

1. **Test su subnet reale**:
   ```bash
   node test-lldp-snmp-api.mjs 192.168.1.0/24
   ```

2. **Verifica AP importati**:
   - Apri frontend NetMap
   - Visualizza mappa sito
   - Abilita checkbox "Access Point"

3. **Fix device senza LLDP**:
   - Controlla risultati con `status=no-lldp`
   - Applica configurazione SNMP LLDP
   - Riesegui discovery

## Support

- **API Doc**: `docs/API_LLDP_SNMP_DISCOVERY.md`
- **Fix LLDP**: `docs/HUAWEI_DEF_FILE_SOLUTION.md`
- **Test**: `test-lldp-snmp-api.mjs`
- **Esempi**: `examples/lldp-snmp-discovery-example.mjs`
