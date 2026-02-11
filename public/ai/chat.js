/**
 * NetMap AI Chat - JavaScript
 * ===========================
 * Logica frontend per chat con AI agent per ricerca MAC address
 */

// ============================================
// STATE
// ============================================
const state = {
  sessionId: null,
  isLoading: false,
  selectedResult: null,
  previewOpen: false
};

// ============================================
// DOM ELEMENTS
// ============================================
const elements = {
  // Header
  btnClearChat: document.getElementById('btn-clear-chat'),
  btnHistory: document.getElementById('btn-history'),
  btnMenu: document.getElementById('btn-menu'),

  // Chat
  messagesContainer: document.getElementById('messages-container'),
  chatInput: document.getElementById('chat-input'),
  btnSend: document.getElementById('btn-send'),
  sessionIndicator: document.getElementById('session-indicator'),

  // Preview Panel
  previewPanel: document.getElementById('preview-panel'),
  panelEmpty: document.getElementById('panel-empty'),
  panelContent: document.getElementById('panel-content'),
  btnClosePanel: document.getElementById('btn-close-panel'),
  btnPreviewToggle: document.getElementById('btn-preview-toggle'),

  // Preview Info
  infoDeviceName: document.getElementById('info-device-name'),
  infoDeviceIp: document.getElementById('info-device-ip'),
  infoDeviceVendor: document.getElementById('info-device-vendor'),
  infoDeviceModel: document.getElementById('info-device-model'),
  infoDeviceStatus: document.getElementById('info-device-status'),
  infoPortName: document.getElementById('info-port-name'),
  infoPortVlan: document.getElementById('info-port-vlan'),
  infoPortSpeed: document.getElementById('info-port-speed'),
  infoPortStatus: document.getElementById('info-port-status'),
  macHistory: document.getElementById('mac-history'),

  // Quick Actions
  actionTopology: document.getElementById('action-topology'),
  actionRefresh: document.getElementById('action-refresh'),
  actionPing: document.getElementById('action-ping'),
  actionCopy: document.getElementById('action-copy'),

  // Toast
  toastContainer: document.getElementById('toast-container')
};

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Init Lucide icons
  lucide.createIcons();

  // Setup event listeners
  setupEventListeners();

  // Focus input
  elements.chatInput.focus();

  // Update session indicator
  updateSessionIndicator();
});

function setupEventListeners() {
  // Input handling
  elements.chatInput.addEventListener('input', handleInputChange);
  elements.chatInput.addEventListener('keydown', handleInputKeydown);
  elements.btnSend.addEventListener('click', handleSend);

  // Header buttons
  elements.btnClearChat.addEventListener('click', handleClearChat);

  // Suggestion chips
  document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const query = chip.dataset.query;
      elements.chatInput.value = query;
      handleInputChange();
      handleSend();
    });
  });

  // Preview panel
  elements.btnClosePanel.addEventListener('click', () => togglePreviewPanel(false));
  elements.btnPreviewToggle.addEventListener('click', () => togglePreviewPanel(true));

  // Quick actions
  elements.actionCopy.addEventListener('click', handleCopyResult);
  elements.actionTopology.addEventListener('click', handleOpenTopology);
  elements.actionRefresh.addEventListener('click', handleRefreshResult);
}

// ============================================
// INPUT HANDLING
// ============================================
function handleInputChange() {
  const hasText = elements.chatInput.value.trim().length > 0;
  elements.btnSend.disabled = !hasText || state.isLoading;
}

function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!elements.btnSend.disabled) {
      handleSend();
    }
  }
}

