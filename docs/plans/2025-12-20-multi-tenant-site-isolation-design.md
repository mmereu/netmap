# Multi-Tenant Site Isolation - Design Document

**Data**: 2025-12-20
**Status**: Approvato

## Overview

Aggiunta di isolamento per sito/tenant che permette a organizzazioni con più domini di rete di separare visibilità e accesso per sito (PDV locations).

## Decisioni Architetturali

| Aspetto | Scelta |
|---------|--------|
| Definizione siti | IP range + Pattern fallback |
| Permessi utente-sito | Assegnazione diretta |
| Link cross-site | Mostra link + nodo ghost |
| Admin | Accesso globale automatico |
| Utenti senza siti | Accesso globale (opt-in) |
| UI Admin | Tab in Admin esistente |

---

## Schema Database

Tre nuove tabelle:

```sql
-- Definizione siti
CREATE TABLE sites (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,        -- "PDV_Milano", "DC_Roma"
  description TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Regole di matching (ordinate per priorità)
CREATE TABLE site_rules (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL,
  rule_type TEXT NOT NULL,          -- 'ip_range' | 'cidr' | 'pattern'
  rule_value TEXT NOT NULL,         -- "10.1.0.0/16" | "PDV-MI-%"
  priority INTEGER DEFAULT 0,       -- Più alto = valutato prima
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

-- Assegnazione utenti a siti
CREATE TABLE user_sites (
  user_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, site_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
```

**Modifica tabella devices:**
```sql
ALTER TABLE devices ADD COLUMN site_id INTEGER REFERENCES sites(id);
CREATE INDEX idx_devices_site ON devices(site_id);
```

**Logica matching device → site:**
1. Ordina regole per priorità DESC
2. Per ogni regola: se `rule_type='cidr'` e device IP è nel range → assegna
3. Se `rule_type='pattern'` e syslocation LIKE pattern → assegna
4. Se nessun match → device resta "unassigned" (site_id = NULL)

---

## API Endpoints

### Admin - Gestione Siti

```
GET    /api/admin/sites              -- Lista tutti i siti
POST   /api/admin/sites              -- Crea sito
PUT    /api/admin/sites/:id          -- Modifica sito
DELETE /api/admin/sites/:id          -- Elimina sito

GET    /api/admin/sites/:id/rules    -- Lista regole del sito
POST   /api/admin/sites/:id/rules    -- Aggiungi regola
DELETE /api/admin/sites/rules/:id    -- Elimina regola

PUT    /api/admin/users/:id/sites    -- Assegna siti a utente
        body: { site_ids: [1, 2, 3] }
```

### Utility

```
GET    /api/admin/sites/preview      -- Preview assegnazioni
        ?dry_run=true                 -- Mostra quali device matchano quali siti

POST   /api/admin/sites/reassign     -- Ricalcola assegnazioni device
```

### Filtering (modifica endpoint esistenti)

```
GET /api/topology/map               -- Esistente, aggiungiamo filtro
    ?site_id=1                      -- Filtra per sito specifico

GET /api/devices                    -- Esistente
    -- Automaticamente filtrato in base a user_sites
```

**Logica filtering:**
- Middleware legge `user.role` e `user_sites` dalla sessione
- Se `role='admin'` → nessun filtro
- Se `user_sites` vuoto → nessun filtro (opt-in)
- Se `user_sites` popolato → WHERE device.site_id IN (user_sites)

---

## Topology View e Nodi Ghost

