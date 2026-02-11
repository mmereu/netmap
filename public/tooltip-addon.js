/* global d3 */
/**
 * Tooltip System con Glassmorphism - Addon per topology-nedi-layer.html
 *
 * ISTRUZIONI DI INSTALLAZIONE:
 * 1. Aggiungi questo script alla fine del file HTML prima di </body>:
 *    <script src="tooltip-addon.js"></script>
 *
 * 2. Aggiungi il div tooltip nel HTML dopo #map-container:
 *    <div id="tooltip"></div>
 *
 * 3. Aggiungi gli stili CSS nel tag <style> (vedi tooltip-styles.css)
 */

(function() {
  'use strict';

  // Cache per dati tooltip (evita chiamate ripetute)
  const tooltipCache = new Map();
  const CACHE_TTL = 60000; // 1 minuto

  // Seleziona tooltip element (deve esistere nel DOM)
  const tooltip = d3.select('#tooltip');
  if (tooltip.empty()) {
    console.error('Tooltip element #tooltip non trovato nel DOM');
    return;
  }

  // Formatta uptime (secondi -> stringa leggibile)
  function formatUptime(seconds) {
    if (!seconds) return 'N/A';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 60)}m`;
  }

  // Formatta velocita link
  function formatSpeed(speed) {
    if (!speed) return 'N/A';
    if (speed >= 10000) return `${(speed / 1000).toFixed(0)} Gbps`;
    if (speed >= 1000) return `${(speed / 1000).toFixed(1)} Gbps`;
    return `${speed} Mbps`;
  }

  // Genera mini sparkline (dati port status)
  function generateSparkline(portStats) {
    if (!portStats || !portStats.length) {
      // Genera dati casuali se non disponibili
      return Array(10).fill(0).map(() => Math.random() * 100);
    }
    // Usa dati reali: percentuale porte up
    const maxBars = 10;
    const step = Math.max(1, Math.floor(portStats.length / maxBars));
    const bars = [];
    for (let i = 0; i < portStats.length; i += step) {
      const chunk = portStats.slice(i, i + step);
      const upCount = chunk.filter(p => p.ifoperstatus === 1).length;
      const percentage = (upCount / chunk.length) * 100;
      bars.push(percentage);
      if (bars.length >= maxBars) break;
    }
    // Riempi fino a 10 barre
    while (bars.length < maxBars) {
      bars.push(0);
    }
    return bars;
  }

  // Tooltip per NODI
  async function showNodeTooltip(event, node) {
    const ip = node.ip || node.id;
    if (!ip) return;

    // Posiziona tooltip
    const x = event.pageX + 15;
    const y = event.pageY + 15;

    // Mostra loading
    tooltip
      .style('left', `${x}px`)
      .style('top', `${y}px`)
      .classed('visible', true)
      .html('<div class="loading">Caricamento...</div>');

    // Check cache
    const cacheKey = `node-${ip}`;
    const cached = tooltipCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      renderNodeTooltip(cached.data, x, y);
      return;
    }

    // Fetch dati
    try {
      const response = await fetch(`/api/devices/${ip}/summary`);
      if (!response.ok) throw new Error('Dati non disponibili');
      const data = await response.json();

      // Cache data
      tooltipCache.set(cacheKey, { data, timestamp: Date.now() });

      renderNodeTooltip(data, x, y);
    } catch (err) {
      console.error('Errore caricamento tooltip:', err);
      tooltip.html(`
        <h4>${node.sysname || ip}</h4>
        <div class="tooltip-row">
          <span class="tooltip-label">IP:</span>
          <span class="tooltip-value">${ip}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Stato:</span>
          <span class="tooltip-value">Dati non disponibili</span>
        </div>
      `);
    }
  }

  function renderNodeTooltip(data, x, y) {
    const { device, portStats, uptime, vendor, model } = data;
    const portsUp = portStats ? portStats.filter(p => p.ifoperstatus === 1).length : 0;
    const portsDown = portStats ? portStats.filter(p => p.ifoperstatus === 2).length : 0;
    const sparklineData = generateSparkline(portStats);

    const html = `
      <h4>${device.sysname || device.ip}</h4>
      <div class="tooltip-section">
        <div class="tooltip-row">
          <span class="tooltip-label">IP:</span>
          <span class="tooltip-value">${device.ip}</span>
        </div>
        ${vendor ? `<div class="tooltip-row">
          <span class="tooltip-label">Vendor:</span>
          <span class="tooltip-value">${vendor}</span>
        </div>` : ''}
        ${model ? `<div class="tooltip-row">
          <span class="tooltip-label">Model:</span>
          <span class="tooltip-value">${model}</span>
        </div>` : ''}
        <div class="tooltip-row">
          <span class="tooltip-label">Uptime:</span>
          <span class="tooltip-value">${formatUptime(uptime || device.sysuptime)}</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-row">
          <span class="tooltip-label">Porte Up:</span>
          <span class="tooltip-value status-badge status-up">${portsUp}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Porte Down:</span>
          <span class="tooltip-value status-badge ${portsDown > 0 ? 'status-down' : 'status-up'}">${portsDown}</span>
        </div>
      </div>
      <div class="sparkline">
        ${sparklineData.map(v => `<div class="sparkline-bar" style="height: ${v}%"></div>`).join('')}
      </div>
    `;

    tooltip.html(html);

    // Auto-positioning (evita bordi viewport)
    const tooltipNode = tooltip.node();
    const rect = tooltipNode.getBoundingClientRect();
    let finalX = x;
    let finalY = y;

    if (x + rect.width > window.innerWidth) {
      finalX = x - rect.width - 30;
    }
    if (y + rect.height > window.innerHeight) {
      finalY = y - rect.height - 10;
    }

    tooltip.style('left', `${finalX}px`).style('top', `${finalY}px`);
  }

  // Tooltip per LINK
  function showLinkTooltip(event, link) {
    const x = event.pageX + 15;
    const y = event.pageY + 15;

    const sourceIf = link.di || 'N/A';
    const targetIf = link.ni || 'N/A';
    const speed = formatSpeed(link.speed);
    const protocol = link.protocol || 'Unknown';

    // Determina stato (per ora basato su speed)
    let statusClass = 'status-up';
    let statusText = 'Up';
    if (!link.speed || link.speed === 0) {
      statusClass = 'status-warning';
      statusText = 'Unknown';
    }

    const html = `
      <h4>Link</h4>
      <div class="tooltip-section">
        <div class="tooltip-row">
          <span class="tooltip-label">Da:</span>
          <span class="tooltip-value">${link.source.sysname || link.source.ip}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Porta:</span>
          <span class="tooltip-value">${sourceIf}</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-row">
          <span class="tooltip-label">A:</span>
          <span class="tooltip-value">${link.target.sysname || link.target.ip}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Porta:</span>
          <span class="tooltip-value">${targetIf}</span>
        </div>
      </div>
      <div class="tooltip-section">
        <div class="tooltip-row">
          <span class="tooltip-label">Velocita:</span>
          <span class="tooltip-value">${speed}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Protocollo:</span>
          <span class="tooltip-value">${protocol}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Stato:</span>
          <span class="tooltip-value status-badge ${statusClass}">${statusText}</span>
        </div>
      </div>
    `;

    tooltip
      .html(html)
      .style('left', `${x}px`)
      .style('top', `${y}px`)
      .classed('visible', true);

    // Auto-positioning
    const tooltipNode = tooltip.node();
    const rect = tooltipNode.getBoundingClientRect();
    let finalX = x;
    let finalY = y;

    if (x + rect.width > window.innerWidth) {
      finalX = x - rect.width - 30;
    }
    if (y + rect.height > window.innerHeight) {
      finalY = y - rect.height - 10;
    }

    tooltip.style('left', `${finalX}px`).style('top', `${finalY}px`);
  }

  function hideTooltip() {
    tooltip.classed('visible', false);
  }

  // Esporta funzioni per uso globale
  window.TooltipSystem = {
    showNodeTooltip,
    showLinkTooltip,
    hideTooltip,
    formatUptime,
    formatSpeed
  };

  console.log('Tooltip System caricato con successo');
})();
