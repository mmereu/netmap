# Importazione Neighbors LLDP da NeDi

## Descrizione

La funzione `syncFromNeDi` in `server.js` è stata estesa con una **FASE 3** che importa automaticamente i neighbors LLDP scoperti da NeDi ma non ancora presenti nella tabella `devices`.

## Motivazione

NeDi scopre molti dispositivi via LLDP/CDP che appaiono come neighbors nei link ma non sono ancora stati aggiunti alla tabella `devices` (dispositivi non gestiti, client, AP, ecc.).

Senza questa funzionalità, questi dispositivi:
- ✗ Non appaiono nella topologia
- ✗ I link verso di loro risultano "broken" (remote_device_id = NULL)
- ✗ Non possono essere visualizzati o esplorati

Con la FASE 3, questi neighbors vengono importati come **device virtuali** e:
- ✓ Appaiono nella topologia come nodi
- ✓ I link verso di loro sono completi
- ✓ Possono essere visualizzati e filtrati

---

## Implementazione

### 1. Nuovo metodo in `libnedi.js`

```javascript
/**
 * Ottiene tutti i neighbor LLDP che NON sono presenti nella tabella devices
 * (cioè dispositivi scoperti via LLDP ma non ancora aggiunti a NeDi)
 */
async getNeighborDevices() {
  const sql = `
    SELECT DISTINCT l.neighbor, dn.devip
    FROM links l
    LEFT JOIN devices dn ON l.neighbor = dn.device
    WHERE l.neighbor NOT IN (SELECT device FROM devices)
    ORDER BY l.neighbor
  `;

  const output = await this.execQuery(sql);
  const columns = ['neighbor', 'devip'];

  return this.parseRows(output, columns).map(row => ({
    sysname: row.neighbor,
    ip: row.devip ? this.longToIp(row.devip) : null
  }));
}
```

**Funzionamento**:
- Query SQL che trova tutti i neighbors presenti in `links` ma non in `devices`
- Cerca di recuperare l'IP se disponibile (anche se di solito è NULL)
- Ritorna array di oggetti `{ sysname, ip }`

---

### 2. FASE 3 in `syncFromNeDi()` (server.js)

La FASE 3 è stata aggiunta dopo la fase di sincronizzazione links (linea ~3415):

```javascript
// ========== FASE 3: Sync neighbors LLDP come devices ==========
console.log('[NEDI-SYNC] Fase 3: Importazione neighbors LLDP...');

const neighborDevices = await nediDB.getNeighborDevices();
stats.neighbors.total = neighborDevices.length;

let fakeIpCounter = 0;
for (const neighbor of neighborDevices) {
  try {
    // Salta se già esiste
    const existing = db.db.prepare('SELECT id FROM devices WHERE sysname = ?').get(neighbor.sysname);
    if (existing) {
      stats.neighbors.skipped++;
      continue;
    }

    // Genera IP fittizio univoco per neighbor senza IP
    // Usa range 192.168.250-254.0-254 per supportare fino a 1275 devices (5 subnet * 255)
    let fakeIp = neighbor.ip;
    if (!fakeIp) {
      const subnet = 250 + Math.floor(fakeIpCounter / 255);
      const host = fakeIpCounter % 255;
      fakeIp = `192.168.${subnet}.${host}`;
      fakeIpCounter++;
    }

    // Inserisci come device virtuale
    db.db.prepare(`
      INSERT OR IGNORE INTO devices (sysname, ip, vendor, status, level, lastseen, firstseen)
      VALUES (?, ?, 'LLDP Neighbor', 'discovered', 1, strftime('%s','now'), strftime('%s','now'))
    `).run(neighbor.sysname, fakeIp);

    stats.neighbors.inserted++;
  } catch (err) {
    stats.neighbors.skipped++;
  }
}

console.log(`[NEDI-SYNC] Neighbors: ${stats.neighbors.inserted} inseriti, ${stats.neighbors.skipped} skippati`);
```

**Caratteristiche**:
- Salta neighbors già presenti nel DB locale
- Genera IP fittizi nel range `192.168.250-254.0-254` per supportare fino a **1275 neighbors**
- Imposta `vendor = 'LLDP Neighbor'`, `status = 'discovered'`, `level = 1`
- Traccia statistiche: `inserted`, `skipped`, `total`

---

### 3. Aggiornamento statistiche sync

La struttura `stats` è stata estesa con il campo `neighbors`:

```javascript
const stats = {
  devices: { inserted: 0, updated: 0, total: 0 },
  links: { inserted: 0, skipped: 0, deleted: 0, total: 0 },
  neighbors: { inserted: 0, skipped: 0, total: 0 },  // ← NUOVA
  duration: 0
};
```

Il log finale include anche i neighbors:

```javascript
console.log(`[NEDI-SYNC] Completato in ${stats.duration}ms: ${stats.devices.inserted} dev inseriti, ${stats.devices.updated} aggiornati, ${stats.links.inserted} link inseriti, ${stats.neighbors.inserted} neighbors importati`);
```

