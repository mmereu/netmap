/**
 * Site Filter Middleware
 *
 * Applica filtri basati sui siti assegnati all'utente.
 * - Admin: accesso globale (nessun filtro)
 * - Utente senza siti assegnati: accesso globale (opt-in)
 * - Utente con siti assegnati: filtra per quei siti
 *
 * Uso:
 *   const { siteFilterMiddleware } = require('./lib/siteFilter');
 *   app.get('/api/devices', authMiddleware, siteFilterMiddleware(db), handler);
 */

/**
 * Crea middleware per filtro siti
 * @param {Object} db - Istanza NetMapDB
 * @returns {Function} Express middleware
 */
function createSiteFilterMiddleware(db) {
  return function siteFilterMiddleware(req, res, next) {
    // Se non c'è utente autenticato, nessun filtro (auth disabilitata)
    if (!req.user) {
      req.siteFilter = null;
      return next();
    }

    const user = req.user;

    // Admin bypass - accesso globale
    if (user.role === 'admin') {
      req.siteFilter = null;
      return next();
    }

    // Carica siti assegnati all'utente
    const userSites = db.getUserSites(user.id);

    // Nessuna assegnazione = accesso globale (opt-in restriction)
    if (!userSites || userSites.length === 0) {
      req.siteFilter = null;
      return next();
    }

    // Imposta filtro per query successive
    req.siteFilter = {
      siteIds: userSites.map(s => s.id),
      siteNames: userSites.map(s => s.name),
      sites: userSites
    };

    next();
  };
}

/**
 * Verifica se un device è accessibile dall'utente
 * @param {Object} device - Device object con site_id
 * @param {Object} siteFilter - Oggetto siteFilter da req.siteFilter
 * @returns {boolean}
 */
function isDeviceAccessible(device, siteFilter) {
  // Nessun filtro = accesso a tutto
  if (!siteFilter) return true;

  // Device senza sito assegnato - accessibile se filtro è nullo
  if (!device.site_id) return true;

  // Verifica se device.site_id è tra i siti dell'utente
  return siteFilter.siteIds.includes(device.site_id);
}

/**
 * Filtra array di devices in base al siteFilter
 * @param {Array} devices - Array di devices
 * @param {Object} siteFilter - Oggetto siteFilter
 * @returns {Array} Devices filtrati
 */
function filterDevices(devices, siteFilter) {
  if (!siteFilter) return devices;

  return devices.filter(device => {
    // Include device se:
    // - Non ha sito assegnato (unassigned)
    // - Ha un sito tra quelli dell'utente
    return !device.site_id || siteFilter.siteIds.includes(device.site_id);
  });
}

/**
 * Genera clause SQL WHERE per filtro siti
 * @param {Object} siteFilter - Oggetto siteFilter
 * @param {string} tableAlias - Alias tabella (es. 'd' per devices)
 * @returns {Object} { clause: string, params: array }
 */
function getSiteFilterSQL(siteFilter, tableAlias = '') {
  if (!siteFilter) {
    return { clause: '', params: [] };
  }

  const prefix = tableAlias ? `${tableAlias}.` : '';
  const placeholders = siteFilter.siteIds.map(() => '?').join(',');

  return {
    clause: `AND (${prefix}site_id IS NULL OR ${prefix}site_id IN (${placeholders}))`,
    params: siteFilter.siteIds
  };
}

/**
 * Middleware per verificare accesso a un singolo device
 * Usa come: app.get('/api/devices/:id', authMiddleware, siteFilterMiddleware, deviceAccessMiddleware(db), handler)
 */
function createDeviceAccessMiddleware(db) {
  return function deviceAccessMiddleware(req, res, next) {
    // Se non c'è filtro, passa
    if (!req.siteFilter) return next();

    // Prendi device ID dal parametro
    const deviceId = req.params.id || req.params.deviceId;
    if (!deviceId) return next();

    // Carica device
    const device = db.getDevice(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device non trovato' });
    }

    // Verifica accesso
    if (!isDeviceAccessible(device, req.siteFilter)) {
      // Log tentativo accesso non autorizzato
      console.warn(`[SITE-FILTER] Accesso negato: user ${req.user.id} → device ${deviceId} (site_id: ${device.site_id})`);

      // Opzionale: log in events
      try {
        db.addEvent({
          device_id: device.id,
          type: 'security',
          severity: 'warning',
          message: `Accesso negato: utente ${req.user.username} non autorizzato per questo sito`
        });
      } catch (e) {
        // Ignora errori di logging
      }

      return res.status(403).json({
        error: 'Accesso negato',
        message: 'Non hai i permessi per visualizzare questo device'
      });
    }

    next();
  };
}

module.exports = {
  createSiteFilterMiddleware,
  createDeviceAccessMiddleware,
  isDeviceAccessible,
  filterDevices,
  getSiteFilterSQL
};
