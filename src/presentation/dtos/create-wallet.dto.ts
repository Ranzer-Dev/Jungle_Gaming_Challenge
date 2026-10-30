import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, Length, Matches } from "class-validator";

export class CreateWalletDto {
  @ApiProperty({ description: "ID único do jogador no ecossistema", example: "player-987" })
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ApiProperty({ description: "Código ISO-4217 de 3 letras da moeda", example: "BRL" })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: "currency must be a 3-letter uppercase ISO-4217 code" })
  currency!: string;

  @ApiPropertyOptional({
    description: "Saldo inicial opcional da carteira com 2 casas decimais",
    example: "100.00",
  })
  @IsOptional()
  @IsString()
  @Matches(/^-?\d+\.\d{2}$/, {
    message: "initialBalance must be a decimal string with exactly 2 decimal places (e.g. '100.00')",
  })
  initialBalance?: string;

  @ApiPropertyOptional({
    description: "UUID opcional pré-gerado para a carteira",
    example: "b1b7ef3c-6cc1-447a-8bc2-108b3e34b15c",
  })
  @IsOptional()
  @IsString()
  id?: string;
}

