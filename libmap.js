import fs from 'fs';
import path from 'path';

/**
 * Libreria per generazione mappe avanzate (PNG/SVG/JSON) stile NeDi
 */
class NetMapMap {
  constructor() {
    this.defaultColors = {
      device: { bg: '#1b2b4a', border: '#4b6fff' },
      neighbor: { bg: '#1f6f3f', border: '#44c482' },
      down: { bg: '#4a1b1b', border: '#ff4444' },
    };
  }

  /**
   * Genera JSON per mappa (compatibile D3.js/Vis.js)
   */
  generateJSON(nodes, links, options = {}) {
    const mapData = {
      nodes: nodes.map((node, idx) => ({
        id: node.id || idx,
        label: node.label || node.id,
        sysname: node.sysname || null,
        type: node.type || 'device',
        group: node.type || 'device',
        status: node.status || 'active',
        level: node.level !== undefined ? node.level : 0, // NeDi hierarchical level
        x: node.x || null,
        y: node.y || null,
      })),
      links: links.map((link, idx) => ({
        id: link.id || idx,
        from: link.from || link.source,  // PRIMARIO per frontend
        to: link.to || link.target,      // PRIMARIO per frontend
        source: link.from || link.source, // Per compatibilità D3.js
        target: link.to || link.target,   // Per compatibilità D3.js
        label: link.label || '',
        protocol: link.protocol || 'LLDP',
        di: link.di || link.localIf || null,  // Device Interface (NeDi format)
        ni: link.ni || link.remoteIf || null, // Neighbor Interface (NeDi format)
        localIf: link.localIf || null,        // Mantieni per compatibilità
        remoteIf: link.remoteIf || null,      // Mantieni per compatibilità
        weight: link.weight || 1,
      })),
      metadata: {
        timestamp: new Date().toISOString(),
        nodeCount: nodes.length,
        linkCount: links.length,
        ...options.metadata,
      },
    };

    return mapData;
  }

