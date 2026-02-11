# API LLDP SNMP Discovery

## Endpoint

```
POST /api/discovery/lldp-snmp
```

## Descrizione

Discovery SNMP automatica con test LLDP e import automatico Access Point nel database NetMap.

**Funzionalità:**
1. Scansione parallela subnet CIDR (concurrency: 10)
2. Test connettività SNMP (sysName)
3. Test accesso MIB LLDP (1.0.8802.1.1.2.1.1.1.0)
4. Conteggio neighbors LLDP via SNMP walk
5. Filtro automatico Access Point (pattern: `ap|pdv|wifi|wireless|wlan`)
6. Import automatico AP e link LLDP nel database

## Request Body

```json
{
  "network": "192.168.1.0/24"
}
```

**Parametri:**
- `network` (required): Subnet in formato CIDR (es. `192.168.1.0/24`)
  - Max 1024 host per richiesta
  - Esclude network address e broadcast

## Response Format

```json
{
  "success": true,
  "network": "192.168.1.0/24",
  "scanned": 254,
  "responsive": 15,
  "lldpEnabled": 8,
  "apImported": 42,
  "devices": [
    {
      "ip": "192.168.1.1",
      "sysname": "21_L2_S5735_V2_CED_1",
      "lldp": true,
      "neighbors": 78,
      "aps": 7,
      "apList": ["AP-PDV-001", "AP-PDV-002", ...],
      "status": "ok"
    },
    {
      "ip": "192.168.1.2",
      "sysname": "21_L2_S5735_V2_CED_2",
      "lldp": true,
      "neighbors": 45,
      "aps": 0,
      "status": "ok"
    },
    {
      "ip": "192.168.1.3",
      "sysname": "Some-Router",
      "lldp": false,
      "neighbors": 0,
      "aps": 0,
      "status": "no-lldp"
    },
    {
      "ip": "192.168.1.100",
      "sysname": null,
      "lldp": false,
      "neighbors": 0,
      "aps": 0,
      "status": "no-snmp"
    }
  ],
  "duration": "45.3s",
  "scanId": "lldp-snmp-1701234567890-abc123"
}
```

**Campi risposta:**
- `success`: Boolean, sempre `true` se completato
- `network`: CIDR richiesto
- `scanned`: Numero totale IP scansionati
- `responsive`: Numero device SNMP responsive
- `lldpEnabled`: Numero device con LLDP MIB accessibile
- `apImported`: Numero totale Access Point importati nel database
- `devices`: Array dettagliato device scansionati
  - `ip`: Indirizzo IP
  - `sysname`: Nome sistema (da SNMP sysName)
  - `lldp`: Boolean, LLDP MIB accessibile
  - `neighbors`: Numero neighbors LLDP totali
  - `aps`: Numero Access Point tra i neighbors
  - `apList`: Array nomi AP (max 10 per risposta)
  - `status`: Stato discovery (`ok`, `no-snmp`, `no-lldp`, `error`)
- `duration`: Durata totale discovery
- `scanId`: ID univoco scansione (per tracking)

## Status Values

| Status | Descrizione |
|--------|-------------|
| `ok` | SNMP OK, LLDP accessibile |
| `no-snmp` | Device non risponde a SNMP |
| `no-lldp` | SNMP OK, ma LLDP MIB non accessibile |
| `error` | Errore generico durante scansione |

## Import Automatico Database

Quando vengono scoperti Access Point:

1. **Device Switch**: Creato/aggiornato in tabella `devices`
   - `ip`, `sysname`, `community=SNMP_COMMUNITY`, `status=active`

2. **Device AP**: Creati in tabella `devices` con `status=neighbor`
   - `sysname` = nome AP da LLDP
   - `sysdesc` = descrizione da LLDP (se disponibile)
   - `ip` = IP da LLDP RemManAddrTable (se disponibile)

3. **Link LLDP**: Creati in tabella `links`
   - `device_id` = ID switch
   - `remote_device_id` = ID AP
   - `remote_sysname`, `remote_chassisid`, `remote_portid`
   - `protocol = 'LLDP'`

## Esempi Uso

### Discovery subnet singola

```bash
curl -X POST http://localhost:4000/api/discovery/lldp-snmp \
  -H "Content-Type: application/json" \
  -d '{"network": "192.168.1.0/24"}'
```

### Discovery con script test

