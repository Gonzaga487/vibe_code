export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication is required'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action'): AppError =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Resource not found'): AppError =>
  new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown): AppError =>
  new AppError(422, 'VALIDATION_ERROR', message, details);
export const tooLarge = (message = 'Request body exceeds the configured size limit'): AppError =>
  new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const rateLimited = (message = 'Too many requests; retry later'): AppError =>
  new AppError(429, 'RATE_LIMITED', message);