async function handleSend() {
  const message = elements.chatInput.value.trim();
  if (!message || state.isLoading) return;

  // Add user message
  addMessage(message, 'user');

  // Clear input
  elements.chatInput.value = '';
  handleInputChange();

  // Show typing indicator
  const typingEl = addTypingIndicator();

  // Set loading state
  state.isLoading = true;
  elements.btnSend.disabled = true;

  // Track cleanup state
  let streamCompleted = false;
  let timeoutId = null;
  let controller = null;

  // Cleanup function per garantire pulizia completa
  const cleanup = (reason = 'unknown') => {
    console.log(`[Chat] Cleanup called: ${reason}`);
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (typingEl && document.body.contains(typingEl)) {
      typingEl.remove();
    }
    state.isLoading = false;
    handleInputChange();
  };

  try {
    // Timeout controller (180s = 3 minuti)
    controller = new AbortController();
    timeoutId = setTimeout(() => {
      if (!streamCompleted) {
        controller.abort();
        cleanup('timeout');
        showToast('La richiesta sta impiegando troppo tempo. Riprova o sii più specifico.', 'warning');
        addBotMessage('La richiesta è scaduta dopo 3 minuti. Prova a riformulare la domanda.', 'Sistema');
      }
    }, 180000);

    // Call API Stream Endpoint
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId: state.sessionId
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Read the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // Keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);

            switch (data.type) {
              case 'session':
                if (data.sessionId) {
                  state.sessionId = data.sessionId;
                  updateSessionIndicator();
                }
                break;

              case 'thinking':
              case 'tool_start':
                updateTypingIndicator(typingEl, data.message || 'Elaborazione...');
                break;

              case 'tool_end':
                updateTypingIndicator(typingEl, data.message || 'Analisi...');
                break;

              case 'progress':
                // Handle progress updates from backend
                updateTypingIndicator(typingEl, data.message || 'In corso...');
                break;

              case 'complete':
                streamCompleted = true;
                cleanup('complete');
                addBotMessage(data.response, data.agent);
                break;

              case 'error':
                throw new Error(data.message);

              default:
                // Log unknown event types for debugging
                console.warn(`[Chat] Unknown stream event type: ${data.type}`, data);
                break;
            }
          } catch (e) {
            if (e.message && !e.message.includes('Unexpected')) {
              // Re-throw actual errors, not JSON parse errors
              throw e;
            }
            console.warn('Error parsing stream data:', e, jsonStr);
          }
        }
      }
    }

  } catch (error) {
    console.error('Chat error:', error);
    cleanup('error');

    if (error.name === 'AbortError') {
      // Timeout già gestito, non mostrare altro
      console.log('[Chat] Request aborted (timeout)');
    } else {
      addBotMessage(`Mi dispiace, si è verificato un errore: ${error.message}`, 'Sistema');
      showToast('Errore di comunicazione con il server', 'error');
    }
  } finally {
    // Cleanup finale garantito
    cleanup('finally');
    elements.chatInput.focus();
  }
}

// ============================================
// MESSAGE RENDERING
// ============================================
function addMessage(content, type) {
  const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const messageEl = document.createElement('div');
  messageEl.className = `message ${type}-message`;

  if (type === 'user') {
    messageEl.innerHTML = `
      <div class="message-avatar">
        <i data-lucide="user"></i>
      </div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-sender">Tu</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-body">
          <p>${escapeHtml(content)}</p>
        </div>
      </div>
    `;
  }

  elements.messagesContainer.appendChild(messageEl);
  lucide.createIcons({ nodes: [messageEl] });
  scrollToBottom();

  return messageEl;
}

function addBotMessage(content, agent) {
  const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

  const messageEl = document.createElement('div');
  messageEl.className = 'message bot-message';

  // Parse content for MAC results
  const parsedContent = parseResponseContent(content);

  messageEl.innerHTML = `
    <div class="message-avatar">
      <i data-lucide="bot"></i>
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-sender">${escapeHtml(agent || 'NetMap AI')}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-body">
        ${parsedContent}
      </div>
    </div>
  `;

  elements.messagesContainer.appendChild(messageEl);
  lucide.createIcons({ nodes: [messageEl] });

  // Setup result card interactions
  setupResultCardListeners(messageEl);

  // Auto-select first result card to populate preview panel
  const firstCard = messageEl.querySelector('.result-card');
  if (firstCard && firstCard.dataset.result) {
    try {
      // SECURITY: decodeURIComponent per leggere JSON escaped
      const resultData = JSON.parse(decodeURIComponent(firstCard.dataset.result));
      if (resultData.found || resultData.switchName) {
        selectResult(resultData);
      }
    } catch (e) {
      console.warn('Failed to auto-select result:', e);
      showToast('Errore nel parsing del risultato', 'error');
    }
  }

  scrollToBottom();
  return messageEl;
}