```bash
node test-lldp-snmp-api.mjs 192.168.1.0/24
```

### Monitoraggio scan in corso

```bash
# 1. Avvia discovery (ottieni scanId dalla risposta)
curl -X POST http://localhost:4000/api/discovery/lldp-snmp \
  -d '{"network": "192.168.1.0/24"}'

# 2. Monitora progresso
curl http://localhost:4000/api/scans/status
```

## Performance

- **Concurrency**: 10 worker paralleli
- **Timeout SNMP**: 3000ms per getSysName, 5000ms per walk LLDP
- **Subnet /24**: ~45-60 secondi
- **Subnet /25**: ~25-35 secondi
- **Cache**: Scan ID mantenuto 5 minuti dopo completamento

## Pattern Riconoscimento AP

L'endpoint filtra automaticamente Access Point usando regex case-insensitive:

```regex
/ap|pdv|wifi|wireless|wlan/i
```

**Esempi match:**
- `AP-PDV-001`
- `21_AP_Floor2_3`
- `WiFi-Guest-Controller`
- `WLAN-AP-East-Wing`
- `PDV-AccessPoint-12`

## Limitazioni

1. **Max host**: 1024 per richiesta (protezione contro subnet /16)
2. **Community SNMP**: Configurabile via `SNMP_COMMUNITY` env var (default: `public`)
3. **SNMP version**: Solo SNMPv2c supportato
4. **AP pattern**: Solo pattern predefinito, non personalizzabile
5. **Scan ID**: Valido solo 5 minuti dopo completamento

## Errori Comuni

### 400 Bad Request

```json
{
  "error": "network richiesto (formato CIDR, es. 192.168.1.0/24)"
}
```

**Causa**: Parametro `network` mancante o CIDR invalido

**Soluzione**: Verificare formato CIDR (es. `192.168.1.0/24`)

### 500 Internal Server Error

```json
{
  "error": "CIDR troppo grande. Limite 1024 host per run."
}
```

**Causa**: Subnet troppo grande (es. /16 = 65536 host)

**Soluzione**: Spezzare in subnet più piccole (max /22 = 1024 host)

## Workflow Tipico

```
1. POST /api/discovery/lldp-snmp {"network": "192.168.1.0/24"}
   ↓
2. Server scansiona subnet in parallelo
   ↓
3. Per ogni IP:
   - Test SNMP sysName
   - Se OK → Test LLDP MIB
   - Se LLDP OK → Walk neighbors
   - Se AP trovati → Import database
   ↓
4. Response aggregata con risultati
   ↓
5. Database aggiornato con nuovi AP e link
```

## Integrazione Frontend

```javascript
async function discoverLLDPNetwork(network) {
  const response = await fetch('/api/discovery/lldp-snmp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network })
  });

  const result = await response.json();

  console.log(`Scansionati: ${result.scanned}`);
  console.log(`LLDP abilitato: ${result.lldpEnabled}`);
  console.log(`AP importati: ${result.apImported}`);

  // Mostra device con AP
  const withAP = result.devices.filter(d => d.aps > 0);
  withAP.forEach(d => {
    console.log(`${d.ip} - ${d.sysname}: ${d.aps} AP`);
  });

  return result;
}
```

## Note Implementative

- **Community**: L'endpoint usa `COMMUNITY` da env `SNMP_COMMUNITY` (default: `public`)
- **Deduplicazione link**: `upsertLink()` gestisce automaticamente INSERT OR REPLACE
- **Status neighbor**: AP creati con `status='neighbor'` per distinguerli da device scoperti
- **LLDP MIB**: Test su OID `1.0.8802.1.1.2.1.1.1.0` (lldpMessageTxInterval)
- **Walk neighbors**: OID `1.0.8802.1.1.2.1.4.1.1.9` (lldpRemSysName)
- **Discovery completa**: Per AP con neighbors > 0, esegue `discoverProtocols()` completo

## Vedi Anche

- [check-huawei-lldp-snmp.mjs](../check-huawei-lldp-snmp.mjs) - Script standalone test LLDP
- [import-lldp-neighbors.mjs](../import-lldp-neighbors.mjs) - Script import manuale
- [libsnmp.js](../libsnmp.js) - Libreria SNMP NetMap
- [HUAWEI_DEF_FILE_SOLUTION.md](./HUAWEI_DEF_FILE_SOLUTION.md) - Fix LLDP Huawei
