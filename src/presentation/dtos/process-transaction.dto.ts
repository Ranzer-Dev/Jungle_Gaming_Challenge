import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches } from "class-validator";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";

export class ProcessTransactionDto {
  @ApiProperty({ description: "Identificador único do provedor de jogos", example: "provider-pragmatic" })
  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @ApiProperty({ description: "ID da transação no sistema do provedor externo", example: "tx-12345" })
  @IsString()
  @IsNotEmpty()
  externalTransactionId!: string;

  @ApiProperty({ description: "ID do jogador", example: "player-987" })
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({ description: "UUID da carteira no sistema", example: "b1b7ef3c-6cc1-447a-8bc2-108b3e34b15c" })
  @IsUUID()
  @IsNotEmpty()
  walletId!: string;

  @ApiProperty({ description: "ID da rodada de jogo", example: "round-456" })
  @IsString()
  @IsNotEmpty()
  roundId!: string;

  @ApiProperty({ description: "ID ou código do jogo", example: "sweet-bonanza" })
  @IsString()
  @IsNotEmpty()
  gameId!: string;

  @ApiProperty({
    description: "Tipo de transação financeira de aposta",
    enum: WagerTransactionKind,
    example: WagerTransactionKind.Bet,
  })
  @IsEnum(WagerTransactionKind, {
    message: "kind must be one of: BET, WIN, LOSS, REFUND, ROLLBACK",
  })
  kind!: WagerTransactionKind;

  @ApiProperty({
    description: "Montante monetário em string decimal exata (escala fixa de 2 casas decimais)",
    example: "25.00",
  })
  @IsString()
  @Matches(/^\d+\.\d{2}$/, {
    message: "amount must be a non-negative decimal string with exactly 2 decimal places (e.g. '25.00')",
  })
  amount!: string;

  @ApiProperty({ description: "Código de moeda ISO-4217 de 3 letras", example: "BRL" })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: "currency must be a 3-letter uppercase ISO-4217 code" })
  currency!: string;

  @ApiPropertyOptional({
    description: "ID externo da transação de referência (obrigatório para REFUND e ROLLBACK)",
    example: "tx-12345",
  })
  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;

  @ApiPropertyOptional({
    description: "UUID interno da transação de referência no sistema (opcional)",
    example: "c2c8ef3c-7dd2-558b-9cd3-219b4e45c26d",
  })
  @IsOptional()
  @IsUUID()
  referenceTransactionId?: string;
}