---

## Test

### Test 1: Verifica metodo getNeighborDevices()

```bash
node test-neighbor-import.mjs
```

**Output**:
```
============================================================
TEST: Importazione Neighbors LLDP
============================================================

[1] Connessione a NeDi...
✓ Connesso a NeDi MySQL

[2] Recupero neighbors LLDP non presenti in devices...
✓ Trovati 1792 neighbors LLDP non ancora in devices

[3] Primi 10 neighbors da importare:
------------------------------------------------------------
1. 00087b1a6ab2
   IP: N/A (verrà generato IP fittizio)
...

[4] Statistiche:
------------------------------------------------------------
Neighbors con IP reale:    0
Neighbors senza IP:        1792 (riceveranno IP fittizi 192.168.250-254.x)
Totale da importare:       1792
```

---

### Test 2: Sincronizzazione completa

```bash
node test-sync-direct.mjs
```

**Output**:
```
[NEDI-SYNC] Avvio sincronizzazione...
[NEDI-SYNC] Fase 1: Sincronizzazione devices...
[NEDI-SYNC] Trovati 1314 devices in NeDi
[NEDI-SYNC] Fase 2: Sincronizzazione links...
[NEDI-SYNC] Trovati 5727 links in NeDi
[NEDI-SYNC] Fase 3: Importazione neighbors LLDP...
[NEDI-SYNC] Trovati 1792 neighbors LLDP da importare
[NEDI-SYNC] Neighbors: 1763 inseriti, 29 skippati
[NEDI-SYNC] Completato in 1847ms

✅ 1763 neighbors LLDP importati con successo!
```

---

### Test 3: Verifica database

```bash
node check-neighbors.mjs
```

**Output**:
```
=== VERIFICA NEIGHBORS LLDP IMPORTATI ===

Neighbors LLDP importati: 1763

Primi 10 esempi:

1. 00087b1a6ab2
   IP: 192.168.250.0
   Vendor: LLDP Neighbor
   Status: discovered
   Level: 1

2. 00087b1a6c14
   IP: 192.168.250.1
   Vendor: LLDP Neighbor
   Status: discovered
   Level: 1
...
```

---

## Range IP Fittizi

I neighbors LLDP senza IP vengono assegnati a IP fittizi in questo modo:

| Subnet | Range Host | Capacità | Totale Cumulativo |
|--------|-----------|----------|-------------------|
| 192.168.250.x | 0-254 | 255 | 255 |
| 192.168.251.x | 0-254 | 255 | 510 |
| 192.168.252.x | 0-254 | 255 | 765 |
| 192.168.253.x | 0-254 | 255 | 1020 |
| 192.168.254.x | 0-254 | 255 | 1275 |

**Totale**: Fino a **1275 neighbors** supportati con IP fittizi.

**Algoritmo**:
```javascript
const subnet = 250 + Math.floor(counter / 255);  // 250-254
const host = counter % 255;                       // 0-254
const fakeIp = `192.168.${subnet}.${host}`;
```

---

## Identificazione Neighbors nella UI

I neighbors LLDP importati possono essere filtrati/identificati tramite:

- **Vendor**: `'LLDP Neighbor'`
- **Status**: `'discovered'`
- **Level**: `1`
- **IP**: Range `192.168.250-254.x` (se fittizio)

---

## Vantaggi

✅ **Topologia completa**: Tutti i dispositivi scoperti via LLDP appaiono nella mappa
✅ **Link completi**: I link verso neighbors non hanno più remote_device_id NULL
✅ **Filtri**: Possibile filtrare per "LLDP Neighbor" per vedere solo questi dispositivi
✅ **Discovery progressivo**: Se un neighbor viene successivamente aggiunto a NeDi, verrà aggiornato nella fase 1
✅ **Zero configurazione**: Automatico ad ogni sync NeDi

---

## Limitazioni

⚠️ **IP fittizi**: I neighbors senza IP ricevono IP fittizi (non raggiungibili)
⚠️ **Dati limitati**: Solo sysname disponibile (nessun model, vendor reale, ecc.)
⚠️ **Capacità massima**: Supporta fino a 1275 neighbors senza IP

---

## File Modificati

- `libnedi.js`: Aggiunto metodo `getNeighborDevices()`
- `server.js`: Aggiunta FASE 3 in `syncFromNeDi()`
- `test-neighbor-import.mjs`: Script di test per il nuovo metodo
- `test-sync-direct.mjs`: Test completo della sincronizzazione
- `check-neighbors.mjs`: Verifica neighbors nel database

---

## Data Aggiornamento

**2025-11-30**

---

## Note Tecniche

- La query SQL usa `LEFT JOIN` per recuperare eventuali IP dei neighbors (anche se di solito NULL)
- `INSERT OR IGNORE` previene errori di duplicazione
- Il contatore `fakeIpCounter` è locale al loop e riparte da 0 ad ogni sync
- I neighbors esistenti vengono skippati per evitare sovrascritture
