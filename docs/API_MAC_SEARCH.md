# API: MAC Address Search

> Endpoint per la ricerca di MAC address nel database NetMap

---

## Endpoint

```
GET /api/search/mac/:mac
```

### Parametri

| Parametro | Tipo | Obbligatorio | Descrizione |
|-----------|------|--------------|-------------|
| `mac` | string | Sì | MAC address da cercare (formati supportati: `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, `aabbccddeeff`) |

### Risposta (200 OK)

```json
{
  "query": "aa:bb:cc:dd:ee:ff",
  "normalized": "aa:bb:cc:dd:ee:ff",
  "totalCount": 15,
  "results": {
    "fdb": {
      "count": 10,
      "data": [
        {
          "mac": "aa:bb:cc:dd:ee:ff",
          "vlan": 100,
          "lastseen": 1733404800,
          "firstseen": 1733318400,
          "device": "SWITCH-01",
          "device_ip": "10.0.1.1",
          "interface": "GigabitEthernet0/1"
        }
      ]
    },
    "arp": {
      "count": 3,
      "data": [
        {
          "mac": "aa:bb:cc:dd:ee:ff",
          "ip": "10.0.1.100",
          "lastseen": 1733404800,
          "device": "SWITCH-01",
          "device_ip": "10.0.1.1"
        }
      ]
    },
    "interfaces": {
      "count": 2,
      "data": [
        {
          "mac": "aa:bb:cc:dd:ee:ff",
          "ifname": "GigabitEthernet0/1",
          "ifdescr": "Uplink to Core",
          "device": "SWITCH-01",
          "device_ip": "10.0.1.1"
        }
      ]
    }
  }
}
```

### Errore (400 Bad Request)

```json
{
  "error": "Formato MAC non valido (attesi 12 caratteri esadecimali)"
}
```

### Errore (500 Internal Server Error)

```json
{
  "error": "Messaggio di errore"
}
```

---

## Tabelle Coinvolte

### 1. FDB (Forwarding Database)
**Descrizione**: Tabella di MAC address appresi dagli switch.

**Campi utilizzati**:
- `mac`: Indirizzo MAC
- `vlan`: VLAN ID
- `lastseen`: Timestamp ultimo avvistamento
- `firstseen`: Timestamp primo avvistamento
- `device_id`: FK verso `devices.id`
- `interface_id`: FK verso `interfaces.id`

### 2. ARP Table
**Descrizione**: Associazioni MAC-IP dai dispositivi.

**Campi utilizzati**:
- `mac`: Indirizzo MAC
- `ip`: Indirizzo IP associato
- `lastseen`: Timestamp ultimo avvistamento
- `device_id`: FK verso `devices.id`

### 3. Interfaces
**Descrizione**: MAC address fisici delle interfacce di rete.

**Campi utilizzati**:
- `ifphysaddress`: MAC address dell'interfaccia
- `ifname`: Nome interfaccia
- `ifdescr`: Descrizione interfaccia
- `device_id`: FK verso `devices.id`

---

## Logica di Ricerca

1. **Normalizzazione MAC**: Input convertito in formato standard `aa:bb:cc:dd:ee:ff`
2. **Validazione**: Verifica 12 caratteri esadecimali
3. **Ricerca Parallela**: Query simultanee su FDB, ARP, Interfaces
4. **Pattern Matching**: Supporta ricerca parziale con LIKE SQL
5. **Ordinamento**: Risultati FDB/ARP ordinati per `lastseen DESC`
6. **Limite**: Max 100 risultati per tabella

---

## Frontend Integration

### Campo di Ricerca

Posizionato nella `.filters-bar` di `discovery.html`:

```html
<div class="mac-search-box">
  <input type="text" id="macSearchInput"
         placeholder="Cerca MAC (aa:bb:cc:dd:ee:ff)"
         onkeydown="if(event.key==='Enter') searchMac()">
  <button onclick="searchMac()" class="btn-search-mac">
    <svg>...</svg>
  </button>
</div>
```

### Funzione JavaScript

```javascript
async function searchMac() {
  const macInput = document.getElementById('macSearchInput').value.trim();
  if (!macInput || macInput.length < 6) {
    showToast('Inserisci almeno 6 caratteri del MAC address', 'warning');
    return;
  }

  try {
    showToast('Ricerca MAC in corso...', 'info');
    const response = await fetch(`/api/search/mac/${encodeURIComponent(macInput)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Errore ricerca');
    }

    displayMacResults(data);
  } catch (error) {
    showToast('Errore: ' + error.message, 'error');
  }
}
```

### Modal Risultati

I risultati vengono mostrati in un modal overlay con tre sezioni:
- **FDB Table**: MAC appresi dagli switch
- **ARP Table**: Associazioni MAC-IP
- **Interfaces**: MAC fisici interfacce

Stile: Industrial/SCADA con tema amber/verde terminale.

---

## Testing

### Script di Test

```bash
# Avvia server (terminale 1)
node server.js

# Test API (terminale 2)
node test-mac-search-api.mjs aa:bb:cc:dd:ee:ff
```

### Test Manuale Browser

1. Apri `http://localhost:4000/discovery.html`
2. Inserisci MAC nel campo "Cerca MAC"
3. Premi Enter o clicca sull'icona lente
4. Verifica modal con risultati

### Test cURL

```bash
# MAC completo
curl http://localhost:4000/api/search/mac/aa:bb:cc:dd:ee:ff

# MAC parziale
curl http://localhost:4000/api/search/mac/aabbcc

# MAC formato alternativo
curl http://localhost:4000/api/search/mac/aa-bb-cc-dd-ee-ff
```

---

## Performance

- **Query Time**: ~50-200ms (dipende da dimensione DB)
- **Limite Risultati**: 100 record per tabella (totale max 300)
- **Indici Consigliati**:
  ```sql
  CREATE INDEX idx_fdb_mac ON fdb(mac);
  CREATE INDEX idx_arp_mac ON arp(mac);
  CREATE INDEX idx_interfaces_mac ON interfaces(ifphysaddress);
  ```

---

## Use Cases

1. **Troubleshooting**: Trovare su quale porta è connesso un dispositivo
2. **Security**: Identificare dispositivi non autorizzati
3. **Inventory**: Tracciare spostamenti di dispositivi tra porte
4. **IP Conflict**: Verificare associazioni MAC-IP

---

## Formati MAC Supportati

| Formato | Esempio | Supportato |
|---------|---------|------------|
| Colon | `aa:bb:cc:dd:ee:ff` | ✅ |
| Hyphen | `aa-bb-cc-dd-ee-ff` | ✅ |
| Cisco | `aabb.ccdd.eeff` | ✅ |
| Plain | `aabbccddeeff` | ✅ |
| Uppercase | `AA:BB:CC:DD:EE:FF` | ✅ (convertito a lowercase) |
| Partial | `aabbcc` | ✅ (ricerca parziale) |

---

## Limitazioni

- **Case Insensitive**: Tutti i MAC sono normalizzati a lowercase
- **Ricerca Esatta**: Non supporta wildcard regex (solo LIKE SQL)
- **Storico**: Mostra solo snapshot corrente, non storico completo
- **Vendor OUI**: Non risolve Organizational Unique Identifier

---

## Future Enhancements

- [ ] OUI Vendor Lookup (IEEE database)
- [ ] Storico spostamenti MAC tra porte
- [ ] Export risultati CSV/JSON
- [ ] Filtri avanzati (per VLAN, per site, per timestamp)
- [ ] Graph visualizzazione percorso MAC
