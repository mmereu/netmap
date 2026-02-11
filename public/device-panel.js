/**
 * Device Details Side Panel JavaScript
 *
 * Gestisce apertura, chiusura, fetching dati e rendering del side panel
 */

// Stato globale del panel
const DevicePanel = {
  currentDevice: null,
  currentTab: 'overview',
  isOpen: false,
  cachedData: null
};

/**
 * Apre il panel e carica i dettagli del device
 * @param {string} deviceName - Nome del device da visualizzare
 */
async function openDevicePanel(deviceName) {
  if (!deviceName) {
    console.warn('[DevicePanel] Nome device non fornito');
    return;
  }

  console.log('[DevicePanel] Apertura panel per:', deviceName);

  const panel = document.getElementById('devicePanel');
  if (!panel) {
    console.error('[DevicePanel] Panel element non trovato');
    return;
  }

  // Mostra panel
  panel.classList.add('open');
  DevicePanel.isOpen = true;
  DevicePanel.currentDevice = deviceName;

  // Aggiorna titolo
  document.getElementById('panelTitle').textContent = deviceName;

  // Mostra loading
  showLoadingState();

  try {
    // Fetch dati dal server
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceName)}/detail`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const responseData = await response.json();
    console.log('[DevicePanel] Dati ricevuti RAW:', responseData);
    console.log('[DevicePanel] responseData.device:', responseData.device);
    console.log('[DevicePanel] responseData.interfaces:', responseData.interfaces);
    console.log('[DevicePanel] responseData.connections:', responseData.connections);

    // Normalizza il formato dei dati da NeDi o database locale
    let data = responseData;

    if (responseData.device) {
      // Formato completo NeDi con {device, interfaces, connections, ...}
      // Estrai gli array dai wrapper {count, list}
      const interfacesList = responseData.interfaces?.list || responseData.interfaces || [];
      const connectionsList = responseData.connections?.list || responseData.connections || [];

      console.log('[DevicePanel] Estratti interfacesList:', interfacesList.length, 'elementi');
      console.log('[DevicePanel] Estratti connectionsList:', connectionsList.length, 'elementi');

      data = {
        ...responseData.device,
        interfaces: interfacesList,
        ports: interfacesList,
        connections: connectionsList,
        neighbors: connectionsList,
        vlans: responseData.vlans?.list || responseData.vlans || [],
        events: responseData.events?.list || responseData.events || [],
        // Status dal device (NeDi usa 'status' come stringa tipo 'active')
        status: responseData.device?.status || responseData.status || 'unknown'
      };

      console.log('[DevicePanel] Dati normalizzati - ports:', data.ports?.length, 'neighbors:', data.neighbors?.length);
    } else {
      // Formato semplice con data direttamente dall'endpoint
      data = {
        ...responseData,
        ports: responseData.ports || responseData.interfaces || responseData.interfaces?.list || [],
        neighbors: responseData.neighbors || responseData.connections || responseData.connections?.list || []
      };
    }

    // Salva dati per cambio tab
    DevicePanel.cachedData = data;

    // Render tab attivo
    renderActiveTab(data);

    // Aggiorna timestamp
    updateTimestamp();

  } catch (error) {
    console.error('[DevicePanel] Errore caricamento dati:', error);
    showErrorState(error.message);
  }
}

/**
 * Chiude il panel
 */
function closeDevicePanel() {
  const panel = document.getElementById('devicePanel');
  if (panel) {
    panel.classList.remove('open');
    DevicePanel.isOpen = false;
    DevicePanel.currentDevice = null;
    DevicePanel.cachedData = null;
  }
}

/**
 * Refresh dei dati del device corrente
 */
async function refreshDevicePanel() {
  if (!DevicePanel.currentDevice) {
    console.warn('[DevicePanel] Nessun device corrente da aggiornare');
    return;
  }
  await openDevicePanel(DevicePanel.currentDevice);
}

/**
 * Gestisce il cambio tab
 * @param {string} tabName - Nome del tab ('overview', 'ports', 'neighbors')
 */
function switchTab(tabName) {
  // Aggiorna stato attivo nei bottoni tab
  document.querySelectorAll('.panel-tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Aggiorna contenuti visibili
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab${capitalize(tabName)}`);
  });

  DevicePanel.currentTab = tabName;
}

