import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { AuthGuard } from '../infra/auth/noop-auth.guard';
import {
  SubmitWagerResult,
  SubmitWagerTransactionUseCase,
} from '../application/wager/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../domain/wager/enums';
import { ReadService } from '../infra/database/read.service';
import { SubmitWagerDto } from './dto/submit-wager.dto';

@UseGuards(AuthGuard)
@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly read: ReadService,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() dto: SubmitWagerDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      });
    }

    const result = await this.submit.execute({
      idempotencyKey: idempotencyKey.trim(),
      correlationId: correlationId ?? uuidv7(),
      payload: {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind,
        money: dto.money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      },
    });

    res.status(this.statusFor(result)).json({
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance ?? null,
      failureCode: result.failureCode ?? null,
      idempotentReplay: result.idempotentReplay,
    });
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.read.transactionById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByProviderRef(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.read.transactionByProviderRef(providerId, externalTransactionId);
  }

  /**
   * HTTP status mapping (documented in ARCHITECTURE.md):
   *  - PROCESSED           -> 200
   *  - REJECTED            -> 422 (business rejection, carries failureCode)
   *  - PENDING_REFERENCE   -> 202 (accepted, still resolving)
   *  - PENDING             -> 202
   * Malformed payload (400), idempotency conflict (409), unknown wallet (404)
   * and transient infra failure (503) are raised as exceptions by the use case
   * and mapped in DomainExceptionFilter.
   */
  private statusFor(r: SubmitWagerResult): number {
    switch (r.status) {
      case WagerTransactionStatus.Processed:
        return 200;
      case WagerTransactionStatus.Rejected:
        return 422;
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Pending:
        return 202;
      case WagerTransactionStatus.Failed:
        return 503;
      default:
        return 200;
    }
  }
}
