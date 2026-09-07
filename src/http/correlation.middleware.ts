import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { runWithCorrelation } from '../infra/observability/correlation';

/**
 * Opens a correlation scope for every HTTP request. Honours an inbound
 * `X-Correlation-Id`, otherwise mints a UUIDv7, and echoes it back on the
 * response. Everything downstream (guards, pipes, controller, use cases) runs
 * inside this scope, so every log line is automatically correlated.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['x-correlation-id'];
    const incoming = Array.isArray(header) ? header[0] : header;
    const correlationId = incoming && incoming.trim() ? incoming.trim() : uuidv7();
    res.setHeader('x-correlation-id', correlationId);
    runWithCorrelation({ correlationId }, () => next());
  }
}
