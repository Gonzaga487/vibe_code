import crypto from 'node:crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';

export function createLogger({ level = 'info', test = false } = {}) {
  if (test) return pino({ level: 'silent' });

  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.confirmation',
        'password',
        'password_hash',
        '*.password',
        '*.password_hash',
        '*.token',
      ],
      censor: '[REDACTED]',
    },
  });
}

export function createHttpLogger(logger) {
  return pinoHttp({
    logger,
    genReqId(req, res) {
      const supplied = req.headers['x-request-id'];
      const requestId = typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
      res.setHeader('X-Request-Id', requestId);
      return requestId;
    },
    customLogLevel(req, res, error) {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${req.url} ${res.statusCode}`;
    },
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  });
}
