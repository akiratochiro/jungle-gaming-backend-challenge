import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto';

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