function parseResponseContent(content) {
  // Check if content contains MAC result patterns
  const macRegex = /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/g;
  const macMatches = content.match(macRegex);

  // Simple text response (no structured data)
  if (!macMatches) {
    return `<p>${formatTextWithLineBreaks(content)}</p>`;
  }

  // Try to extract structured data from response
  const result = extractMacResult(content);

  if (result) {
    return `
      <p>${formatTextWithLineBreaks(result.summary)}</p>
      ${createResultCard(result)}
    `;
  }

  // Fallback to formatted text
  return `<p>${formatTextWithLineBreaks(content)}</p>`;
}

function extractMacResult(content) {
  // Rimuovi markdown bold/italic per parsing più pulito
  const cleanContent = content.replace(/\*\*/g, '').replace(/\*/g, '');

  // Pattern matching per estrarre dati strutturati dalla risposta
  // Supporta tutti i formati MAC: aa:bb:cc:dd:ee:ff, aaaa-bbbb-cccc, aabb.ccdd.eeff
  const macPatterns = [
    /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/,       // Standard
    /([0-9a-fA-F]{4}-){2}[0-9a-fA-F]{4}/,           // Huawei
    /([0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}/           // Cisco
  ];

  let mac = null;
  for (const pattern of macPatterns) {
    const match = cleanContent.match(pattern);
    if (match) {
      mac = match[0].toUpperCase().replace(/[-.:]/g, ':');
      // Normalizza a formato standard aa:bb:cc:dd:ee:ff
      if (mac.length === 14) { // aaaa:bbbb:cccc
        mac = mac.replace(/:/g, '').match(/.{2}/g).join(':');
      }
      break;
    }
  }
  if (!mac) return null;

  // Check for "trovato" or "found" - pattern più flessibili
  const found = /trovato|found|locato|presente|connesso/i.test(cleanContent);
  const notFound = /non\s+trovato|not\s+found|non\s+presente|assente|non\s+connesso/i.test(cleanContent);

  // Extract switch/device name - pattern MOLTO più flessibili
  // Accetta: "Switch: X", "Switch X", "switch  X", "Device: X", "su X", "at X"
  const switchPatterns = [
    /Switch\s*[:\s]\s*([A-Za-z0-9_.-]+)/i,
    /Device\s*[:\s]\s*([A-Za-z0-9_.-]+)/i,
    /Dispositivo\s*[:\s]\s*([A-Za-z0-9_.-]+)/i,
    /(?:connesso\s+(?:a|su)|at|on)\s+([A-Za-z0-9_.-]+)/i
  ];
  let switchName = null;
  for (const pattern of switchPatterns) {
    const match = cleanContent.match(pattern);
    if (match) {
      switchName = match[1];
      break;
    }
  }

  // Extract IP - pattern flessibili con spazi opzionali
  const ipPatterns = [
    /IP\s*Switch\s*[:\s]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
    /IP\s*[:\s]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
    /\((\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\)/,
    /indirizzo\s*[:\s]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i
  ];
  let ip = null;
  for (const pattern of ipPatterns) {
    const match = cleanContent.match(pattern);
    if (match) {
      ip = match[1];
      break;
    }
  }

  // Extract port - pattern per tutti i vendor
  // Huawei: 10GE1/0/5, GE1/0/1, XGE1/0/1, Eth-Trunk1
  // Cisco: Gi2/0/7, Fa0/1, Te1/0/1
  // Generic: port1, eth0
  const portPatterns = [
    /Port[ae]?\s*[:\s]\s*([A-Za-z0-9-]+\d+\/\d+(?:\/\d+)?)/i,
    /(10GE\d+\/\d+\/\d+)/i,
    /(XGE\d+\/\d+\/\d+)/i,
    /(GE\d+\/\d+\/\d+)/i,
    /(Gi\d+\/\d+\/\d+)/i,
    /(Fa\d+\/\d+)/i,
    /(Te\d+\/\d+\/\d+)/i,
    /(Eth-?Trunk\d+)/i,
    /interfaccia\s*[:\s]\s*([A-Za-z0-9-\/]+)/i
  ];
  let port = null;
  for (const pattern of portPatterns) {
    const match = cleanContent.match(pattern);
    if (match) {
      port = match[1];
      break;
    }
  }

  // Extract VLAN - accetta spazi multipli
  const vlanMatch = cleanContent.match(/VLAN\s*[:\s]*(\d+)/i);
  const vlan = vlanMatch ? vlanMatch[1] : null;

  // Determine source
  const isFromDb = /database|NeDi|DB|cache/i.test(content);
  const isFromSsh = /SSH|live|real-?time/i.test(content);

  // Build summary (first sentence or paragraph, max 150 chars)
  const summaryMatch = content.match(/^[^.!?\n]*[.!?]/);
  const summary = summaryMatch ? summaryMatch[0].substring(0, 150) : content.substring(0, 100);

  return {
    mac,
    found: found && !notFound,
    notFound: notFound,
    switchName,
    ip,
    port,
    vlan,
    source: {
      db: isFromDb,
      ssh: isFromSsh
    },
    summary,
    rawContent: content
  };
}

function createResultCard(result) {
  const statusClass = result.notFound ? 'not-found' : (result.found ? 'found' : 'in-progress');
  const statusText = result.notFound ? 'NON TROVATO' : (result.found ? 'MAC TROVATO' : 'IN CORSO');
  const statusIcon = result.notFound ? 'x-circle' : (result.found ? 'check-circle' : 'loader');

  const sourceHtml = [];
  if (result.source.db) sourceHtml.push('<span class="source-badge db">DB</span>');
  if (result.source.ssh) sourceHtml.push('<span class="source-badge ssh">SSH</span>');

  const locationHtml = result.switchName ? `
    <div class="location-display">
      <i data-lucide="map-pin"></i>
      <span class="location-switch">${escapeHtml(result.switchName)}</span>
      ${result.ip ? `<span class="location-ip">(${escapeHtml(result.ip)})</span>` : ''}
      ${result.port ? `<span>&rarr;</span><span class="location-port">${escapeHtml(result.port)}</span>` : ''}
      ${result.vlan ? `<span class="location-vlan">VLAN ${escapeHtml(result.vlan)}</span>` : ''}
    </div>
  ` : '';

  // SECURITY: Escape JSON per prevenire HTML injection via data attribute
  // Usa doppio escape: JSON.stringify + encodeURIComponent
  const safeResultJson = encodeURIComponent(JSON.stringify(result));

  return `
    <div class="result-card ${statusClass}" data-result="${safeResultJson}">
      <div class="card-header">
        <div class="card-status ${statusClass}">
          <i data-lucide="${statusIcon}"></i>
          ${statusText}
        </div>
        <div class="card-source">
          ${sourceHtml.join(' + ')}
        </div>
      </div>
      <div class="card-body">
        <div class="mac-display">${escapeHtml(result.mac)}</div>
        ${locationHtml}
      </div>
      <div class="card-actions">
        <div class="action-buttons">
          <button class="card-btn btn-details" title="Dettagli device">
            <i data-lucide="info"></i>
            Dettagli
          </button>
          <button class="card-btn btn-history" title="Storico MAC">
            <i data-lucide="history"></i>
            Storico
          </button>
          <button class="card-btn btn-copy" title="Copia MAC">
            <i data-lucide="copy"></i>
            Copia
          </button>
        </div>
        <button class="expand-btn" title="Espandi dettagli">
          <i data-lucide="chevron-down"></i>
          Espandi
        </button>
      </div>
      <div class="card-expanded">
        <div class="expanded-section">
          <h5>Posizione Attuale</h5>
          <div class="expanded-row">
            <span class="expanded-label">Switch</span>
            <span class="expanded-value">${escapeHtml(result.switchName || '-')}</span>
          </div>
          <div class="expanded-row">
            <span class="expanded-label">IP Switch</span>
            <span class="expanded-value">${escapeHtml(result.ip || '-')}</span>
          </div>
          <div class="expanded-row">
            <span class="expanded-label">Porta</span>
            <span class="expanded-value">${escapeHtml(result.port || '-')}</span>
          </div>
          <div class="expanded-row">
            <span class="expanded-label">VLAN</span>
            <span class="expanded-value">${escapeHtml(result.vlan || '-')}</span>
          </div>
          <div class="expanded-row">
            <span class="expanded-label">Fonte</span>
            <span class="expanded-value">${result.source.db ? 'Database' : ''}${result.source.db && result.source.ssh ? ' + ' : ''}${result.source.ssh ? 'SSH Live' : ''}</span>
          </div>
        </div>
        <div class="expanded-actions">
          <button class="card-btn btn-topology">
            <i data-lucide="globe"></i>
            Apri Topologia
          </button>
          <button class="card-btn btn-refresh">
            <i data-lucide="refresh-cw"></i>
            Refresh Live
          </button>
          <button class="card-btn btn-device-panel">
            <i data-lucide="monitor"></i>
            Device Panel
          </button>
        </div>
      </div>
    </div>
  `;
}

function setupResultCardListeners(messageEl) {
  // Expand/collapse
  messageEl.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.result-card');
      const expanded = card.querySelector('.card-expanded');
      const isExpanded = expanded.classList.contains('visible');

      expanded.classList.toggle('visible');
      btn.classList.toggle('expanded');
      btn.innerHTML = isExpanded
        ? '<i data-lucide="chevron-down"></i> Espandi'
        : '<i data-lucide="chevron-up"></i> Riduci';
      lucide.createIcons({ nodes: [btn] });
    });
  });

  // Helper per parsing sicuro del result data
  const parseResultData = (card) => {
    try {
      return JSON.parse(decodeURIComponent(card.dataset.result));
    } catch (e) {
      console.error('Failed to parse result data:', e);
      showToast('Errore nel parsing dei dati', 'error');
      return null;
    }
  };

  // Details button - open preview panel
  messageEl.querySelectorAll('.btn-details').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.result-card');
      const resultData = parseResultData(card);
      if (resultData) selectResult(resultData);
    });
  });

  // Copy button
  messageEl.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.result-card');
      const resultData = parseResultData(card);
      if (resultData?.mac) {
        copyToClipboard(resultData.mac);
        showToast('MAC copiato negli appunti', 'success');
      }
    });
  });

  // Topology button
  messageEl.querySelectorAll('.btn-topology').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.result-card');
      const resultData = parseResultData(card);
      if (resultData?.switchName) {
        window.open(`/topology-nedi-layer.html?device=${encodeURIComponent(resultData.switchName)}`, '_blank');
      }
    });
  });

  // Device panel button
  messageEl.querySelectorAll('.btn-device-panel').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.result-card');
      const resultData = parseResultData(card);
      if (resultData?.switchName) {
        window.open(`/port-view.html?device=${encodeURIComponent(resultData.switchName)}`, '_blank');
      }
    });
  });
}

