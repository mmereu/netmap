/**
 * Centralized Error Handling Middleware
 * Replaces 71+ duplicate catch blocks with consistent error responses.
 */

/**
 * Custom application error class for operational errors.
 * Use this for expected errors (validation, not found, etc.)
 */
export class AppError extends Error {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code (default: 500)
   * @param {string} code - Error code for programmatic handling (default: 'INTERNAL_ERROR')
   * @param {object} details - Additional error details (optional)
   */
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // Distinguishes from programming errors

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details })
      }
    };
  }
}

/**
 * Common HTTP error factories
 */
export const Errors = {
  badRequest: (message, details = null) =>
    new AppError(message || 'Richiesta non valida', 400, 'BAD_REQUEST', details),

  unauthorized: (message = 'Non autorizzato') =>
    new AppError(message, 401, 'UNAUTHORIZED'),

  forbidden: (message = 'Accesso negato') =>
    new AppError(message, 403, 'FORBIDDEN'),

  notFound: (resource = 'Risorsa') =>
    new AppError(`${resource} non trovato`, 404, 'NOT_FOUND'),

  conflict: (message) =>
    new AppError(message, 409, 'CONFLICT'),

  validation: (message, details = null) =>
    new AppError(message || 'Errore di validazione', 422, 'VALIDATION_ERROR', details),

  internal: (message = 'Errore interno del server') =>
    new AppError(message, 500, 'INTERNAL_ERROR'),

  serviceUnavailable: (message = 'Servizio non disponibile') =>
    new AppError(message, 503, 'SERVICE_UNAVAILABLE'),

  timeout: (message = 'Timeout della richiesta') =>
    new AppError(message, 504, 'TIMEOUT')
};

/**
 * Async handler wrapper to catch errors in async route handlers.
 * Eliminates the need for try-catch in every route.
 *
 * @param {Function} fn - Async route handler function
 * @returns {Function} - Wrapped handler that catches errors
 *
 * @example
 * // Before:
 * app.get('/api/data', async (req, res) => {
 *   try {
 *     const data = await getData();
 *     res.json(data);
 *   } catch (err) {
 *     console.error('[API] Errore:', err);
 *     res.status(500).json({ error: err.message });
 *   }
 * });
 *
 * // After:
 * app.get('/api/data', asyncHandler(async (req, res) => {
 *   const data = await getData();
 *   res.json(data);
 * }));
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Central error handling middleware.
 * Must be registered LAST in the middleware chain.
 *
 * @param {Error} err - Error object
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
export function errorHandler(err, req, res, next) {
  // Log the error
  const logPrefix = `[${new Date().toISOString()}] [ERROR]`;
  const endpoint = `${req.method} ${req.originalUrl}`;

  if (err.isOperational) {
    // Operational errors (expected)
    console.error(`${logPrefix} ${endpoint} - ${err.code}: ${err.message}`);
  } else {
    // Programming errors (unexpected) - log full stack
    console.error(`${logPrefix} ${endpoint} - Unexpected error:`);
    console.error(err.stack || err);
  }

  // Determine status code
  const statusCode = err.statusCode || err.status || 500;

  // Build response
  const response = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.isOperational ? err.message : 'Errore interno del server'
    }
  };

  // Add details if present
  if (err.details) {
    response.error.details = err.details;
  }

  // In development, include stack trace for non-operational errors
  if (process.env.NODE_ENV === 'development' && !err.isOperational) {
    response.error.stack = err.stack;
  }

  // Send response
  res.status(statusCode).json(response);
}

/**
 * 404 Not Found handler for undefined routes.
 */
export function notFoundHandler(req, res, next) {
  next(Errors.notFound(`Endpoint ${req.method} ${req.originalUrl}`));
}

/**
 * Validation helper - throws AppError if condition is false.
 * @param {boolean} condition - Condition to check
 * @param {string} message - Error message if condition is false
 * @param {object} details - Additional details
 * @throws {AppError} - If condition is false
 */
export function validate(condition, message, details = null) {
  if (!condition) {
    throw Errors.validation(message, details);
  }
}

/**
 * Required field validation helper.
 * @param {object} obj - Object to check
 * @param {string[]} fields - Required field names
 * @throws {AppError} - If any field is missing
 */
export function requireFields(obj, fields) {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length > 0) {
    throw Errors.badRequest(`Campi obbligatori mancanti: ${missing.join(', ')}`, { missing });
  }
}

export default {
  AppError,
  Errors,
  asyncHandler,
  errorHandler,
  notFoundHandler,
  validate,
  requireFields
};
