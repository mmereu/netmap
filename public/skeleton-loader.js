/**
 * Skeleton Loader Utilities - Reusable Loading State Generators
 *
 * Provides JavaScript utility functions for generating skeleton table HTML
 * with configurable rows and columns. Designed to work with skeleton-loader.css.
 *
 * Usage:
 *   - Include skeleton-loader.css in your HTML
 *   - Include this script before using the functions
 *   - Call SkeletonLoader.generateTableSkeleton(rows, columns) to generate a full table
 *   - Call SkeletonLoader.generateRowSkeleton(columns) for individual rows
 *
 * Example:
 *   const skeleton = SkeletonLoader.generateTableSkeleton(5, 'devices');
 *   document.getElementById('tableBody').innerHTML = skeleton;
 */

(function() {
  'use strict';

  /**
   * Column patterns for different table types
   * Each pattern defines the CSS class suffix for skeleton-cell-* classes
   * Available widths: 'short', 'medium', 'long', 'full', 'action', 'badge', 'vendor'
   */
  const COLUMN_PATTERNS = {
    // Discovery devices table (7 columns): Name, IP, Vendor, Model, Location, Status, Actions
    devices: [
      { width: 'long' },    // Name
      { width: 'medium' },  // IP
      { width: 'medium' },  // Vendor
      { width: 'medium' },  // Model
      { width: 'long' },    // Location
      { width: 'badge' },   // Status (badge style)
      { width: 'action' }   // Actions (button style)
    ],

    // Device panel ports table (5 columns): Port, Status, Speed, VLAN, Description
    ports: [
      { width: 'short' },   // Port
      { width: 'badge' },   // Status
      { width: 'short' },   // Speed
      { width: 'short' },   // VLAN
      { width: 'long' }     // Description
    ],

    // Device panel neighbors table (4 columns): Local Port, Remote Device, Remote Port, Link Type
    neighbors: [
      { width: 'short' },   // Local Port
      { width: 'long' },    // Remote Device
      { width: 'short' },   // Remote Port
      { width: 'medium' }   // Link Type
    ],

    // Port view table (9 columns): Index, Nome, Descrizione, Stato, Velocita, VLAN, MAC, STP, PoE
    portview: [
      { width: 'short' },   // Index
      { width: 'medium' },  // Nome
      { width: 'long' },    // Descrizione
      { width: 'badge' },   // Stato
      { width: 'short' },   // Velocita
      { width: 'short' },   // VLAN
      { width: 'medium' },  // MAC
      { width: 'short' },   // STP
      { width: 'short' }    // PoE
    ],

    // Generic patterns for custom tables
    generic3: [
      { width: 'medium' },
      { width: 'long' },
      { width: 'medium' }
    ],
    generic4: [
      { width: 'medium' },
      { width: 'long' },
      { width: 'medium' },
      { width: 'short' }
    ],
    generic5: [
      { width: 'medium' },
      { width: 'long' },
      { width: 'medium' },
      { width: 'short' },
      { width: 'short' }
    ]
  };

  /**
   * Generates a single skeleton cell HTML
   * @param {Object|string} column - Column definition object or width string
   * @returns {string} HTML string for the skeleton cell
   */
  function generateCell(column) {
    const width = typeof column === 'string' ? column : column.width;

    // Handle special cell types
    if (width === 'badge') {
      return '<td><span class="skeleton skeleton-cell skeleton-badge"></span></td>';
    }
    if (width === 'vendor') {
      return '<td><span class="skeleton skeleton-cell skeleton-vendor"></span></td>';
    }
    if (width === 'action') {
      return '<td><span class="skeleton skeleton-cell skeleton-cell-action"></span></td>';
    }

    // Standard width cells
    const widthClass = `skeleton-cell-${width}`;
    return `<td><span class="skeleton skeleton-cell ${widthClass}"></span></td>`;
  }

  /**
   * Generates a single skeleton row HTML
   * @param {Array|string|number} columns - Column pattern array, table type string, or number of columns
   * @param {string} rowClass - Optional additional CSS class for the row
   * @returns {string} HTML string for the skeleton row
   */
  function generateRowSkeleton(columns, rowClass = '') {
    let columnPattern;

    // Determine column pattern based on input type
    if (typeof columns === 'string') {
      // Table type string (e.g., 'devices', 'ports')
      columnPattern = COLUMN_PATTERNS[columns];
      if (!columnPattern) {
        // Fallback to generic pattern if type not found
        columnPattern = COLUMN_PATTERNS.generic5;
      }
      // Add table-specific row class
      rowClass = `skeleton-${columns}-row ${rowClass}`.trim();
    } else if (typeof columns === 'number') {
      // Number of columns - generate generic columns
      columnPattern = Array(columns).fill({ width: 'medium' });
    } else if (Array.isArray(columns)) {
      // Direct column pattern array
      columnPattern = columns;
    } else {
      // Default fallback
      columnPattern = COLUMN_PATTERNS.generic5;
    }

    // Generate cells HTML
    const cellsHtml = columnPattern.map(col => generateCell(col)).join('');

    // Build row with appropriate class
    const baseClass = 'skeleton-row';
    const fullClass = rowClass ? `${baseClass} ${rowClass}` : baseClass;

    return `<tr class="${fullClass}">${cellsHtml}</tr>`;
  }

  /**
   * Generates multiple skeleton rows (table body content)
   * @param {number} rowCount - Number of rows to generate
   * @param {Array|string|number} columns - Column pattern array, table type string, or number of columns
   * @returns {string} HTML string for all skeleton rows
   */
  function generateTableSkeleton(rowCount, columns) {
    if (rowCount <= 0) {
      return '';
    }

    // Determine row class based on column type
    let rowClass = '';
    if (typeof columns === 'string' && COLUMN_PATTERNS[columns]) {
      rowClass = `skeleton-${columns}-row`;
    }

    // Generate all rows
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(generateRowSkeleton(columns, rowClass));
    }

    return rows.join('\n');
  }

  /**
   * Generates a full skeleton table with table element wrapper
   * @param {number} rowCount - Number of rows to generate
   * @param {Array|string|number} columns - Column pattern array, table type string, or number of columns
   * @param {string} tableClass - Optional additional CSS class for the table
   * @returns {string} HTML string for the complete skeleton table
   */
  function generateFullTable(rowCount, columns, tableClass = '') {
    const rowsHtml = generateTableSkeleton(rowCount, columns);
    const fullClass = `skeleton-table ${tableClass}`.trim();

    return `<table class="${fullClass}">
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>`;
  }

  /**
   * Generates skeleton info rows for device panel overview tab
   * @param {number} rowCount - Number of info rows to generate
   * @returns {string} HTML string for skeleton info rows
   */
  function generateInfoRowsSkeleton(rowCount) {
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push(`
        <div class="skeleton-info-row">
          <span class="skeleton skeleton-info-label"></span>
          <span class="skeleton skeleton-info-value"></span>
        </div>
      `);
    }
    return rows.join('');
  }

  /**
   * Generates a skeleton info section (for device panel)
   * @param {number} rowCount - Number of info rows in the section
   * @returns {string} HTML string for the skeleton section
   */
  function generateInfoSectionSkeleton(rowCount) {
    return `
      <div class="skeleton-section">
        <div class="skeleton skeleton-section-title"></div>
        ${generateInfoRowsSkeleton(rowCount)}
      </div>
    `;
  }

  /**
   * Generates the full overview tab skeleton for device panel
   * @returns {string} HTML string for the overview skeleton
   */
  function generateOverviewSkeleton() {
    return `
      <div class="skeleton-loading">
        ${generateInfoSectionSkeleton(4)}
        ${generateInfoSectionSkeleton(4)}
        ${generateInfoSectionSkeleton(4)}
      </div>
    `;
  }

  /**
   * Generates the ports tab skeleton for device panel
   * @param {number} rowCount - Number of port rows (default: 5)
   * @returns {string} HTML string for the ports skeleton
   */
  function generatePortsSkeleton(rowCount = 5) {
    // Stats section skeleton
    const statsHtml = `
      <div class="skeleton-section" style="margin-bottom: 12px;">
        <div style="display: flex; justify-content: space-around; text-align: center;">
          <div>
            <div class="skeleton skeleton-cell" style="width: 40px; height: 24px; margin: 0 auto 4px;"></div>
            <div class="skeleton skeleton-cell" style="width: 30px; height: 12px; margin: 0 auto;"></div>
          </div>
          <div>
            <div class="skeleton skeleton-cell" style="width: 40px; height: 24px; margin: 0 auto 4px;"></div>
            <div class="skeleton skeleton-cell" style="width: 40px; height: 12px; margin: 0 auto;"></div>
          </div>
          <div>
            <div class="skeleton skeleton-cell" style="width: 40px; height: 24px; margin: 0 auto 4px;"></div>
            <div class="skeleton skeleton-cell" style="width: 40px; height: 12px; margin: 0 auto;"></div>
          </div>
        </div>
      </div>
    `;

    // Table skeleton
    const tableHtml = generateFullTable(rowCount, 'ports', 'data-table');

    return `
      <div class="skeleton-loading">
        ${statsHtml}
        ${tableHtml}
      </div>
    `;
  }

  /**
   * Generates the neighbors tab skeleton for device panel
   * @param {number} rowCount - Number of neighbor rows (default: 5)
   * @returns {string} HTML string for the neighbors skeleton
   */
  function generateNeighborsSkeleton(rowCount = 5) {
    // Count section skeleton
    const countHtml = `
      <div class="skeleton-section" style="margin-bottom: 12px;">
        <div style="text-align: center;">
          <div class="skeleton skeleton-cell" style="width: 40px; height: 24px; margin: 0 auto 4px;"></div>
          <div class="skeleton skeleton-cell" style="width: 100px; height: 12px; margin: 0 auto;"></div>
        </div>
      </div>
    `;

    // Table skeleton
    const tableHtml = generateFullTable(rowCount, 'neighbors', 'data-table');

    return `
      <div class="skeleton-loading">
        ${countHtml}
        ${tableHtml}
      </div>
    `;
  }

  /**
   * Replaces content with skeleton and returns a function to restore with real content
   * @param {HTMLElement|string} container - Container element or selector
   * @param {string} skeletonHtml - Skeleton HTML to display
   * @returns {Function} Function to call with real content HTML to replace skeleton
   */
  function withSkeleton(container, skeletonHtml) {
    const element = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    if (!element) {
      return () => {};
    }

    // Show skeleton
    element.innerHTML = skeletonHtml;

    // Return function to replace with real content
    return function replaceWithContent(contentHtml) {
      // Add fade-out class to skeleton-loading wrapper if present
      const skeletonWrapper = element.querySelector('.skeleton-loading');
      if (skeletonWrapper) {
        skeletonWrapper.classList.add('fade-out');
        // Wait for animation before replacing
        setTimeout(() => {
          element.innerHTML = contentHtml;
        }, 300);
      } else {
        element.innerHTML = contentHtml;
      }
    };
  }

  /**
   * Gets the column pattern for a table type
   * @param {string} tableType - Table type name
   * @returns {Array|null} Column pattern array or null if not found
   */
  function getColumnPattern(tableType) {
    return COLUMN_PATTERNS[tableType] || null;
  }

  /**
   * Registers a custom column pattern
   * @param {string} name - Pattern name
   * @param {Array} columns - Column definition array
   */
  function registerColumnPattern(name, columns) {
    if (!name || !Array.isArray(columns)) {
      return;
    }
    COLUMN_PATTERNS[name] = columns;
  }

  // Public API
  const SkeletonLoader = {
    // Core generators
    generateTableSkeleton,
    generateRowSkeleton,
    generateFullTable,
    generateCell,

    // Info section generators (for device panel)
    generateInfoRowsSkeleton,
    generateInfoSectionSkeleton,

    // Pre-built tab skeletons (for device panel)
    generateOverviewSkeleton,
    generatePortsSkeleton,
    generateNeighborsSkeleton,

    // Utility functions
    withSkeleton,
    getColumnPattern,
    registerColumnPattern,

    // Column patterns (read-only access)
    patterns: COLUMN_PATTERNS
  };

  // Export to global scope
  window.SkeletonLoader = SkeletonLoader;

})();
