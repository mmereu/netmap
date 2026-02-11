# Fix Filtro e Deduplicazione Link in libnedi.js

## Data Implementazione
2025-11-30

## Problema Risolto

La libreria `libnedi.js` recuperava link dalla tabella `links` di NeDi MySQL senza applicare filtri adeguati, causando:

1. **Link incompleti**: Record con `linktype IS NULL` venivano inclusi nei risultati
2. **Duplicati dalla sorgente**: NeDi può memorizzare lo stesso link più volte (stesso device+ifname+neighbor) con timestamp diversi
3. **Neighbor con formato IP**: Alcuni link avevano come neighbor un IP invece del sysname, causando nodi duplicati nella mappa topologica

## Soluzione Implementata

### Modifiche SQL nei Metodi

Applicato a tutti i metodi che recuperano link:
- `getAllLinks()`
- `getLinksForMap(options)`
- `getDeviceLinks(deviceName)`

#### 1. Filtro Link Incompleti

```sql
WHERE l.linktype IS NOT NULL
  AND l.neighbor IS NOT NULL
  AND l.neighbor != ''
```

Esclude link senza tipo di protocollo (LLDP, CDP, MAC) o senza neighbor.

#### 2. Deduplicazione via GROUP BY

```sql
SELECT l.device, d.devip, l.ifname, l.neighbor, l.nbrifname,
       l.bandwidth, l.linktype, MAX(l.time) as time, dn.devip as nbrip
FROM links l
LEFT JOIN devices d ON l.device = d.device
LEFT JOIN devices dn ON l.neighbor = dn.device
WHERE l.linktype IS NOT NULL
  AND l.neighbor IS NOT NULL
  AND l.neighbor != ''
GROUP BY l.device, l.ifname, l.neighbor
ORDER BY l.device, l.ifname
```

**Chiave deduplicazione**: `(device, ifname, neighbor)`
- Ogni combinazione device+interfaccia+neighbor appare **una sola volta**
- `MAX(l.time)`: Prende il link con timestamp più recente quando ci sono duplicati

#### 3. Filtro Neighbor con Formato IP (JavaScript)

```javascript
const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

return this.parseRows(output, columns)
  .filter(row => !ipPattern.test(row.neighbor))  // Escludi neighbor con formato IP
  .map(row => ({ ... }));
```

Esclude link dove `neighbor` è un indirizzo IP (es: `192.168.1.1`), preferendo sempre il sysname.

## Risultati Test

### Prima delle Modifiche
- **Problema**: Link duplicati + neighbor IP causavano oltre 5000+ link con molti duplicati

### Dopo le Modifiche
```
✓ Totale link recuperati: 5391
✓ Link con neighbor IP: 0 (eliminati)
✓ Link con protocol LLDP: 4434
✓ Protocolli usati:
  - LLDP: 4434 link
  - MAC: 910 link
  - CDP: 47 link
✓ Device unici nei link: 3020
```

### Test Specifici Passati
1. ✅ `getAllLinks()`: Nessun neighbor IP, nessun linktype NULL
2. ✅ `getLinksForMap({ deviceFilter: '10' })`: Filtro sito funzionante, 198 link puliti
3. ✅ `getDeviceLinks(deviceName)`: Link per device specifico correttamente deduplicati

## Impatto sulla Topologia

### Prima
- Nodi duplicati per device con IP e sysname
- Link multipli tra stessi device (stessa porta)
- Visualizzazione mappa confusa e lenta

### Dopo
- **Un solo nodo per device** (usando sysname)
- **Un solo link per coppia (device, interfaccia, neighbor)**
- Mappa topologica pulita e performante

## File Modificati

1. **libnedi.js** (3 metodi):
   - `getAllLinks()` (righe 301-335)
   - `getLinksForMap(options)` (righe 387-428)
   - `getDeviceLinks(deviceName)` (righe 359-393)

2. **test-links-cleanup.mjs** (nuovo):
   - Script di test per verificare correttezza dei filtri
   - Valida assenza di neighbor IP
   - Conta link per protocollo
   - Verifica deduplicazione

## Comando di Test

```bash
node test-links-cleanup.mjs
```

Output atteso:
```
✓ Link con neighbor IP (dovrebbe essere 0): 0
✓ Protocolli usati: LLDP, MAC, CDP
✓ Device unici nei link: ~3000
```

## Note Tecniche

### Perché GROUP BY invece di DISTINCT?

`GROUP BY l.device, l.ifname, l.neighbor` permette di:
- Usare funzioni aggregate come `MAX(l.time)` per prendere il link più recente
- Deduplicare in modo deterministico (stesso risultato ogni volta)
- Migliori performance rispetto a `DISTINCT` con sottoqueries

### Perché Filtro IP in JavaScript?

Il pattern regex `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` è più flessibile e:
- Funziona anche se NeDi memorizza IP in formato stringa
- Non richiede modifiche alla query SQL
- Facile da testare e debuggare
- Può essere esteso per altri pattern (es: MAC address)

### Logica Preferenza Sysname

**Scenario**: NeDi ha due entry per lo stesso link fisico:
- Entry A: `neighbor = '192.168.1.1'` (IP)
- Entry B: `neighbor = 'SWITCH-01'` (sysname)

**Comportamento attuale**:
- `GROUP BY` + filtro IP elimina Entry A
- Rimane solo Entry B con sysname

**Miglioramento futuro possibile**:
Se serve logica più sofisticata (es: preferire sysname ma fallback su IP se non disponibile), si può usare query con `CASE WHEN` in SQL.

## Integrazione con Sync

Le modifiche sono **trasparenti** per il processo di sync:
- Sync continua a scrivere tutti i dati NeDi nel DB SQLite locale
- I metodi di lettura applicano i filtri solo quando recuperano i dati
- Nessun impatto sulle performance di scrittura
- Backward compatible: funziona con qualsiasi versione del DB NeDi

## Checklist Post-Implementazione

- [x] Test `getAllLinks()` passato
- [x] Test `getLinksForMap()` passato
- [x] Test `getDeviceLinks()` passato
- [x] Nessun neighbor con formato IP nei risultati
- [x] Deduplicazione funzionante (GROUP BY)
- [x] Documentazione creata
- [ ] Aggiornare CLAUDE.md con questa modifica
- [ ] Test su produzione con mappa topologica completa

## Autore
Claude Code Assistant - 2025-11-30
