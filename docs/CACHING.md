# NetMap Caching Architecture

## Overview

NetMap implements a multi-level caching system to optimize topology map generation and database query performance. The caching architecture reduces response times from 200-500ms to near-instant for cached requests.

## Cache Layers

The system uses three distinct cache layers:

| Layer | Location | Purpose | Default TTL |
|-------|----------|---------|-------------|
| **MapCache** | server.js | Caches final map results | 60 seconds |
| **DatabaseQueryCache** | libdb.js | Caches SQLite query results | 60 seconds |
| **NeDiDB Cache** | libnedi.js | Caches NeDi MySQL query results | 5 minutes |

### Layer 1: MapCache (Map Results Cache)

**Location**: `server.js` (lines 64-103)

Caches the final computed map data (nodes + links) to avoid re-computing the entire topology on each request.

```javascript
const mapCache = new MapCache(60000); // 60 second TTL
```

**Cache Keys**:
- Format: `map-db:${JSON.stringify(req.query)}`
- Includes all query parameters (filters, options)

**Invalidation**:
- Automatically invalidated when `upsertDevice()` or `upsertLink()` is called
- Manual invalidation via `/api/cache/clear?type=map`

---

### Layer 2: DatabaseQueryCache (SQLite Query Cache)

**Location**: `libdb.js` (lines 10-150)

Caches individual database query results to avoid repeated SQLite queries.

**Configuration Options**:
```javascript
class DatabaseQueryCache {
  constructor(options = {}) {
    this.ttl = options.ttlMs || 60000;        // TTL in milliseconds
    this.maxSize = options.maxSize || 1000;   // Max cache entries
    this.cleanupIntervalMs = options.cleanupIntervalMs || 300000; // Cleanup interval
  }
}
```

**Cache Keys**:
| Key | Method | Description |
|-----|--------|-------------|
| `devices:all` | `getCachedAllDevices()` | All devices |
| `links:all` | `getCachedAllLinks()` | All links with device info |
| `links:deduplicated` | `getCachedDeduplicatedLinks()` | Deduplicated links for map |
| `interfaces:device:{deviceId}` | `getCachedDeviceInterfaces()` | Interfaces for specific device |

**Invalidation**:
- `upsertDevice()`: Invalidates `devices:all`
- `upsertLink()`: Invalidates `links:*` pattern
- `upsertInterface()`: Invalidates `interfaces:device:{deviceId}`

**Statistics Tracked**:
- `hits` - Cache hit count
- `misses` - Cache miss count
- `sets` - Cache write count
- `invalidations` - Manual invalidation count
- `cleanups` - Expired entry cleanup count
- `evictions` - LRU eviction count

---

### Layer 3: NeDiDB Cache (NeDi MySQL Cache)

**Location**: `libnedi.js` (lines 21-200)

Caches NeDi MySQL query results. Longer TTL since NeDi data changes less frequently.

**Configuration**:
```javascript
constructor(config = {}) {
  this.cacheTtl = config.cacheTtl || 300000;      // 5 minutes default
  this.cacheMaxSize = config.cacheMaxSize || 100; // Max entries
}
```

**Cache Keys**:
| Key | Method | Description |
|-----|--------|-------------|
| `nedi:devices:all` | `getCachedAllDevices()` | All NeDi devices |
| `nedi:links:all` | `getCachedAllLinks()` | All NeDi links |
| `nedi:topology:all` | `getCachedTopologyData()` | Default topology data |
| `nedi:topology:filter:{filter}` | `getCachedTopologyData({deviceFilter})` | Filtered topology |

**Cache Warming**:
The NeDi cache is pre-populated on server startup:
```javascript
// In server.js app.listen() callback
warmNeDiCache(); // Async, non-blocking
```

This ensures the first map request benefits from pre-warmed cache.

---

## Configuration Reference

### Default TTL Values

| Cache Layer | Default TTL | Reason |
|-------------|-------------|--------|
| MapCache | 60s | Balance between freshness and performance |
| DatabaseQueryCache | 60s | SQLite data changes moderately frequently |
| NeDiDB Cache | 300s (5 min) | NeDi data changes less frequently |

### Constructor Options

**DatabaseQueryCache**:
```javascript
const cache = new DatabaseQueryCache({
  ttlMs: 60000,            // Time-to-live in milliseconds
  maxSize: 1000,           // Maximum cache entries before LRU eviction
  cleanupIntervalMs: 300000 // Expired entry cleanup interval
});
```

**NeDiDB**:
```javascript
const nedi = new NeDiDB({
  cacheTtl: 300000,    // 5 minutes TTL
  cacheMaxSize: 100    // Maximum entries
});
```

---

## Admin API Endpoints

### GET /api/cache/stats

Returns statistics for all cache layers.

