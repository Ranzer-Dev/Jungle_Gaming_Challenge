import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class LedgerQueryDto {
  @ApiPropertyOptional({
    description: "Quantidade máxima de registros a retornar por página (máx. 100)",
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: "Cursor opaco codificado em Base64 para paginação determinística",
    example: "eyJjcmVhdGVkQXQiOiIyMDI2LTEwLTMwVDExOjAwOjAwLjAwMFoiLCJpZCI6IjAxOTJm...\"}",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
