# NeDi Device Details API

Documentazione completa dei metodi aggiunti alla classe `NeDiDB` per ottenere informazioni dettagliate sui device di rete.

## Indice

1. [Panoramica](#panoramica)
2. [Metodi Disponibili](#metodi-disponibili)
3. [Esempi di Utilizzo](#esempi-di-utilizzo)
4. [Strutture Dati](#strutture-dati)
5. [Gestione Errori](#gestione-errori)
6. [Testing](#testing)

---

## Panoramica

I nuovi metodi permettono di ottenere dati dettagliati da un device di rete presente nel database NeDi, inclusi:

- **Interfacce** - Porte di rete con status, speed, VLAN
- **VLANs** - VLANs configurate sul device
- **Connessioni** - Link LLDP/CDP con neighbor
- **Eventi** - Log eventi e alert recenti
- **Status** - CPU, memoria, temperatura, uptime
- **Full Status** - Tutti i dati aggregati in un'unica chiamata

Tutti i metodi sono **async** e gestiscono gli errori in modo robusto.

---

## Metodi Disponibili

### 1. `getDeviceInterfaces(deviceName)`

Ottiene tutte le interfacce di rete del device.

**Parametri:**
- `deviceName` (string) - Nome del device (es. "SW-CORE-01")

**Ritorna:** `Promise<Array<Interface>>`

**Tabella NeDi:** `interfaces`

**Esempio:**
```javascript
const interfaces = await nedi.getDeviceInterfaces('SW-CORE-01');
// Output: [
//   {
//     ifindex: 1,
//     ifname: 'GigabitEthernet0/0/1',
//     ifdescr: 'Uplink to Core',
//     iftype: 6,
//     ifspeed: 1000000000,
//     ifoperstatus: 1,
//     ifalias: 'Uplink',
//     ifphysaddress: '00:11:22:33:44:55',
//     vlan: 100
//   },
//   ...
// ]
```

---

### 2. `getDeviceVlans(deviceName)`

Ottiene le VLANs configurate sul device.

**Parametri:**
- `deviceName` (string) - Nome del device

**Ritorna:** `Promise<Array<VLAN>>`

**Tabella NeDi:** `vlans`

**Esempio:**
```javascript
const vlans = await nedi.getDeviceVlans('SW-CORE-01');
// Output: [
//   { vlan_id: 1, vlan_name: 'default', device: 'SW-CORE-01' },
//   { vlan_id: 10, vlan_name: 'Management', device: 'SW-CORE-01' },
//   { vlan_id: 100, vlan_name: 'Users', device: 'SW-CORE-01' }
// ]
```

---

### 3. `getDeviceConnections(deviceName)`

Ottiene le connessioni LLDP/CDP con informazioni dettagliate sui neighbor.

**Parametri:**
- `deviceName` (string) - Nome del device

**Ritorna:** `Promise<Array<Connection>>`

**Tabelle NeDi:** `links`, `devices`

**Esempio:**
```javascript
const connections = await nedi.getDeviceConnections('SW-CORE-01');
// Output: [
//   {
//     link_id: 1234,
//     local_device: 'SW-CORE-01',
//     local_ip: '192.168.1.1',
//     local_interface: 'GigabitEthernet0/0/24',
//     remote_device: 'SW-ACCESS-01',
//     remote_ip: '192.168.1.10',
//     remote_interface: 'GigabitEthernet0/0/1',
//     remote_type: 'S5720-28P-LI-AC',
//     remote_vendor: 'Huawei',
//     remote_location: 'Building A Floor 1',
//     bandwidth: 1000,
//     protocol: 'LLDP',
//     last_seen: 1732896000
//   },
//   ...
// ]
```

---

### 4. `getDeviceEvents(deviceName, limit = 5)`

Ottiene gli ultimi eventi/alert del device.

**Parametri:**
- `deviceName` (string) - Nome del device
- `limit` (number, optional) - Numero massimo di eventi (default: 5)

**Ritorna:** `Promise<Array<Event>>`

**Tabella NeDi:** `events`

**Severity levels:**
- `critical` - Livello ≥ 500
- `error` - Livello ≥ 400
- `warning` - Livello ≥ 300
- `info` - Livello ≥ 200
- `debug` - Livello < 200

**Esempio:**
```javascript
const events = await nedi.getDeviceEvents('SW-CORE-01', 3);
// Output: [
//   {
//     severity: 'warning',
//     description: 'Interface GigabitEthernet0/0/10 went down',
//     timestamp: 1732895000,
//     source: 'SW-CORE-01'
//   },
//   {
//     severity: 'info',
//     description: 'Configuration changed',
//     timestamp: 1732894000,
//     source: 'SW-CORE-01'
//   }
// ]
```

---

### 5. `getDeviceStatus(deviceName)`

Ottiene lo status operativo del device (CPU, memoria, temperatura, uptime).

**Parametri:**
- `deviceName` (string) - Nome del device

**Ritorna:** `Promise<DeviceStatus | null>`

**Tabella NeDi:** `devices`

**Esempio:**
```javascript
const status = await nedi.getDeviceStatus('SW-CORE-01');
// Output: {
//   device: 'SW-CORE-01',
//   cpu_usage: 15,           // Percentuale CPU
//   memory_usage: 42,        // Percentuale memoria
//   temperature: 38,         // Gradi Celsius
//   uptime_seconds: 8640000, // Secondi (100 giorni)
//   last_seen: 1732896000,
//   status: 'active',
//   alerts: {
//     cpu: false,            // Alert CPU attivo?
//     memory: false,         // Alert memoria attivo?
//     temperature: false,    // Alert temperatura attivo?
//     power_supply: false    // Alert alimentazione attivo?
//   }
// }
```

**Calcolo uptime:**
```javascript
const uptimeDays = Math.floor(status.uptime_seconds / 86400);
const uptimeHours = Math.floor((status.uptime_seconds % 86400) / 3600);
console.log(`Uptime: ${uptimeDays} giorni, ${uptimeHours} ore`);
```

---

### 6. `getDeviceFullStatus(deviceName)`

**Metodo aggregato** che ottiene TUTTI i dati del device in un'unica chiamata.

**Parametri:**
- `deviceName` (string) - Nome del device

**Ritorna:** `Promise<FullDeviceStatus>`

**Performance:** Esegue tutte le query in **parallelo** usando `Promise.all()` per ottimizzare i tempi.

**Esempio:**
```javascript
const fullStatus = await nedi.getDeviceFullStatus('SW-CORE-01');
// Output: {
//   device: {
//     sysname: 'SW-CORE-01',
//     ip: '192.168.1.1',
//     serial: 'ABC123456',
//     model: 'S5720-52X-PWR-SI',
//     vendor: 'Huawei',
//     os: 'VRP',
//     status: 'active',
//     ...
//   },
//   interfaces: {
//     count: 52,
//     list: [ ... ]
//   },
//   vlans: {
//     count: 15,
//     list: [ ... ]
//   },
//   connections: {
//     count: 24,
//     list: [ ... ]
//   },
//   events: {
//     count: 5,
//     list: [ ... ]
//   },
//   status: {
//     cpu_usage: 15,
//     memory_usage: 42,
//     temperature: 38,
//     ...
//   },
//   timestamp: 1732896000000
// }
```

---

## Esempi di Utilizzo

### Scenario 1: Dashboard Device

```javascript
import { getNeDiDB } from './libnedi.js';

async function createDeviceDashboard(deviceName) {
  const nedi = await getNeDiDB();

  try {
    const data = await nedi.getDeviceFullStatus(deviceName);

    console.log(`=== Dashboard: ${data.device.sysname} ===`);
    console.log(`IP: ${data.device.ip}`);
    console.log(`Model: ${data.device.model} (${data.device.vendor})`);
    console.log(`Status: ${data.device.status}`);
    console.log();
    console.log(`CPU: ${data.status.cpu_usage}%`);
    console.log(`Memory: ${data.status.memory_usage}%`);
    console.log(`Temperature: ${data.status.temperature}°C`);
    console.log();
    console.log(`Interfaces: ${data.interfaces.count}`);
    console.log(`VLANs: ${data.vlans.count}`);
    console.log(`Connections: ${data.connections.count}`);

    return data;
  } catch (error) {
    console.error(`Errore: ${error.message}`);
    return null;
  }
}
```

### Scenario 2: API Endpoint Express

```javascript
import express from 'express';
import { getNeDiDB } from './libnedi.js';

const app = express();

// GET /api/devices/:name/details
app.get('/api/devices/:name/details', async (req, res) => {
  try {
    const nedi = await getNeDiDB();
    const details = await nedi.getDeviceFullStatus(req.params.name);
    res.json(details);
  } catch (error) {
    res.status(404).json({
      error: 'Device not found',
      message: error.message
    });
  }
});

// GET /api/devices/:name/status
app.get('/api/devices/:name/status', async (req, res) => {
  try {
    const nedi = await getNeDiDB();
    const status = await nedi.getDeviceStatus(req.params.name);

    if (!status) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Scenario 3: Monitoring Alert

```javascript
async function checkDeviceHealth(deviceName) {
  const nedi = await getNeDiDB();
  const status = await nedi.getDeviceStatus(deviceName);

  if (!status) {
    return { healthy: false, message: 'Device not found' };
  }

  const issues = [];

  // Check CPU
  if (status.cpu_usage > 80) {
    issues.push(`High CPU usage: ${status.cpu_usage}%`);
  }

  // Check memory
  if (status.memory_usage > 85) {
    issues.push(`High memory usage: ${status.memory_usage}%`);
  }

  // Check temperature
  if (status.temperature > 65) {
    issues.push(`High temperature: ${status.temperature}°C`);
  }

  // Check alerts
  const activeAlerts = Object.entries(status.alerts)
    .filter(([key, value]) => value)
    .map(([key]) => key);

  if (activeAlerts.length > 0) {
    issues.push(`Active alerts: ${activeAlerts.join(', ')}`);
  }

  return {
    healthy: issues.length === 0,
    issues,
    status
  };
}
```

---

## Strutture Dati

### Interface
```typescript
interface Interface {
  ifindex: number;          // Indice interfaccia
  ifname: string;           // Nome interfaccia (es. "GigabitEthernet0/0/1")
  ifdescr: string;          // Descrizione
  iftype: number;           // Tipo interfaccia (IANA ifType)
  ifspeed: number;          // Velocità in bit/s
  ifoperstatus: number;     // Status operativo (1=up, 2=down)
  ifalias: string;          // Alias/descrizione custom
  ifphysaddress: string;    // MAC address
  vlan: number;             // VLAN ID (PVID)
}
```

### VLAN
```typescript
interface VLAN {
  vlan_id: number;          // ID VLAN
  vlan_name: string;        // Nome VLAN
  device: string;           // Nome device
}
```

### Connection
```typescript
interface Connection {
  link_id: number;          // ID univoco link
  local_device: string;     // Device locale
  local_ip: string;         // IP device locale
  local_interface: string;  // Interfaccia locale
  remote_device: string;    // Device remoto
  remote_ip: string;        // IP device remoto
  remote_interface: string; // Interfaccia remota
  remote_type: string;      // Modello device remoto
  remote_vendor: string;    // Vendor device remoto
  remote_location: string;  // Location device remoto
  bandwidth: number;        // Bandwidth in Mbps
  protocol: string;         // Protocollo (LLDP, CDP)
  last_seen: number;        // Timestamp ultima discovery
}
```

### Event
```typescript
interface Event {
  severity: 'critical' | 'error' | 'warning' | 'info' | 'debug';
  description: string;      // Descrizione evento
  timestamp: number;        // Unix timestamp
  source: string;           // Sorgente evento
}
```

### DeviceStatus
```typescript
interface DeviceStatus {
  device: string;           // Nome device
  cpu_usage: number;        // Percentuale CPU (0-100)
  memory_usage: number;     // Percentuale memoria (0-100)
  temperature: number;      // Temperatura in °C
  uptime_seconds: number;   // Uptime in secondi
  last_seen: number;        // Timestamp ultima discovery
  status: 'active' | 'inactive';
  alerts: {
    cpu: boolean;           // Alert CPU attivo
    memory: boolean;        // Alert memoria attivo
    temperature: boolean;   // Alert temperatura attivo
    power_supply: boolean;  // Alert alimentazione attivo
  };
}
```

---

## Gestione Errori

Tutti i metodi gestiscono gli errori in modo robusto:

1. **Query SQL fallite** - Ritornano array vuoti o `null`
2. **Device non trovato** - `getDeviceFullStatus()` lancia eccezione
3. **Errori di connessione** - Propagati al chiamante

**Best practice:**

```javascript
// Usa try-catch per gestire errori
try {
  const details = await nedi.getDeviceFullStatus('SW-UNKNOWN');
} catch (error) {
  console.error('Errore:', error.message);
  // Gestisci l'errore appropriatamente
}

// Verifica risultati null
const status = await nedi.getDeviceStatus('SW-CORE-01');
if (!status) {
  console.log('Device non trovato o senza dati status');
}

// Array vuoti per dati mancanti
const vlans = await nedi.getDeviceVlans('SW-CORE-01');
if (vlans.length === 0) {
  console.log('Nessuna VLAN configurata');
}
```

---

## Testing

### Test Manuale

Usa lo script di test fornito:

```bash
# Test tutti i metodi per un device specifico
node test-device-details.mjs SW-CORE-01

# Output atteso:
# - Lista interfacce
# - Lista VLANs
# - Lista connessioni
# - Eventi recenti
# - Status operativo
# - Full status aggregato
```

### Test Esempi

```bash
# Esegui gli esempi d'uso
node examples/device-details-example.mjs
```

### Test in Codice

```javascript
import { getNeDiDB } from './libnedi.js';

async function runTests() {
  const nedi = await getNeDiDB();
  const deviceName = 'SW-CORE-01';

  // Test getDeviceInterfaces
  const interfaces = await nedi.getDeviceInterfaces(deviceName);
  console.assert(Array.isArray(interfaces), 'interfaces should be array');

  // Test getDeviceVlans
  const vlans = await nedi.getDeviceVlans(deviceName);
  console.assert(Array.isArray(vlans), 'vlans should be array');

  // Test getDeviceConnections
  const connections = await nedi.getDeviceConnections(deviceName);
  console.assert(Array.isArray(connections), 'connections should be array');

  // Test getDeviceEvents
  const events = await nedi.getDeviceEvents(deviceName, 5);
  console.assert(Array.isArray(events), 'events should be array');
  console.assert(events.length <= 5, 'events should respect limit');

  // Test getDeviceStatus
  const status = await nedi.getDeviceStatus(deviceName);
  console.assert(status === null || typeof status === 'object', 'status should be object or null');

  // Test getDeviceFullStatus
  const fullStatus = await nedi.getDeviceFullStatus(deviceName);
  console.assert(fullStatus.device !== undefined, 'fullStatus should have device');
  console.assert(fullStatus.interfaces !== undefined, 'fullStatus should have interfaces');
  console.assert(fullStatus.vlans !== undefined, 'fullStatus should have vlans');

  console.log('✓ Tutti i test passati!');
}
```

---

## Performance Notes

- **`getDeviceFullStatus()`** usa `Promise.all()` per eseguire tutte le query in parallelo
- Cache non implementata - considera di aggiungere caching per chiamate frequenti
- Le query sono ottimizzate con `LIMIT` e `ORDER BY`
- Connessione SSH riutilizzata (singleton pattern)

## Limitazioni Note

1. **Tabelle NeDi specifiche** - I metodi assumono la struttura standard del DB NeDi
2. **Device name matching** - Case-sensitive, deve corrispondere esattamente al nome in NeDi
3. **IP conversion** - Gli IP sono memorizzati come long integer in NeDi e convertiti in dotted notation
4. **Eventi** - Limitati a ricerca per `source LIKE '%deviceName%'` (potrebbe includere match parziali)

---

## Changelog

### 2025-11-29 - Initial Release
- Aggiunti 6 nuovi metodi alla classe NeDiDB
- Creato test-device-details.mjs
- Creato examples/device-details-example.mjs
- Documentazione completa API
