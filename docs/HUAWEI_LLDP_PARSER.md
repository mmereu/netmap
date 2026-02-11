# Parser LLDP per Switch Huawei

## Descrizione

Modulo per parsare l'output del comando `display lldp neighbor` degli switch Huawei e convertirlo in formato compatibile con NetMap/NeDi.

## File

- **Parser**: `lib/huaweiLldpParser.js`
- **Test**: `test-huawei-lldp-parser.mjs`

## Formato Input

Il comando `display lldp neighbor` produce una tabella con 4 colonne:

```
Local Interface   HoldTime   Neighbor Port            Neighbor Device

10GE1/0/1                     101  XGigabitEthernet1/0/25        21_L3-CORE_251
GE1/0/5                        67  mgt0                          PDV021-GR-AP035
GE1/0/20                     2874  50eb-f675-275a
GE1/0/28                      105  e430-22ba-e408                HTW_e43022bae408
Eth-Trunk1                     90  Eth-Trunk2                    DISTRIB-SW-23
```

### Colonne

1. **Local Interface**: Interfaccia locale dello switch
2. **HoldTime**: Tempo di validità neighbor (secondi)
3. **Neighbor Port**: Interfaccia del neighbor
4. **Neighbor Device**: Nome del neighbor (può essere vuoto o MAC address)

## Funzionalità

### 1. `parseHuaweiLldpNeighbors(output)`

Parsa l'output completo del comando LLDP.

**Parametri:**
- `output` (string): Output del comando `display lldp neighbor`

**Ritorna:**
Array di oggetti neighbor:

```javascript
[
  {
    localPort: 'GE1/0/5',
    remotePort: 'mgt0',
    remoteSysname: 'PDV021-GR-AP035',
    remoteChassisId: null,
    holdTime: 67
  },
  {
    localPort: 'GE1/0/20',
    remotePort: '50eb-f675-275a',
    remoteSysname: '50eb-f675-275a',
    remoteChassisId: '50eb-f675-275a',
    holdTime: 2874
  }
]
```

### 2. `convertToNeDiLinks(neighbors, deviceName)`

Converte i neighbors in formato NeDi links.

**Parametri:**
- `neighbors` (Array): Array di neighbor da `parseHuaweiLldpNeighbors()`
- `deviceName` (string): Nome del device locale

**Ritorna:**
Array di link in formato NeDi:

```javascript
[
  {
    device: 'SW-HUAWEI-01',
    ifname: 'GE1/0/5',
    neighbor: 'PDV021-GR-AP035',
    nbrifname: 'mgt0',
    linktype: 'LLDP',
    bandwidth: 0,
    time: 1732975200
  }
]
```

## Formati Interfacce Supportati

Il parser riconosce i seguenti formati di interfacce Huawei:

| Formato Raw | Normalizzato | Descrizione |
|-------------|--------------|-------------|
| `GE1/0/1` | `GE1/0/1` | Gigabit Ethernet |
| `10GE1/0/24` | `10GE1/0/24` | 10 Gigabit Ethernet |
| `XGE1/0/48` | `XGE1/0/48` | 10G Ethernet (alias) |
| `Eth-Trunk1` | `Eth-Trunk1` | Link Aggregation |
| `GigabitEthernet1/0/1` | `GE1/0/1` | Gigabit Ethernet (nome lungo) |
| `XGigabitEthernet1/0/1` | `XGE1/0/1` | 10G Ethernet (nome lungo) |
| `TenGigabitEthernet1/0/1` | `10GE1/0/1` | 10G Ethernet (nome lungo) |
| `Ethernet1/0/1` | `Eth1/0/1` | Ethernet generico |

## Gestione Edge Cases

### MAC Address come Neighbor

Quando la colonna `Neighbor Device` è vuota, il parser cerca un MAC address nella colonna `Neighbor Port`:

```
GE1/0/20    2874  50eb-f675-275a
```

Risultato:
```javascript
{
  localPort: 'GE1/0/20',
  remotePort: '50eb-f675-275a',
  remoteSysname: '50eb-f675-275a',      // Fallback: usa MAC come nome
  remoteChassisId: '50eb-f675-275a',    // MAC salvato come chassis ID
  holdTime: 2874
}
```

### Neighbor con MAC ma Sysname Presente

```
GE1/0/28    105  e430-22ba-e408    HTW_e43022bae408
```