```javascript
function getTopologyForUser(user) {
  const userSites = getUserSites(user.id);

  // Admin o nessuna assegnazione = tutto
  if (user.role === 'admin' || userSites.length === 0) {
    return getFullTopology();
  }

  // Devices nel scope utente
  const scopeDevices = devices.filter(d => userSites.includes(d.site_id));
  const scopeDeviceIds = scopeDevices.map(d => d.id);

  // Links: almeno un endpoint in scope
  const links = allLinks.filter(link =>
    scopeDeviceIds.includes(link.source_id) ||
    scopeDeviceIds.includes(link.target_id)
  );

  // Identifica nodi ghost (endpoint fuori scope)
  const ghostDeviceIds = new Set();
  links.forEach(link => {
    if (!scopeDeviceIds.includes(link.source_id)) ghostDeviceIds.add(link.source_id);
    if (!scopeDeviceIds.includes(link.target_id)) ghostDeviceIds.add(link.target_id);
  });

  // Ghost nodes: info minima
  const ghostDevices = getDevicesByIds([...ghostDeviceIds]).map(d => ({
    id: d.id,
    sysname: d.sysname,
    type: 'ghost',
    site_name: d.site?.name || 'External'
  }));

  return { devices: scopeDevices, ghostDevices, links };
}
```

**Frontend:**
- Nodi ghost: icona grigia semi-trasparente, bordo tratteggiato
- Click su ghost → tooltip "Device esterno - Sito: X" (no panel dettagli)
- Legenda aggiornata con simbolo ghost

---

## UI Admin - Tab Sites

```
┌─────────────────────────────────────────────────────────┐
│  Admin Panel                                            │
├──────────┬──────────┬──────────┬───────────────────────┤
│  Users   │  Sites   │  System  │                       │
└──────────┴──────────┴──────────┴───────────────────────┘

[Sites Tab]
┌─────────────────────────────────────────────────────────┐
│ Sites                                    [+ New Site]   │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ PDV_Milano                              [Edit] [X]  │ │
│ │ Rules: 10.1.0.0/16, syslocation LIKE 'Milano%'      │ │
│ │ Devices: 45 | Users: 3                              │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Modal "Edit Site":**
- Nome, Descrizione
- Lista regole con drag-to-reorder (priorità)
- Preview: "23 devices matchano queste regole"

**Modifica "Edit User":**
- Multi-select "Assigned Sites"
- Se vuoto → utente vede tutto (hint)

---

## Middleware e Sicurezza

```javascript
function siteFilterMiddleware(req, res, next) {
  const user = req.user;

  // Admin bypass
  if (user.role === 'admin') {
    req.siteFilter = null;
    return next();
  }

  const userSites = db.getUserSites(user.id);

  // Nessuna assegnazione = accesso globale
  if (userSites.length === 0) {
    req.siteFilter = null;
    return next();
  }

  req.siteFilter = {
    siteIds: userSites.map(s => s.id),
    siteNames: userSites.map(s => s.name)
  };

  next();
}
```

**Sicurezza:**
- API detail device verifica device.site_id in user scope
- 403 Forbidden se accesso a device fuori scope
- Log tentativo in tabella `events`

---

## Piano Implementazione

### Fase 1 - Database & Backend Base
- Schema migration (nuove tabelle + ALTER devices)
- Metodi CRUD in `libdb.js` per sites, site_rules, user_sites
- Funzione `assignDeviceToSite()` con logica matching
- Job `reassignAllDevices()` per ricalcolo bulk

### Fase 2 - API Endpoints
- CRUD `/api/admin/sites` e `/api/admin/sites/:id/rules`
- `PUT /api/admin/users/:id/sites`
- `GET /api/admin/sites/preview` (dry-run)
- Middleware `siteFilter.js`

### Fase 3 - Integrazione Endpoints Esistenti
- Modifica `/api/devices` con filtro siti
- Modifica `/api/topology/map` con logica ghost nodes
- Protezione `/api/devices/:id/detail` (403 se fuori scope)

### Fase 4 - Frontend Admin
- Tab "Sites" in admin.html
- CRUD siti con gestione regole
- Multi-select siti in edit user
- Preview assegnazioni

### Fase 5 - Frontend Topology
- Stile nodi ghost (CSS)
- Filtro dropdown "Sito" in toolbar
- Legenda aggiornata
- Tooltip ghost nodes

### Testing
- Unit test matching IP/pattern
- Integration test API con utenti multi-sito
- E2E: utente vede solo devices del suo sito + ghost
