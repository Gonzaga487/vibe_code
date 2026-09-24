import { AppError } from '../lib/errors.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', `Route ${req.method} ${req.path} was not found`));
}

export function errorHandler(logger) {
  return (error, req, res, _next) => {
    let normalized = error;
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
      normalized = new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
    } else if (error?.type === 'entity.too.large' || error?.status === 413) {
      normalized = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the configured size limit');
    } else if (error?.type === 'encoding.unsupported' || error?.status === 415) {
      normalized = new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request content type is not supported');
    } else if (error?.code?.startsWith?.('SQLITE_CONSTRAINT')) {
      normalized = new AppError(409, 'DATA_CONFLICT', 'The requested change conflicts with existing data');
    } else if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
      normalized = new AppError(503, 'DATABASE_BUSY', 'The database is busy; retry shortly');
    } else if (error?.code === 'SQLITE_READONLY' || error?.code === 'SQLITE_CANTOPEN') {
      normalized = new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
    } else if (!(error instanceof AppError) && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      normalized = new AppError(error.status, 'BAD_REQUEST', error.message || 'The request could not be processed');
    }

    const status = normalized instanceof AppError ? normalized.status : 500;
    const code = normalized instanceof AppError ? normalized.code : 'INTERNAL_ERROR';
    const message = normalized instanceof AppError && normalized.expose ? normalized.message : 'An unexpected error occurred';
    const log = status >= 500 ? logger?.error.bind(logger) : logger?.warn.bind(logger);
    log?.({ err: error, requestId: req.id, code }, message);

    if (res.headersSent) return res.end();
    return res.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(normalized instanceof AppError && normalized.details ? { details: normalized.details } : {}),
        requestId: req.id,
      },
    });
  };
}