/**
 * Render del tab attivo con i dati
 * @param {Object} data - Dati del device
 */
function renderActiveTab(data) {
  switch (DevicePanel.currentTab) {
    case 'overview':
      renderOverviewTab(data);
      break;
    case 'ports':
      renderPortsTab(data);
      break;
    case 'neighbors':
      renderNeighborsTab(data);
      break;
  }
}

/**
 * Render del tab Overview
 * @param {Object} data - Dati del device
 */
function renderOverviewTab(data) {
  const container = document.getElementById('tabOverview');

  // Status può essere una stringa o un oggetto - normalizza a stringa
  let status = data.status;
  if (typeof status === 'object') {
    status = status?.state || status?.status || 'unknown';
  }
  status = status || 'unknown';

  const statusClass = status === 'up' ? 'status-up' :
                      status === 'down' ? 'status-down' :
                      status === 'warning' ? 'status-warning' :
                      status === 'active' ? 'status-up' : 'status-unknown';

  const html = `
    <div class="info-section">
      <h4>Device Info</h4>
      <div class="info-row">
        <span class="info-label">Name</span>
        <span class="info-value">${escapeHtml(data.name || data.sysname || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">IP Address</span>
        <span class="info-value">${escapeHtml(data.ip || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Type</span>
        <span class="info-value">${escapeHtml(data.type || 'Unknown')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-value">
          <span class="status-badge ${statusClass}">${status.toUpperCase()}</span>
        </span>
      </div>
    </div>

    <div class="info-section">
      <h4>System Details</h4>
      <div class="info-row">
        <span class="info-label">Model</span>
        <span class="info-value">${escapeHtml(data.model || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Serial</span>
        <span class="info-value">${escapeHtml(data.serial || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">MAC Address</span>
        <span class="info-value">${escapeHtml(data.mac || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">OS Version</span>
        <span class="info-value">${escapeHtml(data.os_version || data.version || 'N/A')}</span>
      </div>
    </div>

    <div class="info-section">
      <h4>Performance</h4>
      <div class="info-row">
        <span class="info-label">Uptime</span>
        <span class="info-value">${formatUptime(data.uptime)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">CPU Usage</span>
        <span class="info-value">${data.cpu ? data.cpu + '%' : 'N/A'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Memory Usage</span>
        <span class="info-value">${data.memory ? data.memory + '%' : 'N/A'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Temperature</span>
        <span class="info-value">${data.temperature ? data.temperature + '°C' : 'N/A'}</span>
      </div>
    </div>

    ${data.location ? `
    <div class="info-section">
      <h4>Location</h4>
      <div class="info-row">
        <span class="info-label">Building</span>
        <span class="info-value">${escapeHtml(data.location.building || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Floor</span>
        <span class="info-value">${escapeHtml(data.location.floor || 'N/A')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Room</span>
        <span class="info-value">${escapeHtml(data.location.room || 'N/A')}</span>
      </div>
    </div>
    ` : ''}
  `;

  container.innerHTML = html;
}

/**
 * Render del tab Ports
 * @param {Object} data - Dati del device
 */
function renderPortsTab(data) {
  const container = document.getElementById('tabPorts');
  console.log('[DevicePanel] renderPortsTab chiamato con data:', data);
  console.log('[DevicePanel] data.ports:', data?.ports);
  console.log('[DevicePanel] data.interfaces:', data?.interfaces);

  const ports = data.ports || data.interfaces || [];
  console.log('[DevicePanel] ports array finale:', ports.length, 'elementi');

  if (!ports || ports.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📡</div>
        <p>No ports information available</p>
      </div>
    `;
    return;
  }

  // Raggruppa per status
  // NeDi usa ifstat come BITMASK: bit0=admin, bit1=oper
  // ifstat=3 (0b11) = admin UP + oper UP
  // ifstat=1 (0b01) = admin UP, oper DOWN
  const upPorts = ports.filter(p => {
    const ifstat = p.ifoperstatus || 0;
    const adminUp = (ifstat & 1) !== 0;
    const operUp = (ifstat & 2) !== 0;
    return adminUp && operUp;
  });
  const downPorts = ports.filter(p => {
    const ifstat = p.ifoperstatus || 0;
    const adminUp = (ifstat & 1) !== 0;
    const operUp = (ifstat & 2) !== 0;
    return adminUp && !operUp;
  });

  const statsHtml = `
    <div class="info-section mb-12">
      <div style="display: flex; justify-content: space-around; text-align: center;">
        <div>
          <div style="font-size: 24px; font-weight: bold; color: #22c55e;">${upPorts.length}</div>
          <div style="font-size: 11px; color: #6b7280;">UP</div>
        </div>
        <div>
          <div style="font-size: 24px; font-weight: bold; color: #ef4444;">${downPorts.length}</div>
          <div style="font-size: 11px; color: #6b7280;">DOWN</div>
        </div>
        <div>
          <div style="font-size: 24px; font-weight: bold; color: #60a5fa;">${ports.length}</div>
          <div style="font-size: 11px; color: #6b7280;">TOTAL</div>
        </div>
      </div>
    </div>
  `;

  const tableHtml = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Port</th>
          <th>Status</th>
          <th>Speed</th>
          <th>VLAN</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        ${ports.map(port => {
          // Normalizza il nome porta da NeDi (ifname) o database
          const portName = port.ifname || port.name || port.interface || 'N/A';

          // NeDi usa ifstat come BITMASK: bit0=admin, bit1=oper
          // ifstat=3 (0b11) = admin UP + oper UP
          // ifstat=1 (0b01) = admin UP, oper DOWN
          // ifstat=2 (0b10) = admin DOWN, oper UP
          // ifstat=0 (0b00) = entrambi DOWN
          const ifstat = port.ifoperstatus || 0;
          const adminUp = (ifstat & 1) !== 0;
          const operUp = (ifstat & 2) !== 0;

          let statusLabel = 'unknown';
          let statusClass = 'disabled';

          if (adminUp && operUp) {
            statusLabel = 'up';
            statusClass = 'up';
          } else if (adminUp && !operUp) {
            statusLabel = 'down';
            statusClass = 'down';
          } else if (!adminUp && operUp) {
            statusLabel = 'admin-off';
            statusClass = 'disabled';
          } else {
            statusLabel = 'disabled';
            statusClass = 'disabled';
          }

          // Formatta velocità in Bps (NeDi usa Bps)
          const speed = port.ifspeed ? formatSpeed(Math.round(port.ifspeed / 1000000)) : 'N/A';

          // Descrizione porta (NeDi usa ifdescr)
          const description = port.ifdescr || port.description || port.ifalias || port.alias || '-';

          // VLAN (NeDi usa pvid)
          const vlan = port.pvid || port.vlan || '-';

          return `
            <tr>
              <td class="truncate" style="max-width: 100px;" title="${escapeHtml(portName)}">
                ${escapeHtml(shortPortName(portName))}
              </td>
              <td>
                <span class="port-status ${statusClass}"></span>
                ${statusLabel}
              </td>
              <td>
                ${speed}
              </td>
              <td>
                ${vlan}
              </td>
              <td class="truncate" style="max-width: 120px;" title="${escapeHtml(description)}">
                ${escapeHtml(description)}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = statsHtml + tableHtml;
}

/**
 * Render del tab Neighbors
 * @param {Object} data - Dati del device
 */
function renderNeighborsTab(data) {
  const container = document.getElementById('tabNeighbors');
  console.log('[DevicePanel] renderNeighborsTab chiamato con data:', data);
  console.log('[DevicePanel] data.neighbors:', data?.neighbors);
  console.log('[DevicePanel] data.connections:', data?.connections);

  const neighbors = data.neighbors || data.connections || [];
  console.log('[DevicePanel] neighbors array finale:', neighbors.length, 'elementi');

  if (!neighbors || neighbors.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <p>No neighbor connections found</p>
      </div>
    `;
    return;
  }

  const tableHtml = `
    <div class="info-section mb-12">
      <div style="text-align: center;">
        <div style="font-size: 24px; font-weight: bold; color: #60a5fa;">${neighbors.length}</div>
        <div style="font-size: 11px; color: #6b7280;">CONNECTED DEVICES</div>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>Local Port</th>
          <th>Remote Device</th>
          <th>Remote Port</th>
          <th>Protocol</th>
        </tr>
      </thead>
      <tbody>
        ${neighbors.map(neighbor => {
          // NeDi usa local_interface, remote_device, remote_interface, protocol
          const localPort = neighbor.local_interface || neighbor.local_port || neighbor.di || 'N/A';
          const remoteDevice = neighbor.remote_device || neighbor.neighbor || 'N/A';
          const remotePort = neighbor.remote_interface || neighbor.remote_port || neighbor.ni || 'N/A';
          const protocol = neighbor.protocol || 'LLDP';

          return `
            <tr>
              <td class="truncate" style="max-width: 90px;" title="${escapeHtml(localPort)}">
                ${escapeHtml(shortPortName(localPort))}
              </td>
              <td class="truncate" style="max-width: 120px;" title="${escapeHtml(remoteDevice)}">
                <strong>${escapeHtml(remoteDevice)}</strong>
              </td>
              <td class="truncate" style="max-width: 90px;" title="${escapeHtml(remotePort)}">
                ${escapeHtml(shortPortName(remotePort))}
              </td>
              <td>
                <span style="font-size: 10px; color: #60a5fa; font-weight: 600;">
                  ${escapeHtml(protocol.toUpperCase())}
                </span>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = tableHtml;
}

/**
 * Mostra stato di loading con skeleton loaders
 */
function showLoadingState() {
  // Overview tab - show skeleton info sections
  const overviewContainer = document.getElementById('tabOverview');
  if (overviewContainer && window.SkeletonLoader) {
    overviewContainer.innerHTML = SkeletonLoader.generateOverviewSkeleton();
  } else if (overviewContainer) {
    // Fallback to spinner if SkeletonLoader not available
    overviewContainer.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading device information...</p>
      </div>
    `;
  }

  // Ports tab - show skeleton table
  const portsContainer = document.getElementById('tabPorts');
  if (portsContainer && window.SkeletonLoader) {
    portsContainer.innerHTML = SkeletonLoader.generatePortsSkeleton(5);
  } else if (portsContainer) {
    // Fallback to spinner if SkeletonLoader not available
    portsContainer.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading ports information...</p>
      </div>
    `;
  }

  // Neighbors tab - show skeleton table
  const neighborsContainer = document.getElementById('tabNeighbors');
  if (neighborsContainer && window.SkeletonLoader) {
    neighborsContainer.innerHTML = SkeletonLoader.generateNeighborsSkeleton(5);
  } else if (neighborsContainer) {
    // Fallback to spinner if SkeletonLoader not available
    neighborsContainer.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading neighbors information...</p>
      </div>
    `;
  }
}

/**
 * Mostra stato di errore
 * @param {string} message - Messaggio di errore
 */
function showErrorState(message) {
  const container = document.getElementById(`tab${capitalize(DevicePanel.currentTab)}`);
  if (container) {
    container.innerHTML = `
      <div class="error-state">
        <strong>Error loading device data</strong><br>
        ${escapeHtml(message)}
      </div>
    `;
  }
}

/**
 * Aggiorna il timestamp del footer
 */
function updateTimestamp() {
  const timestampEl = document.getElementById('panelTimestamp');
  if (timestampEl) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('it-IT', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    timestampEl.textContent = `Updated: ${timeStr}`;
  }
}

// ========== UTILITY FUNCTIONS ==========

/**
 * Escape HTML per prevenire XSS
 * @param {string} str - Stringa da escapare
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Capitalizza prima lettera
 * @param {string} str - Stringa da capitalizzare
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Formatta uptime in formato leggibile
 * @param {number|string} uptime - Uptime in secondi o stringa
 * @returns {string}
 */
function formatUptime(uptime) {
  if (!uptime && uptime !== 0) return 'N/A';

  // Se è già una stringa formattata, ritornala
  if (typeof uptime === 'string' && uptime.includes('d')) return uptime;

  const seconds = parseInt(uptime);
  if (isNaN(seconds)) return 'N/A';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(' ');
}

/**
 * Formatta velocità in formato leggibile
 * @param {number|string} speed - Velocità in Mbps
 * @returns {string}
 */
function formatSpeed(speed) {
  if (!speed && speed !== 0) return null;

  const speedNum = parseInt(speed);
  if (isNaN(speedNum)) return null;

  if (speedNum >= 1000) {
    return `${speedNum / 1000}G`;
  }
  return `${speedNum}M`;
}

/**
 * Abbrevia nome porta (come nel file principale)
 * @param {string} name - Nome porta completo
 * @returns {string}
 */
function shortPortName(name) {
  if (!name || typeof name !== 'string') return '';

  return name
    .replace(/^GigabitEthernet/i, 'Gi')
    .replace(/^FastEthernet/i, 'Fa')
    .replace(/^TenGigabitEthernet/i, 'Te')
    .replace(/^TwentyFiveGigE/i, '25Gi')
    .replace(/^FortyGigabitEthernet/i, '40Gi')
    .replace(/^HundredGigE/i, '100Gi')
    .replace(/^Ethernet/i, 'Et')
    .replace(/^XGigabitEthernet/i, 'XGi')
    .replace(/^GE/i, 'Gi')
    .replace(/^XGE/i, 'XGi')
    .replace(/^MEth/i, 'MEth')
    .replace(/^Vlanif/i, 'Vlan');
}

// ========== INITIALIZATION ==========

/**
 * Check if the device panel is currently open
 * @returns {boolean} - True if panel is open
 */
function isDevicePanelOpen() {
  return DevicePanel.isOpen;
}

/**
 * Inizializza event listeners per il panel
 */
function initDevicePanel() {
  // Tab switching
  document.querySelectorAll('.panel-tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      switchTab(tabName);

      // Re-render se ci sono dati cached
      if (DevicePanel.cachedData) {
        renderActiveTab(DevicePanel.cachedData);
      }
    });
  });

  // Register Escape key with KeyboardShortcuts module if available
  // This allows coordinated handling with other Escape actions (help modal, etc.)
  if (window.KeyboardShortcuts && typeof window.KeyboardShortcuts.register === 'function') {
    window.KeyboardShortcuts.register('Escape', () => {
      if (DevicePanel.isOpen) {
        closeDevicePanel();
      }
    }, {
      description: 'Close device panel',
      category: 'Panel',
      allowInInput: true,
      preventDefault: false // Allow other Escape handlers to run
    });
  } else {
    // Fallback: use native event listener if KeyboardShortcuts not available
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && DevicePanel.isOpen) {
        closeDevicePanel();
      }
    });
  }

  console.log('[DevicePanel] Initialized');
}

// Inizializza quando il DOM è pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDevicePanel);
} else {
  initDevicePanel();
}

// Esporta funzioni globali
window.openDevicePanel = openDevicePanel;
window.closeDevicePanel = closeDevicePanel;
window.refreshDevicePanel = refreshDevicePanel;
window.isDevicePanelOpen = isDevicePanelOpen;
