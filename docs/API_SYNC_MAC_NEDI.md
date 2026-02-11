# API Endpoint: Sync MAC da NeDi

Sincronizzazione MAC addresses dalla tabella `nodes` di NeDi alla tabella locale `fdb` di NetMap.

---

## Endpoint

```http
POST /api/admin/sync-mac-nedi
```

---

## Descrizione

Recupera i MAC addresses dalla tabella `nodes` del database MySQL di NeDi e li sincronizza nella tabella `fdb` locale (SQLite). Per ogni MAC address:

1. Normalizza il formato MAC (da formato NeDi a formato standard `xx:xx:xx:xx:xx:xx`)
2. Trova il `device_id` locale corrispondente al nome device
3. Trova l'`interface_id` locale corrispondente a device + ifname
4. Esegue `UPSERT` nella tabella `fdb` (inserisce o aggiorna se esiste)

---

## Request

### Headers
```http
Content-Type: application/json
```

### Body
```json
{
  "limit": 1000,      // Numero massimo di record da sincronizzare (default: 1000)
  "daysBack": 7       // Giorni indietro per filtro lastseen (default: 7)
}
```

### Parametri

| Parametro | Tipo | Default | Descrizione |
|-----------|------|---------|-------------|
| `limit` | number | 1000 | Numero massimo di record da NeDi |
| `daysBack` | number | 7 | Filtra MAC visti negli ultimi N giorni |

---

## Response

### Success (200 OK)

```json
{
  "message": "Sincronizzazione MAC completata",
  "stats": {
    "total": 1000,
    "inserted": 850,
    "skipped": 120,
    "errors": 30,
    "errorDetails": []
  },
  "errorDetails": [
    {
      "mac": "001122334455",
      "device": "SWITCH01",
      "error": "Device not found"
    }
  ]
}
```

### Error (500 Internal Server Error)

```json
{
  "error": "NeDi non disponibile"
}
```

### Error (503 Service Unavailable)

```json
{
  "error": "NeDi non disponibile"
}
```

---

## Logica di Sincronizzazione

### 1. Recupero MAC da NeDi

Query SQL eseguita su NeDi MySQL:

```sql
SELECT mac, device, ifname, vlanid, lastseen, oui, nodesc
FROM nodes
WHERE lastseen >= <timestamp>
  AND device IS NOT NULL
  AND device != ''
  AND ifname IS NOT NULL
  AND ifname != ''
ORDER BY lastseen DESC
LIMIT <limit>
```

Dove `<timestamp>` = `now - (daysBack * 86400)` secondi.

### 2. Normalizzazione MAC

Il formato MAC in NeDi può essere:
- `xxxxxxxxxxxx` (12 caratteri senza separatori)
- `xx:xx:xx:xx:xx:xx` (con `:`)
- `xx-xx-xx-xx-xx-xx` (con `-`)

Viene normalizzato sempre a: `xx:xx:xx:xx:xx:xx` (lowercase, separatori `:`)

### 3. Mapping Device

Per ogni MAC:
1. Cerca `device_id` in tabella locale `devices` usando `db.getDevice(device_name)`
2. Se non trovato → **skip** (incrementa `stats.skipped`)

### 4. Mapping Interface

Per ogni MAC con device valido:
1. Recupera tutte le interfacce del device: `db.getDeviceInterfaces(device_id)`
2. Cerca interfaccia con `ifname` corrispondente
3. Se non trovata → `interface_id = null` (MAC associato a device ma non a porta specifica)

### 5. Upsert FDB

Esegue `db.upsertFDB()` con:

```javascript
{
  device_id: <id>,
  interface_id: <id | null>,
  mac: <normalized_mac>,
  vlan: <vlan | 0>
}
```

La query SQL eseguita è:

```sql
INSERT INTO fdb (device_id, interface_id, mac, vlan)
VALUES (?, ?, ?, ?)
ON CONFLICT(device_id, mac, vlan) DO UPDATE SET
  interface_id = excluded.interface_id,
  lastseen = strftime('%s', 'now')
```

