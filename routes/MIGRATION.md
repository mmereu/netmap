# Routes Migration Guide

## Overview

This guide explains how to gradually migrate routes from the monolithic `server.js` (9150+ lines) to modular route files.

## Current Structure

```
routes/
├── index.js      # Route registration and utilities
├── health.js     # Health check endpoints (migrated)
├── reports.js    # Report endpoints (template)
└── MIGRATION.md  # This file
```

## Planned Modules

| Module | Endpoints | Priority | Status |
|--------|-----------|----------|--------|
| `health.js` | /api/health, /api/debug/* | Low | Done |
| `reports.js` | /api/reports/* | Low | Template |
| `devices.js` | /api/devices/* | High | Pending |
| `ssh.js` | /api/ssh/* | Medium | Pending |
| `discovery.js` | /api/discover*, /api/discovery/* | High | Pending |
| `mac-search.js` | /api/search/mac/* | High | Pending |
| `admin.js` | /api/admin/* | Medium | Pending |
| `auth.js` | /api/auth/*, /api/users/* | Low | Pending |
| `nedi.js` | /api/nedi/* | Medium | Pending |
| `links.js` | /api/links* | Low | Pending |
| `map.js` | /api/map* | Medium | Pending |

## Migration Steps

### 1. Create Route Module

```javascript
// routes/devices.js
import { Router } from 'express';
import { createRouteModule } from './index.js';

export default createRouteModule((context) => {
  const router = Router();
  const { db, nedi } = context;

  // Migrate routes here
  router.get('/', (req, res) => {
    const devices = db.getAllDevices();
    res.json(devices);
  });

  return router;
});
```

### 2. Register in index.js

```javascript
// routes/index.js
import devicesRoutes from './devices.js';

const routeModules = [
  // ... existing modules
  { path: '/api/devices', module: devicesRoutes, name: 'devices' }
];
```

### 3. Update server.js

```javascript
// server.js
import { registerRoutes } from './routes/index.js';

// After creating app and db
registerRoutes(app, { db, nedi });

// Comment out or remove migrated routes from server.js
// app.get('/api/devices', ...) // MIGRATED to routes/devices.js
```

### 4. Test

```bash
# Test the migrated endpoint
curl http://localhost:4000/api/devices

# Run any existing tests
node test-devices.mjs
```

## Best Practices

1. **One module at a time**: Migrate one domain completely before moving to the next
2. **Keep old routes**: Comment out old routes rather than deleting until tested
3. **Use asyncHandler**: Import from `middleware/errorHandler.js` for consistent error handling
4. **Test thoroughly**: Each migration should be tested before committing
5. **Update documentation**: Keep CLAUDE.md and this file updated

## Using Error Handler

```javascript
import { asyncHandler, Errors } from '../middleware/errorHandler.js';

router.get('/:id', asyncHandler(async (req, res) => {
  const device = await db.getDevice(req.params.id);
  if (!device) {
    throw Errors.notFound('Device');
  }
  res.json(device);
}));
```

## Context Object

The context object passed to route modules contains:

```javascript
{
  db: NetMapDB,       // SQLite database instance
  nedi: NeDiDB,       // NeDi MySQL connection
  sshAgent: SSHAgent, // SSH client for servers
  config: {}          // Application configuration
}
```

## Timeline

- **Phase 1** (Current): Create structure, migrate simple endpoints
- **Phase 2**: Migrate devices, discovery, mac-search
- **Phase 3**: Migrate admin, ssh, nedi
- **Phase 4**: Migrate remaining endpoints
- **Phase 5**: Remove legacy routes from server.js
