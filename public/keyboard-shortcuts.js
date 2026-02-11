/**
 * Keyboard Shortcuts Module
 *
 * Centralized keyboard shortcut management for NetMap application.
 * Handles registration, conflict prevention with input fields, and visual hints.
 */

(function() {
  'use strict';

  // ========== STATE ==========
  const KeyboardShortcuts = {
    shortcuts: new Map(),
    enabled: true,
    helpModalVisible: false
  };

  // ========== CONFIGURATION ==========
  const CONFIG = {
    // Elements that should block shortcuts when focused
    inputSelectors: [
      'input',
      'textarea',
      'select',
      '[contenteditable="true"]'
    ],
    // Modifier key names for display
    modifierNames: {
      ctrl: navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl',
      alt: 'Alt',
      shift: 'Shift',
      meta: 'Meta'
    }
  };

  // ========== UTILITY FUNCTIONS ==========

  /**
   * Check if an element is an input that should block shortcuts
   * @param {Element} element - DOM element to check
   * @returns {boolean}
   */
  function isInputElement(element) {
    if (!element) return false;

    const tagName = element.tagName.toLowerCase();

    // Check tag name
    if (['input', 'textarea', 'select'].includes(tagName)) {
      return true;
    }

    // Check contenteditable
    if (element.isContentEditable) {
      return true;
    }

    return false;
  }

  /**
   * Normalize key string for consistent comparison
   * @param {string} key - Key to normalize
   * @returns {string}
   */
  function normalizeKey(key) {
    if (!key) return '';

    const normalized = key.toLowerCase().trim();

    // Handle special key names
    const keyMap = {
      'escape': 'escape',
      'esc': 'escape',
      'enter': 'enter',
      'return': 'enter',
      'space': ' ',
      'spacebar': ' ',
      'plus': '+',
      'minus': '-',
      'slash': '/',
      'question': '?',
      'questionmark': '?'
    };

    return keyMap[normalized] || normalized;
  }

  /**
   * Parse shortcut string into components
   * @param {string} shortcut - Shortcut string (e.g., "Ctrl+K", "Escape", "1")
   * @returns {Object} - Parsed shortcut object
   */
  function parseShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== 'string') {
      return null;
    }

    const parts = shortcut.toLowerCase().split('+').map(p => p.trim());

    const result = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      key: ''
    };

    parts.forEach(part => {
      switch (part) {
        case 'ctrl':
        case 'control':
          result.ctrl = true;
          break;
        case 'alt':
        case 'option':
          result.alt = true;
          break;
        case 'shift':
          result.shift = true;
          break;
        case 'meta':
        case 'cmd':
        case 'command':
          result.meta = true;
          break;
        default:
          result.key = normalizeKey(part);
      }
    });

    return result;
  }

  /**
   * Check if keyboard event matches a parsed shortcut
   * @param {KeyboardEvent} event - Keyboard event
   * @param {Object} parsed - Parsed shortcut object
   * @returns {boolean}
   */
  function eventMatchesShortcut(event, parsed) {
    if (!parsed || !parsed.key) return false;

    // Check modifier keys
    if (parsed.ctrl !== event.ctrlKey) return false;
    if (parsed.alt !== event.altKey) return false;
    if (parsed.shift !== event.shiftKey) return false;
    if (parsed.meta !== event.metaKey) return false;

    // Check the main key
    const eventKey = normalizeKey(event.key);

    return eventKey === parsed.key;
  }

  /**
   * Generate unique ID for a shortcut
   * @param {Object} parsed - Parsed shortcut object
   * @returns {string}
   */
  function getShortcutId(parsed) {
    const parts = [];
    if (parsed.ctrl) parts.push('ctrl');
    if (parsed.alt) parts.push('alt');
    if (parsed.shift) parts.push('shift');
    if (parsed.meta) parts.push('meta');
    parts.push(parsed.key);
    return parts.join('+');
  }

  /**
   * Format shortcut for display
   * @param {string} shortcut - Shortcut string
   * @returns {string}
   */
  function formatShortcutForDisplay(shortcut) {
    if (!shortcut) return '';

    const parsed = parseShortcut(shortcut);
    if (!parsed) return shortcut;

    const parts = [];
    if (parsed.ctrl) parts.push(CONFIG.modifierNames.ctrl);
    if (parsed.alt) parts.push(CONFIG.modifierNames.alt);
    if (parsed.shift) parts.push(CONFIG.modifierNames.shift);
    if (parsed.meta) parts.push(CONFIG.modifierNames.meta);

    // Format key for display
    let keyDisplay = parsed.key.toUpperCase();
    if (parsed.key === 'escape') keyDisplay = 'Esc';
    if (parsed.key === 'enter') keyDisplay = 'Enter';
    if (parsed.key === ' ') keyDisplay = 'Space';
    if (parsed.key === '/') keyDisplay = '/';
    if (parsed.key === '?') keyDisplay = '?';

    parts.push(keyDisplay);

    return parts.join('+');
  }

  // ========== CORE FUNCTIONS ==========

  /**
   * Register a keyboard shortcut
   * @param {string} shortcut - Shortcut string (e.g., "Ctrl+K", "1", "Escape")
   * @param {Function} callback - Function to call when shortcut is triggered
   * @param {Object} options - Options for the shortcut
   * @param {string} options.description - Human-readable description
   * @param {string} options.category - Category for grouping in help modal
   * @param {boolean} options.allowInInput - Allow shortcut even when input is focused
   * @param {boolean} options.preventDefault - Prevent default browser behavior
   * @returns {boolean} - True if registration successful
   */
  function register(shortcut, callback, options = {}) {
    if (!shortcut || typeof callback !== 'function') {
      console.warn('[KeyboardShortcuts] Invalid shortcut or callback');
      return false;
    }

    const parsed = parseShortcut(shortcut);
    if (!parsed || !parsed.key) {
      console.warn('[KeyboardShortcuts] Could not parse shortcut:', shortcut);
      return false;
    }

    const id = getShortcutId(parsed);

    // Check for existing shortcut
    if (KeyboardShortcuts.shortcuts.has(id)) {
      console.warn('[KeyboardShortcuts] Shortcut already registered:', shortcut);
    }

    KeyboardShortcuts.shortcuts.set(id, {
      shortcut: shortcut,
      parsed: parsed,
      callback: callback,
      description: options.description || '',
      category: options.category || 'General',
      allowInInput: options.allowInInput || false,
      preventDefault: options.preventDefault !== false
    });

    return true;
  }

  /**
   * Unregister a keyboard shortcut
   * @param {string} shortcut - Shortcut string to unregister
   * @returns {boolean} - True if unregistration successful
   */
  function unregister(shortcut) {
    const parsed = parseShortcut(shortcut);
    if (!parsed) return false;

    const id = getShortcutId(parsed);
    return KeyboardShortcuts.shortcuts.delete(id);
  }

  /**
   * Unregister all shortcuts in a category
   * @param {string} category - Category to unregister
   * @returns {number} - Number of shortcuts removed
   */
  function unregisterCategory(category) {
    let count = 0;

    KeyboardShortcuts.shortcuts.forEach((value, key) => {
      if (value.category === category) {
        KeyboardShortcuts.shortcuts.delete(key);
        count++;
      }
    });

    return count;
  }

  /**
   * Clear all registered shortcuts
   */
  function clearAll() {
    KeyboardShortcuts.shortcuts.clear();
  }

  /**
   * Enable or disable all shortcuts
   * @param {boolean} enabled - Whether shortcuts should be enabled
   */
  function setEnabled(enabled) {
    KeyboardShortcuts.enabled = enabled;
  }

  /**
   * Check if shortcuts are enabled
   * @returns {boolean}
   */
  function isEnabled() {
    return KeyboardShortcuts.enabled;
  }

  /**
   * Get all registered shortcuts
   * @returns {Array} - Array of shortcut objects
   */
  function getAll() {
    const shortcuts = [];

    KeyboardShortcuts.shortcuts.forEach(value => {
      shortcuts.push({
        shortcut: value.shortcut,
        description: value.description,
        category: value.category,
        displayText: formatShortcutForDisplay(value.shortcut)
      });
    });

    return shortcuts;
  }

  /**
   * Get shortcuts grouped by category
   * @returns {Object} - Object with categories as keys
   */
  function getByCategory() {
    const categories = {};

    KeyboardShortcuts.shortcuts.forEach(value => {
      const category = value.category || 'General';

      if (!categories[category]) {
        categories[category] = [];
      }

      categories[category].push({
        shortcut: value.shortcut,
        description: value.description,
        displayText: formatShortcutForDisplay(value.shortcut)
      });
    });

    return categories;
  }

  // ========== EVENT HANDLER ==========

  /**
   * Main keyboard event handler
   * @param {KeyboardEvent} event - Keyboard event
   */
  function handleKeyDown(event) {
    // Skip if shortcuts are disabled
    if (!KeyboardShortcuts.enabled) return;

    // Check each registered shortcut
    KeyboardShortcuts.shortcuts.forEach(shortcutData => {
      if (eventMatchesShortcut(event, shortcutData.parsed)) {
        // Check if we should skip due to input focus
        if (!shortcutData.allowInInput && isInputElement(document.activeElement)) {
          return;
        }

        // Prevent default if configured
        if (shortcutData.preventDefault) {
          event.preventDefault();
          event.stopPropagation();
        }

        // Execute callback
        try {
          shortcutData.callback(event);
        } catch (error) {
          console.error('[KeyboardShortcuts] Error in callback:', error);
        }
      }
    });
  }

  // ========== HELP MODAL ==========

  /**
   * Create and show the keyboard shortcuts help modal
   */
  function showHelpModal() {
    // Remove existing modal if present
    hideHelpModal();

    const categories = getByCategory();

    // Build modal HTML
    let categoriesHtml = '';

    Object.keys(categories).sort().forEach(category => {
      const shortcuts = categories[category];

      let shortcutsHtml = shortcuts.map(s => `
        <div class="shortcut-item">
          <span class="shortcut-description">${escapeHtml(s.description)}</span>
          <kbd class="shortcut-key">${escapeHtml(s.displayText)}</kbd>
        </div>
      `).join('');

      categoriesHtml += `
        <div class="shortcut-category">
          <h4 class="shortcut-category-title">${escapeHtml(category)}</h4>
          <div class="shortcut-list">
            ${shortcutsHtml}
          </div>
        </div>
      `;
    });

    const modalHtml = `
      <div class="keyboard-shortcuts-modal" id="keyboardShortcutsModal">
        <div class="keyboard-shortcuts-backdrop"></div>
        <div class="keyboard-shortcuts-content">
          <div class="keyboard-shortcuts-header">
            <h3>Keyboard Shortcuts</h3>
            <button class="keyboard-shortcuts-close" aria-label="Close">&times;</button>
          </div>
          <div class="keyboard-shortcuts-body">
            ${categoriesHtml || '<p class="no-shortcuts">No shortcuts registered</p>'}
          </div>
          <div class="keyboard-shortcuts-footer">
            <span class="keyboard-shortcuts-hint">Press <kbd>Esc</kbd> or <kbd>?</kbd> to close</span>
          </div>
        </div>
      </div>
    `;

    // Insert modal into DOM
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Add event listeners
    const modal = document.getElementById('keyboardShortcutsModal');
    const backdrop = modal.querySelector('.keyboard-shortcuts-backdrop');
    const closeBtn = modal.querySelector('.keyboard-shortcuts-close');

    backdrop.addEventListener('click', hideHelpModal);
    closeBtn.addEventListener('click', hideHelpModal);

    // Show modal with animation
    requestAnimationFrame(() => {
      modal.classList.add('visible');
    });

    KeyboardShortcuts.helpModalVisible = true;
  }

  /**
   * Hide the keyboard shortcuts help modal
   */
  function hideHelpModal() {
    const modal = document.getElementById('keyboardShortcutsModal');

    if (modal) {
      modal.classList.remove('visible');

      // Remove after animation
      setTimeout(() => {
        modal.remove();
      }, 200);
    }

    KeyboardShortcuts.helpModalVisible = false;
  }

  /**
   * Toggle the help modal
   */
  function toggleHelpModal() {
    if (KeyboardShortcuts.helpModalVisible) {
      hideHelpModal();
    } else {
      showHelpModal();
    }
  }

  /**
   * Check if help modal is visible
   * @returns {boolean}
   */
  function isHelpModalVisible() {
    return KeyboardShortcuts.helpModalVisible;
  }

  // ========== VISUAL HINTS ==========

  /**
   * Create a kbd element for displaying a shortcut
   * @param {string} shortcut - Shortcut string
   * @returns {HTMLElement}
   */
  function createKbdElement(shortcut) {
    const kbd = document.createElement('kbd');
    kbd.className = 'keyboard-shortcut-hint';
    kbd.textContent = formatShortcutForDisplay(shortcut);
    return kbd;
  }

  /**
   * Add shortcut hint to an element
   * @param {Element|string} element - Element or selector
   * @param {string} shortcut - Shortcut string
   */
  function addHintToElement(element, shortcut) {
    const el = typeof element === 'string'
      ? document.querySelector(element)
      : element;

    if (!el) return;

    const kbd = createKbdElement(shortcut);
    el.appendChild(kbd);
  }

  // ========== TOAST NOTIFICATIONS ==========

  /**
   * Show a toast notification for shortcut feedback
   * @param {string} message - Message to display
   * @param {string} type - Type of toast ('info', 'success', 'warning', 'error')
   * @param {number} duration - Duration in ms (default: 2000)
   */
  function showToast(message, type = 'info', duration = 2000) {
    // Find or create toast container
    let container = document.querySelector('.keyboard-shortcut-toast-container');

    if (!container) {
      container = document.createElement('div');
      container.className = 'keyboard-shortcut-toast-container';
      document.body.appendChild(container);
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `keyboard-shortcut-toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Show with animation
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    // Auto-hide
    setTimeout(() => {
      toast.classList.remove('visible');

      setTimeout(() => {
        toast.remove();

        // Remove container if empty
        if (container.children.length === 0) {
          container.remove();
        }
      }, 200);
    }, duration);
  }

  // ========== UTILITY ==========

  /**
   * Escape HTML for safe rendering
   * @param {string} str - String to escape
   * @returns {string}
   */
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========== INITIALIZATION ==========

  /**
   * Initialize the keyboard shortcuts system
   */
  function init() {
    // Add global keydown listener
    document.addEventListener('keydown', handleKeyDown);

    // Register ? shortcut for help modal
    register('?', toggleHelpModal, {
      description: 'Show keyboard shortcuts help',
      category: 'Help',
      preventDefault: true
    });

    // Register Escape to close help modal
    register('Escape', () => {
      if (KeyboardShortcuts.helpModalVisible) {
        hideHelpModal();
      }
    }, {
      description: 'Close modal/panel',
      category: 'General',
      allowInInput: true,
      preventDefault: false // Don't prevent default for Escape, let other handlers run too
    });
  }

  /**
   * Cleanup the keyboard shortcuts system
   */
  function cleanup() {
    document.removeEventListener('keydown', handleKeyDown);
    clearAll();
    hideHelpModal();
  }

  // ========== AUTO-INIT ==========

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ========== EXPORTS ==========

  // Export API
  window.KeyboardShortcuts = {
    // Core functions
    register: register,
    unregister: unregister,
    unregisterCategory: unregisterCategory,
    clearAll: clearAll,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    getAll: getAll,
    getByCategory: getByCategory,

    // Help modal
    showHelpModal: showHelpModal,
    hideHelpModal: hideHelpModal,
    toggleHelpModal: toggleHelpModal,
    isHelpModalVisible: isHelpModalVisible,

    // Visual helpers
    createKbdElement: createKbdElement,
    addHintToElement: addHintToElement,
    formatShortcut: formatShortcutForDisplay,

    // Notifications
    showToast: showToast,

    // Lifecycle
    init: init,
    cleanup: cleanup
  };

})();