**Chiave primaria**: `(device_id, mac, vlan)`

---

## Stats Response

| Campo | Descrizione |
|-------|-------------|
| `total` | Numero totale di MAC recuperati da NeDi |
| `inserted` | Numero di MAC inseriti/aggiornati con successo |
| `skipped` | Numero di MAC saltati (device non trovato, MAC invalido) |
| `errors` | Numero di errori durante l'inserimento |
| `errorDetails` | Array con primi 10 errori (MAC, device, messaggio) |

---

## Esempi di Utilizzo

### cURL

```bash
# Sync default (1000 MAC, ultimi 7 giorni)
curl -X POST http://localhost:4000/api/admin/sync-mac-nedi \
  -H "Content-Type: application/json" \
  -d '{}'

# Sync custom (500 MAC, ultimi 3 giorni)
curl -X POST http://localhost:4000/api/admin/sync-mac-nedi \
  -H "Content-Type: application/json" \
  -d '{"limit": 500, "daysBack": 3}'
```

### JavaScript (fetch)

```javascript
const response = await fetch('http://localhost:4000/api/admin/sync-mac-nedi', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ limit: 2000, daysBack: 14 })
});

const result = await response.json();
console.log(`Inseriti: ${result.stats.inserted}, Saltati: ${result.stats.skipped}`);
```

### Script di Test

```bash
# Test con parametri default
node test-sync-mac-nedi.mjs

# Test con limit custom
node test-sync-mac-nedi.mjs 500

# Test con limit e daysBack custom
node test-sync-mac-nedi.mjs 500 3
```

---

## Troubleshooting

### Error: "NeDi non disponibile"

**Causa**: Connessione SSH/MySQL a NeDi fallita.

**Soluzione**:
1. Verifica connettività SSH: `ssh user@your-nedi-host`
2. Verifica credenziali MySQL in `libnedi.js` o env vars
3. Controlla firewall/rete

### Error: "Device not found"

**Causa**: Device presente in NeDi ma non in NetMap locale.

**Soluzione**:
1. Esegui prima un sync completo device: `POST /api/admin/sync-nedi`
2. Verifica match nome device (case-sensitive)

### Molti MAC skipped

**Causa**: Interfacce non sincronizzate o nomi ifname non corrispondenti.

**Soluzione**:
1. Verifica tabella `interfaces` popolata: `GET /api/devices/:name/detail`
2. Esegui sync completo da NeDi
3. Controlla mapping `ifname` tra NeDi e NetMap

---

## Note Tecniche

1. **Performance**: La query su NeDi è limitata da `LIMIT` per evitare timeout su tabelle molto grandi (>100K record)

2. **Idempotenza**: L'operazione è idempotente grazie a `UPSERT` - può essere rieseguita più volte senza duplicazioni

3. **Timestamp**: Il campo `lastseen` in `fdb` viene aggiornato automaticamente a `now` ad ogni sync

4. **VLAN default**: Se NeDi non ha `vlanid`, viene usato `0` come default

5. **MAC format**: Solo MAC validi a 12 caratteri esadecimali vengono processati

6. **Transaction**: Ogni `upsertFDB()` è una transazione separata - errori su singoli MAC non bloccano gli altri

---

## Dipendenze Metodi

### libnedi.js
- `nedi.getMacAddresses(limit, daysBack)` - Query tabella `nodes` MySQL

### libdb.js
- `db.getDevice(name)` - Trova device per nome
- `db.getDeviceInterfaces(device_id)` - Lista interfacce device
- `db.upsertFDB(fdb)` - Insert/Update nella tabella FDB

---

## Changelog

| Data | Versione | Descrizione |
|------|----------|-------------|
| 2025-12-03 | 1.0.0 | Implementazione iniziale endpoint sync MAC |