function addTypingIndicator() {
  const typingEl = document.createElement('div');
  typingEl.className = 'message bot-message typing-message';
  typingEl.innerHTML = `
    <div class="message-avatar">
      <i data-lucide="bot"></i>
    </div>
    <div class="message-content">
      <div class="message-body">
        <div class="typing-container" style="display: flex; align-items: center; gap: 10px;">
          <div class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </div>
          <span class="typing-text" style="font-size: 0.9em; color: #888;">Analisi richiesta...</span>
        </div>
      </div>
    </div>
  `;

  elements.messagesContainer.appendChild(typingEl);
  lucide.createIcons({ nodes: [typingEl] });
  scrollToBottom();

  return typingEl;
}

function updateTypingIndicator(element, text) {
  if (!element) return;
  const textEl = element.querySelector('.typing-text');
  if (textEl) {
    textEl.textContent = text;
  }
}

// ============================================
// PREVIEW PANEL
// ============================================
function selectResult(result) {
  state.selectedResult = result;

  // Show panel content
  elements.panelEmpty.style.display = 'none';
  elements.panelContent.style.display = 'block';

  // Update device info
  elements.infoDeviceName.textContent = result.switchName || '-';
  elements.infoDeviceIp.textContent = result.ip || '-';
  elements.infoDeviceVendor.textContent = '-'; // TODO: fetch from API
  elements.infoDeviceModel.textContent = '-';
  elements.infoDeviceStatus.textContent = 'Online';
  elements.infoDeviceStatus.className = 'info-value status-badge online';

  // Update port info
  elements.infoPortName.textContent = result.port || '-';
  elements.infoPortVlan.textContent = result.vlan || '-';
  elements.infoPortSpeed.textContent = '-';
  elements.infoPortStatus.textContent = 'Up';
  elements.infoPortStatus.className = 'info-value status-badge online';

  // Clear history
  elements.macHistory.innerHTML = '<div class="history-empty">Caricamento storico...</div>';

  // Enable quick actions
  elements.actionTopology.disabled = !result.switchName;
  elements.actionRefresh.disabled = false;
  elements.actionCopy.disabled = false;

  // Open panel on tablet/mobile
  if (window.innerWidth <= 1200) {
    togglePreviewPanel(true);
  }

  // Fetch additional device details
  if (result.switchName) {
    fetchDeviceDetails(result.switchName);
  }
}

