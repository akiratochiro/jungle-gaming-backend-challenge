import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { AuthGuard } from '../infra/auth/noop-auth.guard';
import { CreateWalletUseCase } from '../application/wallet/create-wallet.use-case';
import { ReadService } from '../infra/database/read.service';
import { CreateWalletDto } from './dto/create-wallet.dto';

@UseGuards(AuthGuard)
@Controller()
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly read: ReadService,
  ) {}

  @Post('wallets')
  @HttpCode(201)
  async create(
    @Body() dto: CreateWalletDto,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.createWallet.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
      correlationId: correlationId ?? uuidv7(),
    });
  }

  @Get('wallets/:walletId')
  getWallet(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.read.wallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  getLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
  ) {
    return this.read.ledger(walletId, Math.min(Math.max(limit, 1), 200), cursor);
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.read.reconcile(walletId);
  }
}
