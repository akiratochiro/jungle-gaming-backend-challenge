import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, InvalidValueError } from '../domain/shared/domain-error';
import { MoneyCurrencyMismatchError } from '../domain/shared/money';
import { IdempotencyConflictError } from '../domain/wager/errors';
import {
  TransientInfrastructureError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/wager/errors';

/**
 * Single place that maps thrown errors to HTTP status codes so a provider can
 * branch on the status alone (see ARCHITECTURE.md §HTTP status mapping):
 *   400 malformed payload · 404 unknown wallet · 409 idempotency/uniqueness
 *   conflict · 422 business rejection · 503 transient infrastructure failure.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.translate(exception);

    if (status >= 500) {
      // Log the error class only — messages can echo request values.
      this.logger.error({
        msg: 'request failed',
        status,
        error: exception instanceof Error ? exception.name : 'UnknownError',
      });
    }
    res.status(status).json(body);
  }

  private translate(e: unknown): { status: number; body: Record<string, unknown> } {
    if (e instanceof HttpException) {
      const resp = e.getResponse();
      return {
        status: e.getStatus(),
        body: typeof resp === 'string' ? { error: resp } : (resp as Record<string, unknown>),
      };
    }

    if (e instanceof IdempotencyConflictError || e instanceof WalletAlreadyExistsError) {
      return { status: HttpStatus.CONFLICT, body: this.shape(e) };
    }
    if (e instanceof WalletNotFoundError) {
      return { status: HttpStatus.NOT_FOUND, body: this.shape(e) };
    }
    if (
      e instanceof ValidationError ||
      e instanceof InvalidValueError ||
      e instanceof MoneyCurrencyMismatchError
    ) {
      return { status: HttpStatus.BAD_REQUEST, body: this.shape(e) };
    }
    if (e instanceof TransientInfrastructureError) {
      return { status: HttpStatus.SERVICE_UNAVAILABLE, body: this.shape(e) };
    }
    if (e instanceof DomainError) {
      // Unclassified domain rule violation — treat as unprocessable.
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, body: this.shape(e) };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: 'INTERNAL_ERROR', message: 'Unexpected error' },
    };
  }

  private shape(e: DomainError | Error): Record<string, unknown> {
    const code = (e as DomainError).code ?? e.name;
    return { error: code, message: e.message };
  }
}
