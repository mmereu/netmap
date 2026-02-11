/**
 * Council Metrics - Statistics and Monitoring
 *
 * Raccoglie e espone metriche per il monitoring del Council.
 * Include latency, success rate, provider stats, cache hit rate.
 *
 * @version 1.0.0
 */

// =============================================================================
// METRICS STORAGE
// =============================================================================

const metrics = {
  // Query metrics
  queries: {
    total: 0,
    successful: 0,
    failed: 0,
    cached: 0,
    earlyExit: 0
  },

  // Latency metrics (rolling window)
  latency: {
    samples: [],
    maxSamples: 1000
  },

  // Provider metrics
  providers: {},

  // Query type distribution
  queryTypes: {},

  // Response type distribution
  responseTypes: {},

  // Hourly stats
  hourlyStats: {},

  // Start time
  startTime: Date.now()
};

// =============================================================================
// RECORDING FUNCTIONS
// =============================================================================

/**
 * Record a council query
 *
 * @param {object} result - Query result
 */
export function recordQuery(result) {
  metrics.queries.total++;

  if (result.error || result.responseType === 'error') {
    metrics.queries.failed++;
  } else {
    metrics.queries.successful++;
  }

  if (result.fromCache) {
    metrics.queries.cached++;
  }

  if (result.earlyExit) {
    metrics.queries.earlyExit++;
  }

  // Record latency
  if (result.totalLatency) {
    recordLatency(result.totalLatency);
  }

  // Record query type
  if (result.queryType) {
    metrics.queryTypes[result.queryType] = (metrics.queryTypes[result.queryType] || 0) + 1;
  }

  // Record response type
  if (result.responseType) {
    metrics.responseTypes[result.responseType] = (metrics.responseTypes[result.responseType] || 0) + 1;
  }

  // Record provider stats
  if (result.providers) {
    for (const provider of result.providers) {
      recordProviderSuccess(provider.provider, provider.latency);
    }
  }

  if (result.errors) {
    for (const error of result.errors) {
      recordProviderError(error.provider, error.error);
    }
  }

  // Record hourly stats
  recordHourly();
}

/**
 * Record latency sample
 */
function recordLatency(latencyMs) {
  metrics.latency.samples.push({
    value: latencyMs,
    timestamp: Date.now()
  });

  // Keep only last N samples
  if (metrics.latency.samples.length > metrics.latency.maxSamples) {
    metrics.latency.samples.shift();
  }
}

/**
 * Record provider success
 */
function recordProviderSuccess(provider, latency) {
  if (!metrics.providers[provider]) {
    metrics.providers[provider] = {
      calls: 0,
      successes: 0,
      failures: 0,
      totalLatency: 0,
      latencySamples: []
    };
  }

  const p = metrics.providers[provider];
  p.calls++;
  p.successes++;
  p.totalLatency += latency || 0;

  if (latency) {
    p.latencySamples.push(latency);
    if (p.latencySamples.length > 100) {
      p.latencySamples.shift();
    }
  }
}

/**
 * Record provider error
 */
function recordProviderError(provider, error) {
  if (!metrics.providers[provider]) {
    metrics.providers[provider] = {
      calls: 0,
      successes: 0,
      failures: 0,
      totalLatency: 0,
      latencySamples: [],
      lastError: null
    };
  }

  const p = metrics.providers[provider];
  p.calls++;
  p.failures++;
  p.lastError = {
    message: error,
    timestamp: Date.now()
  };
}

/**
 * Record hourly stats
 */
function recordHourly() {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH

  if (!metrics.hourlyStats[hour]) {
    metrics.hourlyStats[hour] = {
      queries: 0,
      successful: 0,
      cached: 0
    };
  }

  metrics.hourlyStats[hour].queries++;
  metrics.hourlyStats[hour].successful++;

  // Keep only last 24 hours
  const hours = Object.keys(metrics.hourlyStats).sort();
  while (hours.length > 24) {
    delete metrics.hourlyStats[hours.shift()];
  }
}

// =============================================================================
// CALCULATION FUNCTIONS
// =============================================================================

/**
 * Calculate latency percentiles
 */
function calculateLatencyPercentiles() {
  const samples = metrics.latency.samples.map(s => s.value).sort((a, b) => a - b);

  if (samples.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
  }

  const percentile = (arr, p) => {
    const idx = Math.ceil(arr.length * p / 100) - 1;
    return arr[Math.max(0, idx)];
  };

  return {
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    avg: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
    min: samples[0],
    max: samples[samples.length - 1]
  };
}

/**
 * Calculate provider stats
 */
