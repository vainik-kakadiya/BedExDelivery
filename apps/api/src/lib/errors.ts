import type { ApiErrorBody } from '@bedex/shared';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have access to this') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Endpoint not found'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiErrorBody = { code: 'INTERNAL_ERROR', message: 'Something went wrong' };

  if (err instanceof AppError) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: err.flatten() };
  } else if (isBodyTooLarge(err)) {
    status = 413;
    body = { code: 'TOO_LARGE', message: 'That upload is too large' };
  } else if (isBodyParserError(err)) {
    status = 400;
    body = { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' };
  } else if (isPgError(err, '23505')) {
    status = 409;
    body = { code: 'DUPLICATE', message: 'A record with these details already exists', details: { constraint: err.constraint_name } };
  }

  if (status >= 500) req.log?.error({ err }, 'Unhandled error');
  res.status(status).json(body);
};

function isBodyParserError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed';
}

function isBodyTooLarge(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large';
}

function isPgError(err: unknown, code: string): err is { code: string; constraint_name?: string } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