  /**
   * Genera SVG della mappa
   */
  generateSVG(nodes, links, options = {}) {
    const width = options.width || 1200;
    const height = options.height || 800;
    const padding = options.padding || 50;

    // Calcola bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((node) => {
      if (node.x !== null && node.x !== undefined) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
      }
      if (node.y !== null && node.y !== undefined) {
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
      }
    });

    // Normalizza coordinate se necessario
    if (minX === Infinity) {
      // Layout circolare se non ci sono coordinate
      const radius = Math.min(width, height) / 3;
      const angleStep = (2 * Math.PI) / nodes.length;
      nodes.forEach((node, idx) => {
        node.x = width / 2 + radius * Math.cos(idx * angleStep);
        node.y = height / 2 + radius * Math.sin(idx * angleStep);
      });
    } else {
      // Scale coordinates
      const scaleX = (width - 2 * padding) / (maxX - minX || 1);
      const scaleY = (height - 2 * padding) / (maxY - minY || 1);
      nodes.forEach((node) => {
        if (node.x !== null) node.x = (node.x - minX) * scaleX + padding;
        if (node.y !== null) node.y = (node.y - minY) * scaleY + padding;
      });
    }

    let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      .device { fill: ${this.defaultColors.device.bg}; stroke: ${this.defaultColors.device.border}; stroke-width: 2; }
      .neighbor { fill: ${this.defaultColors.neighbor.bg}; stroke: ${this.defaultColors.neighbor.border}; stroke-width: 2; }
      .down { fill: ${this.defaultColors.down.bg}; stroke: ${this.defaultColors.down.border}; stroke-width: 2; }
      .link { stroke: #4b6fff; stroke-width: 1.5; fill: none; }
      .label { font-family: Arial, sans-serif; font-size: 12px; fill: #e4e7ef; }
      .link-label { font-family: Arial, sans-serif; font-size: 10px; fill: #9fb3ff; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" fill="#0b1021"/>
  <text x="${width / 2}" y="20" text-anchor="middle" class="label" font-size="16" font-weight="bold">${options.title || 'Network Map'}</text>
`;

    // Draw links
    links.forEach((link) => {
      const source = nodes.find((n) => n.id === link.from || n.id === link.source);
      const target = nodes.find((n) => n.id === link.to || n.id === link.target);
      if (source && target && source.x !== null && target.x !== null) {
        svg += `  <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" class="link"/>\n`;
        if (link.label) {
          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          svg += `  <text x="${midX}" y="${midY - 5}" text-anchor="middle" class="link-label">${link.label}</text>\n`;
        }
      }
    });

    // Draw nodes
    nodes.forEach((node) => {
      if (node.x === null || node.y === null) return;
      const statusClass = node.status === 'down' ? 'down' : node.type === 'neighbor' ? 'neighbor' : 'device';
      const nodeSize = options.nodeSize || 20;

      svg += `  <circle cx="${node.x}" cy="${node.y}" r="${nodeSize}" class="${statusClass}"/>\n`;
      if (node.label) {
        const labelY = node.y + nodeSize + 15;
        svg += `  <text x="${node.x}" y="${labelY}" text-anchor="middle" class="label">${this.escapeXML(node.label)}</text>\n`;
      }
    });

    svg += `  <text x="10" y="${height - 10}" class="label" font-size="10">Generated: ${new Date().toISOString()}</text>
</svg>`;

    return svg;
  }

  /**
   * Salva JSON su file
   */
  saveJSON(data, filePath) {
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Salva SVG su file
   */
  saveSVG(svg, filePath) {
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, svg, 'utf8');
  }

  /**
   * Escape XML per SVG
   */
  escapeXML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * CircleCoords stile NeDi - layout circolare con livelli
   */
  circleCoords(centerX, centerY, currentPos, totalNodes, level, baseLength, rotation, option) {
    // Calcola lunghezza in base al livello
    let len = baseLength;
    if (totalNodes < 5) {
      len = baseLength;
      option = 0;
    } else if (level > 0) {
      // Nodo con livello (hub)
      len = (level / 2) * baseLength + (currentPos % 4) * 20;
    } else if (level === 0) {
      // Hub centrale
      len = (totalNodes - currentPos) * baseLength / 10;
    } else {
      // Isolato
      len = baseLength + (currentPos % 4) * 20;
    }

    // Calcola angolo
    const phi = rotation * 0.0174533 + 2 * Math.floor(currentPos + option / 2) * Math.PI / totalNodes;
    const x = Math.floor(centerX + Math.cos(phi) * 1.3 * len);
    const y = Math.floor(centerY + Math.sin(phi) * len);

    return { x, y };
  }

  /**
   * Arrange stile NeDi - organizza nodi in albero gerarchico
   * Rimuove leaf nodes (nodi con 1 solo neighbor) e li raggruppa
   */
  arrangeNodes(nodes, links) {
    // Crea mappa di adiacenza
    const adjacency = new Map();
    const nodeMap = new Map();

    nodes.forEach(node => {
      nodeMap.set(node.id, node);
      adjacency.set(node.id, new Set());
    });

    links.forEach(link => {
      const from = link.from || link.source;
      const to = link.to || link.target;
      if (adjacency.has(from) && adjacency.has(to)) {
        adjacency.get(from).add(to);
        adjacency.get(to).add(from);
      }
    });

    // Identifica leaf nodes (1 solo neighbor)
    const leafNodes = [];
    const coreNodes = [];

    adjacency.forEach((neighbors, nodeId) => {
      if (neighbors.size === 1) {
        leafNodes.push(nodeId);
      } else if (neighbors.size > 1) {
        coreNodes.push(nodeId);
      }
    });

    // Raggruppa leaf nodes con il loro parent
    const leafGroups = new Map();
    leafNodes.forEach(leafId => {
      const parentId = Array.from(adjacency.get(leafId))[0];
      if (!leafGroups.has(parentId)) {
        leafGroups.set(parentId, []);
      }
      leafGroups.get(parentId).push(leafId);
    });

    return {
      coreNodes,
      leafNodes,
      leafGroups,
      adjacency,
      nodeMap,
    };
  }

  /**
   * Layout gerarchico stile NeDi
   */
  hierarchicalLayout(nodes, links, width, height, options = {}) {
    const arranged = this.arrangeNodes(nodes, links);
    const centerX = width / 2;
    const centerY = height / 2;
    const baseLength = options.len || Math.min(width, height) / 4;
    const pwt = options.pwt || 10; // Power/Weight
    const lsf = options.lsf || 5; // Link scale factor

    // Assegna livelli ai core nodes
    const nodeLevels = new Map();

    // BFS per assegnare livelli
    const visited = new Set();
    const queue = [];

    // Inizia da nodi con più connessioni (hub)
    const sortedCore = arranged.coreNodes.sort((a, b) => {
      return (arranged.adjacency.get(b).size || 0) - (arranged.adjacency.get(a).size || 0);
    });

    if (sortedCore.length > 0) {
      queue.push({ node: sortedCore[0], level: 0 });
      nodeLevels.set(sortedCore[0], 0);
      visited.add(sortedCore[0]);
    }

    while (queue.length > 0) {
      const { node, level } = queue.shift();
      const neighbors = arranged.adjacency.get(node) || new Set();

      neighbors.forEach(neighbor => {
        if (!visited.has(neighbor) && arranged.coreNodes.includes(neighbor)) {
          visited.add(neighbor);
          const newLevel = level + 1;
          nodeLevels.set(neighbor, newLevel);
          queue.push({ node: neighbor, level: newLevel });
        }
      });
    }

    // Posiziona core nodes in cerchi concentrici per livello
    const nodesByLevel = new Map();
    nodeLevels.forEach((level, nodeId) => {
      if (!nodesByLevel.has(level)) {
        nodesByLevel.set(level, []);
      }
      nodesByLevel.get(level).push(nodeId);
    });

    let pos = 0;
    nodesByLevel.forEach((nodeIds, level) => {
      // Calcola raggio con fattore pwt (power/weight)
      const levelRadius = baseLength * (level + 1) + (pos % 4) * (pwt / 2);
      const angleStep = (2 * Math.PI) / nodeIds.length;

      nodeIds.forEach((nodeId, idx) => {
        const node = arranged.nodeMap.get(nodeId);
        if (node) {
          const angle = idx * angleStep;
          // Usa circleCoords per posizionamento più preciso
          const coords = this.circleCoords(centerX, centerY, pos, nodes.length, level, baseLength, 0, 0);
          node.x = coords.x;
          node.y = coords.y;
          pos++;
        }
      });
    });

    // Posiziona leaf nodes attorno ai loro parent
    arranged.leafGroups.forEach((leafIds, parentId) => {
      const parent = arranged.nodeMap.get(parentId);
      if (!parent || !parent.x) return;

      const leafAngleStep = (2 * Math.PI) / leafIds.length;
      const leafRadius = 60;

      leafIds.forEach((leafId, idx) => {
        const leaf = arranged.nodeMap.get(leafId);
        if (leaf) {
          const angle = idx * leafAngleStep;
          leaf.x = parent.x + leafRadius * Math.cos(angle);
          leaf.y = parent.y + leafRadius * Math.sin(angle);
        }
      });
    });

    // Posiziona nodi senza coordinate (neighbor isolati)
    nodes.forEach(node => {
      if (!node.x || !node.y) {
        const angle = (pos * 2 * Math.PI) / nodes.length;
        const radius = baseLength * 2;
        node.x = centerX + radius * Math.cos(angle);
        node.y = centerY + radius * Math.sin(angle);
        pos++;
      }
    });

    return nodes;
  }

  /**
   * Layout circolare semplice (fallback)
   */
  circularLayout(nodes, centerX, centerY, radius) {
    const angleStep = (2 * Math.PI) / nodes.length;
    nodes.forEach((node, idx) => {
      node.x = centerX + radius * Math.cos(idx * angleStep);
      node.y = centerY + radius * Math.sin(idx * angleStep);
    });
    return nodes;
  }

  /**
   * Layout force-directed migliorato (stile NeDi con gerarchia)
   */
  forceDirectedLayout(nodes, links, iterations = 100, width = 1200, height = 800) {
    // Usa layout gerarchico come inizializzazione
    const hierarchicalNodes = this.hierarchicalLayout([...nodes], links, width, height);

    // Copia coordinate
    hierarchicalNodes.forEach((hNode, idx) => {
      if (nodes[idx] && hNode.x && hNode.y) {
        nodes[idx].x = hNode.x;
        nodes[idx].y = hNode.y;
      }
    });

    // Inizializza nodi senza coordinate
    nodes.forEach((node) => {
      if (node.x === null || node.x === undefined) {
        node.x = Math.random() * width;
        node.y = Math.random() * height;
      }
    });

    // Force-directed algorithm migliorato (meno iterazioni, partendo da layout gerarchico)
    for (let iter = 0; iter < Math.min(iterations, 50); iter++) {
      // Repulsione tra nodi (più leggera)
      nodes.forEach((node1, i) => {
        let fx = 0, fy = 0;
        nodes.forEach((node2, j) => {
          if (i === j) return;
          const dx = node2.x - node1.x;
          const dy = node2.y - node1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const minDist = 80; // Distanza minima
          if (dist < minDist) {
            const force = (minDist - dist) / minDist;
            fx -= (dx / dist) * force * 50;
            fy -= (dy / dist) * force * 50;
          }
        });

        // Attrazione per link (più forte)
        links.forEach((link) => {
          const source = nodes.find((n) => n.id === link.from || n.id === link.source);
          const target = nodes.find((n) => n.id === link.to || n.id === link.target);
          if (source === node1 && target && target.x) {
            const dx = target.x - node1.x;
            const dy = target.y - node1.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const idealDist = 150; // Distanza ideale tra nodi collegati
            const force = (dist - idealDist) / idealDist;
            fx += (dx / dist) * force * 30;
            fy += (dy / dist) * force * 30;
          }
        });

        // Applica forza (con damping decrescente)
        const damping = 0.3 * (1 - iter / iterations);
        node1.x += fx * damping;
        node1.y += fy * damping;

        // Mantieni dentro bounds
        node1.x = Math.max(50, Math.min(width - 50, node1.x));
        node1.y = Math.max(50, Math.min(height - 50, node1.y));
      });
    }

    return nodes;
  }
}

export default NetMapMap;

