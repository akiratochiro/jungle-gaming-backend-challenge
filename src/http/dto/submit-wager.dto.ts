import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../domain/wager/enums';
import { MoneyDto } from './money.dto';

export class SubmitWagerDto {
  @IsString()
  @MaxLength(128)
  providerId!: string;

  @IsString()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @MaxLength(128)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