**Response Example**:
```json
{
  "mapCache": {
    "size": 5,
    "ttlMs": 60000
  },
  "databaseQueryCache": {
    "hits": 150,
    "misses": 20,
    "sets": 20,
    "invalidations": 5,
    "cleanups": 2,
    "evictions": 0,
    "hitRate": 0.88,
    "memoryEstimateKB": 256.5,
    "entries": ["devices:all", "links:deduplicated"]
  },
  "nediCache": {
    "size": 3,
    "maxSize": 100,
    "ttlMs": 300000,
    "hits": 45,
    "misses": 3,
    "hitRate": "93.75%",
    "entries": ["nedi:devices:all", "nedi:links:all", "nedi:topology:all"]
  },
  "aggregate": {
    "totalEntries": 10,
    "totalMemoryEstimateKB": 256.5,
    "overallHitRate": 0.89
  }
}
```

---

### POST /api/cache/clear

Admin endpoint to manually clear caches.

**Protection**: Localhost only OR `X-Debug-Token` header required.

**Query Parameters**:
| Parameter | Values | Description |
|-----------|--------|-------------|
| `type` | `map`, `db`, `nedi`, `all` | Cache type to clear (default: `all`) |

**Examples**:
```bash
# Clear all caches (localhost only)
curl -X POST http://localhost:3000/api/cache/clear

# Clear only MapCache
curl -X POST http://localhost:3000/api/cache/clear?type=map

# Clear with debug token (remote access)
curl -X POST http://server:3000/api/cache/clear \
  -H "X-Debug-Token: your-debug-token"
```

**Response Example**:
```json
{
  "success": true,
  "cleared": {
    "mapCache": 5,
    "databaseQueryCache": 3,
    "nediCache": 2,
    "total": 10
  }
}
```

---

## Response Headers

Map endpoints include cache performance headers:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Cache-Status` | Cache hit/miss status | `HIT`, `MISS`, `QUERY_CACHE` |
| `X-Query-Time` | Database query time (ms) | `45` |
| `X-Response-Time` | Total response time (ms) | `52` |

**Cache Status Values**:
- `HIT` - Full cache hit (MapCache)
- `MISS` - Cache miss, query executed
- `QUERY_CACHE` - MapCache miss but DatabaseQueryCache hit
- `NEDI_CACHE` - NeDi cache hit

---

## Performance Characteristics

### Expected Response Times

| Scenario | Response Time |
|----------|--------------|
| MapCache HIT | < 1ms |
| DatabaseQueryCache HIT + MapCache MISS | 5-20ms |
| Full cache MISS (cold) | 200-500ms |

### Memory Usage

- **DatabaseQueryCache**: ~250KB for typical dataset (1300 devices, 5000 links)
- **MapCache**: Variable, depends on map complexity
- **NeDiDB Cache**: ~500KB for typical NeDi dataset

### Hit Rate Targets

| Cache Layer | Target Hit Rate |
|-------------|-----------------|
| MapCache | > 90% |
| DatabaseQueryCache | > 85% |
| NeDiDB Cache | > 95% |

---

## Testing

### Benchmark Script

Run cache performance benchmarks:

```bash
node benchmark-cache.mjs --base-url http://localhost:3000 --iterations 10
```

**Output**:
- Cold cache response time
- Warm cache response time (average, min, max)
- Performance improvement percentage
- Pass/fail status (target: 50%+ improvement)

### Cache Invalidation Tests

Verify cache invalidation correctness:

```bash
node test-cache-invalidation.mjs --base-url http://localhost:3000
```

**Tests**:
1. Device cache invalidation on update
2. Link cache invalidation on update
3. Map reflects changes after invalidation
4. No stale data served
5. Cache statistics tracking
6. Cache key scoping validation

---

## Troubleshooting

### Cache Not Working

1. Check cache stats: `GET /api/cache/stats`
2. Verify TTL hasn't expired
3. Check for invalidation triggers (upsert calls)

### Memory Growth

1. Monitor `memoryEstimateKB` in stats
2. Reduce `maxSize` if needed
3. Verify cleanup timer is running

### Stale Data

1. Clear caches: `POST /api/cache/clear`
2. Check invalidation triggers
3. Verify TTL is appropriate

---

## File Reference

| File | Cache Component |
|------|-----------------|
| `server.js` | MapCache class, admin endpoints, cache warming |
| `libdb.js` | DatabaseQueryCache class, cached query methods |
| `libnedi.js` | NeDiDB cache methods |
| `benchmark-cache.mjs` | Performance benchmark script |
| `test-cache-invalidation.mjs` | Invalidation correctness tests |

---

## Implementation Date

2025-12-19

## Related Documentation

- `PERFORMANCE_OPTIMIZATION.md` - Overall performance optimizations
- `LINKS_CLEANUP.md` - Link query filtering and deduplication