function calculateProviderStats() {
  const stats = {};

  for (const [name, data] of Object.entries(metrics.providers)) {
    const successRate = data.calls > 0 ? data.successes / data.calls : 0;
    const avgLatency = data.successes > 0 ? data.totalLatency / data.successes : 0;

    // Calculate p50 latency
    const sortedLatency = [...data.latencySamples].sort((a, b) => a - b);
    const p50Latency = sortedLatency.length > 0
      ? sortedLatency[Math.floor(sortedLatency.length / 2)]
      : 0;

    stats[name] = {
      calls: data.calls,
      successes: data.successes,
      failures: data.failures,
      successRate: (successRate * 100).toFixed(1) + '%',
      avgLatency: Math.round(avgLatency),
      p50Latency: Math.round(p50Latency),
      lastError: data.lastError
    };
  }

  return stats;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get all metrics
 */
export function getMetrics() {
  const uptime = Date.now() - metrics.startTime;
  const queryRate = metrics.queries.total / (uptime / 1000 / 60); // queries per minute

  return {
    uptime: {
      ms: uptime,
      human: formatUptime(uptime)
    },
    queries: {
      ...metrics.queries,
      successRate: metrics.queries.total > 0
        ? ((metrics.queries.successful / metrics.queries.total) * 100).toFixed(1) + '%'
        : 'N/A',
      cacheHitRate: metrics.queries.total > 0
        ? ((metrics.queries.cached / metrics.queries.total) * 100).toFixed(1) + '%'
        : 'N/A',
      earlyExitRate: metrics.queries.total > 0
        ? ((metrics.queries.earlyExit / metrics.queries.total) * 100).toFixed(1) + '%'
        : 'N/A',
      queryRate: queryRate.toFixed(2) + '/min'
    },
    latency: calculateLatencyPercentiles(),
    providers: calculateProviderStats(),
    queryTypes: metrics.queryTypes,
    responseTypes: metrics.responseTypes,
    hourlyStats: metrics.hourlyStats
  };
}

/**
 * Get summary metrics (for dashboard)
 */
export function getMetricsSummary() {
  const latency = calculateLatencyPercentiles();
  const providerStats = calculateProviderStats();

  // Find best/worst providers
  const providerRanking = Object.entries(providerStats)
    .sort((a, b) => parseFloat(b[1].successRate) - parseFloat(a[1].successRate));

  return {
    totalQueries: metrics.queries.total,
    successRate: metrics.queries.total > 0
      ? ((metrics.queries.successful / metrics.queries.total) * 100).toFixed(1)
      : 0,
    cacheHitRate: metrics.queries.total > 0
      ? ((metrics.queries.cached / metrics.queries.total) * 100).toFixed(1)
      : 0,
    avgLatency: latency.avg,
    p95Latency: latency.p95,
    bestProvider: providerRanking[0]?.[0] || 'N/A',
    worstProvider: providerRanking[providerRanking.length - 1]?.[0] || 'N/A',
    activeProviders: Object.keys(providerStats).length
  };
}

/**
 * Get provider leaderboard
 */
export function getProviderLeaderboard() {
  const stats = calculateProviderStats();

  return Object.entries(stats)
    .map(([name, data]) => ({
      name,
      ...data,
      score: calculateProviderScore(data)
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Calculate provider score (0-100)
 */
function calculateProviderScore(data) {
  const successWeight = 0.5;
  const latencyWeight = 0.3;
  const reliabilityWeight = 0.2;

  const successScore = parseFloat(data.successRate) || 0;

  // Latency score (lower is better, normalize to 0-100)
  const latencyScore = Math.max(0, 100 - (data.avgLatency / 50)); // 5s = 0

  // Reliability (no recent errors)
  const reliabilityScore = data.lastError
    ? Math.max(0, 100 - (Date.now() - data.lastError.timestamp) / 60000) // decay over 100 min
    : 100;

  return Math.round(
    successScore * successWeight +
    latencyScore * latencyWeight +
    reliabilityScore * reliabilityWeight
  );
}

/**
 * Reset metrics
 */
export function resetMetrics() {
  metrics.queries = { total: 0, successful: 0, failed: 0, cached: 0, earlyExit: 0 };
  metrics.latency.samples = [];
  metrics.providers = {};
  metrics.queryTypes = {};
  metrics.responseTypes = {};
  metrics.hourlyStats = {};
  metrics.startTime = Date.now();

  console.log('[Metrics] Reset complete');
  return { reset: true };
}

/**
 * Format uptime for display
 */
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// =============================================================================
// PROMETHEUS FORMAT EXPORT
// =============================================================================

/**
 * Export metrics in Prometheus format
 */
export function getPrometheusMetrics() {
  const lines = [];
  const latency = calculateLatencyPercentiles();
  const providerStats = calculateProviderStats();

  // Queries
  lines.push('# HELP council_queries_total Total number of council queries');
  lines.push('# TYPE council_queries_total counter');
  lines.push(`council_queries_total ${metrics.queries.total}`);

  lines.push('# HELP council_queries_successful Successful queries');
  lines.push('# TYPE council_queries_successful counter');
  lines.push(`council_queries_successful ${metrics.queries.successful}`);

  lines.push('# HELP council_queries_cached Cached queries');
  lines.push('# TYPE council_queries_cached counter');
  lines.push(`council_queries_cached ${metrics.queries.cached}`);

  // Latency
  lines.push('# HELP council_latency_ms Query latency in milliseconds');
  lines.push('# TYPE council_latency_ms summary');
  lines.push(`council_latency_ms{quantile="0.5"} ${latency.p50}`);
  lines.push(`council_latency_ms{quantile="0.9"} ${latency.p90}`);
  lines.push(`council_latency_ms{quantile="0.95"} ${latency.p95}`);
  lines.push(`council_latency_ms{quantile="0.99"} ${latency.p99}`);

  // Provider metrics
  lines.push('# HELP council_provider_calls Provider call count');
  lines.push('# TYPE council_provider_calls counter');
  for (const [name, data] of Object.entries(providerStats)) {
    lines.push(`council_provider_calls{provider="${name}"} ${data.calls}`);
  }

  lines.push('# HELP council_provider_success Provider success rate');
  lines.push('# TYPE council_provider_success gauge');
  for (const [name, data] of Object.entries(providerStats)) {
    lines.push(`council_provider_success{provider="${name}"} ${parseFloat(data.successRate) / 100}`);
  }

  return lines.join('\n');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  recordQuery,
  getMetrics,
  getMetricsSummary,
  getProviderLeaderboard,
  resetMetrics,
  getPrometheusMetrics
};