async function fetchDeviceDetails(deviceName) {
  try {
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceName)}/detail`);
    if (!response.ok) return;

    const data = await response.json();

    // Update vendor/model if available
    if (data.device) {
      elements.infoDeviceVendor.textContent = data.device.vendor || '-';
      elements.infoDeviceModel.textContent = data.device.model || '-';
    }

    // Update port details if available
    if (data.interfaces && state.selectedResult?.port) {
      const portInfo = data.interfaces.find(iface =>
        iface.ifname === state.selectedResult.port ||
        iface.ifdescr === state.selectedResult.port
      );
      if (portInfo) {
        elements.infoPortSpeed.textContent = formatSpeed(portInfo.speed);
        elements.infoPortStatus.textContent = portInfo.ifstat === 3 ? 'Up' : 'Down';
        elements.infoPortStatus.className = `info-value status-badge ${portInfo.ifstat === 3 ? 'online' : 'offline'}`;
      }
    }

  } catch (error) {
    console.error('Failed to fetch device details:', error);
  }
}

function togglePreviewPanel(open) {
  state.previewOpen = open;
  elements.previewPanel.classList.toggle('open', open);
}

// ============================================
// QUICK ACTIONS
// ============================================
function handleCopyResult() {
  if (state.selectedResult?.mac) {
    copyToClipboard(state.selectedResult.mac);
    showToast('MAC copiato negli appunti', 'success');
  }
}

function handleOpenTopology() {
  if (state.selectedResult?.switchName) {
    window.open(`/topology-nedi-layer.html?device=${encodeURIComponent(state.selectedResult.switchName)}`, '_blank');
  }
}

async function handleRefreshResult() {
  if (!state.selectedResult?.mac) return;

  showToast('Refresh in corso...', 'warning');

  // Send refresh request to chat
  elements.chatInput.value = `Aggiorna ricerca MAC ${state.selectedResult.mac}`;
  handleSend();
}

// ============================================
// CHAT MANAGEMENT
// ============================================
function handleClearChat() {
  // Clear messages except welcome
  const messages = elements.messagesContainer.querySelectorAll('.message:not(.welcome-message)');
  messages.forEach(msg => msg.remove());

  // Reset session
  state.sessionId = null;
  state.selectedResult = null;
  updateSessionIndicator();

  // Reset preview panel
  elements.panelEmpty.style.display = 'flex';
  elements.panelContent.style.display = 'none';

  // Show toast
  showToast('Nuova conversazione iniziata', 'success');

  // Focus input
  elements.chatInput.focus();
}

function updateSessionIndicator() {
  if (state.sessionId) {
    elements.sessionIndicator.innerHTML = `
      <i data-lucide="circle" class="session-dot"></i>
      Sessione attiva
    `;
  } else {
    elements.sessionIndicator.innerHTML = `
      <i data-lucide="circle" class="session-dot"></i>
      Nuova sessione
    `;
  }
  lucide.createIcons({ nodes: [elements.sessionIndicator] });
}

// ============================================
// UTILITIES
// ============================================
function scrollToBottom() {
  elements.messagesContainer.scrollTo({
    top: elements.messagesContainer.scrollHeight,
    behavior: 'smooth'
  });
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTextWithLineBreaks(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function formatSpeed(speed) {
  if (!speed) return '-';
  if (speed >= 1000000000) return `${speed / 1000000000} Gbps`;
  if (speed >= 1000000) return `${speed / 1000000} Mbps`;
  return `${speed} bps`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(err => {
    console.error('Failed to copy:', err);
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const iconMap = {
    success: 'check-circle',
    error: 'x-circle',
    warning: 'alert-triangle',
    info: 'info'
  };

  toast.innerHTML = `
    <i data-lucide="${iconMap[type]}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  elements.toastContainer.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });

  // Auto remove after 3s
  setTimeout(() => {
    toast.style.animation = 'toastSlideOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