Risultato:
```javascript
{
  localPort: 'GE1/0/28',
  remotePort: 'e430-22ba-e408',
  remoteSysname: 'HTW_e43022bae408',    // Usa sysname
  remoteChassisId: null,                // Non è un MAC nel campo sysname
  holdTime: 105
}
```

### Righe Ignorate

Il parser ignora automaticamente:
- Righe di intestazione (es: `Local Interface   HoldTime ...`)
- Righe separatrici (es: `------`)
- Righe vuote
- Righe che non iniziano con un formato interfaccia valido

## Esempio d'Uso

```javascript
import { parseHuaweiLldpNeighbors, convertToNeDiLinks } from './lib/huaweiLldpParser.js';

// Output da switch Huawei
const lldpOutput = `
Local Interface   HoldTime   Neighbor Port            Neighbor Device
10GE1/0/1                     101  XGigabitEthernet1/0/25        21_L3-CORE_251
GE1/0/5                        67  mgt0                          PDV021-GR-AP035
`;

// 1. Parsing
const neighbors = parseHuaweiLldpNeighbors(lldpOutput);
console.log(`Trovati ${neighbors.length} neighbors`);

// 2. Conversione a formato NeDi
const deviceName = 'SW-HUAWEI-PDV021';
const links = convertToNeDiLinks(neighbors, deviceName);

// 3. Salvataggio in database NeDi/NetMap
for (const link of links) {
  await db.insertLink(link);
}
```

## Test

Esegui il test completo:

```bash
node test-huawei-lldp-parser.mjs
```

Il test verifica:
- ✅ Parsing output completo con vari formati
- ✅ Output vuoto (solo intestazioni)
- ✅ Formato misto (con MAC address senza sysname)
- ✅ Conversione a formato NeDi Links
- ✅ Validazione formati interfacce
- ✅ Edge cases (null, undefined, empty, headers)

## Integrazione con NetMap

### 1. Discovery via SSH

```javascript
import { SSHClient } from './lib/sshClient.js';
import { parseHuaweiLldpNeighbors, convertToNeDiLinks } from './lib/huaweiLldpParser.js';

const ssh = new SSHClient(deviceIp, username, password);
await ssh.connect();

const output = await ssh.executeCommand('display lldp neighbor');
const neighbors = parseHuaweiLldpNeighbors(output);
const links = convertToNeDiLinks(neighbors, deviceName);

await ssh.disconnect();
```

### 2. Import in Database

```javascript
import { NeDiDB } from './libnedi.js';

const nedi = new NeDiDB();
await nedi.connect();

for (const link of links) {
  await nedi.insertLink(link);
}
```

## Formato MAC Address Huawei

Huawei usa il formato **xxxx-xxxx-xxxx** per i MAC address:

```
Validi:
  50eb-f675-275a
  e430-22ba-e408
  ae45-bc32-1122

Non validi:
  50:eb:f6:75:27:5a    (formato IEEE)
  50-eb-f6-75-27-5a    (formato Windows)
  50ebf675275a         (senza separatori)
```

Il parser riconosce automaticamente questo formato tramite regex:
```javascript
/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i
```

## Limitazioni

1. **Bandwidth**: Non disponibile nell'output basic di `display lldp neighbor`
   - Impostato a `0` nei link NeDi
   - Per bandwidth reale, serve `display interface` separato

2. **Dettagli estesi**: Per più informazioni serve `display lldp neighbor verbose`
   - Capabilities
   - Management IP
   - System description
   - Port description

3. **Formati proprietari**: Alcuni switch Huawei usano formati custom per link aggregation
   - `Eth-Trunk` è supportato
   - Altri formati custom potrebbero richiedere estensioni

## Sviluppi Futuri

- [ ] Supporto per `display lldp neighbor verbose` (output esteso)
- [ ] Estrazione bandwidth da `display interface`
- [ ] Gestione capabilities LLDP
- [ ] Correlazione con CDP (se presente)
- [ ] Supporto per formati custom aggiuntivi

## Changelog

### 2025-11-30 - v1.0
- ✅ Parsing base output `display lldp neighbor`
- ✅ Riconoscimento formati interfacce (GE, 10GE, XGE, Eth-Trunk)
- ✅ Gestione MAC address come chassis ID
- ✅ Conversione a formato NeDi links
- ✅ Suite di test completa
- ✅ Documentazione

## Riferimenti

- **NeDi LLDP**: `docs/HUAWEI_DEF_FILE_SOLUTION.md`
- **Links Cleanup**: `docs/LINKS_CLEANUP.md`
- **Test Directory**: `test-huawei-lldp-parser.mjs`
