import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import type { Response } from "express";
import { IUnitOfWork } from "../../application/ports/repositories.port";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";
import { ProcessTransactionDto } from "../dtos/process-transaction.dto";
import { ProviderAuthGuard } from "../guards/provider-auth.guard";
import { UNIT_OF_WORK_PORT } from "./wallets.controller";

@ApiTags("Wagering")
@Controller()
export class WageringController {
  constructor(
    private readonly processTransactionUseCase: ProcessWagerTransactionUseCase,
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: IUnitOfWork,
  ) {}

  @Post("wagering/transactions")
  @UseGuards(ProviderAuthGuard)
  @ApiOperation({
    summary:
      "Processar transação de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) com garantia de idempotência estrita",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Chave única fornecida pelo cliente/provedor para deduplicação infalível",
  })
  @ApiHeader({
    name: "X-Provider-Id",
    required: false,
    description: "ID do provedor para validação de segurança e autorização mútua",
  })
  @ApiCreatedResponse({ description: "Transação financeira executada com sucesso" })
  @ApiOkResponse({ description: "Replay idempotente de transação já processada anteriormente" })
  @ApiAcceptedResponse({
    description: "Transação aceita em modo PENDING_REFERENCE aguardando resolução de dependência",
  })
  @ApiBadRequestResponse({ description: "Payload inválido ou cabeçalho Idempotency-Key ausente" })
  @ApiConflictResponse({ description: "Conflito de idempotência (mesma chave com payload divergente)" })
  @ApiUnprocessableEntityResponse({
    description:
      "Rejeição por regra de negócio (saldo insuficiente, estorno duplicado, etc.)",
  })
  public async processTransaction(
    @Body() dto: ProcessTransactionDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new BadRequestException("Header 'Idempotency-Key' is required for transaction processing");
    }

    const result = await this.processTransactionUseCase.execute({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey: idempotencyKey.trim(),
      walletId: dto.walletId,
      playerId: dto.playerId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      amount: dto.amount,
      currency: dto.currency,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      referenceTransactionId: dto.referenceTransactionId,
    });

    let status = HttpStatus.CREATED;

    if (result.status === WagerTransactionStatus.PendingReference) {
      status = HttpStatus.ACCEPTED;
    } else if (result.idempotentReplay) {
      status = HttpStatus.OK;
    }

    res.status(status).json(result);
  }

  @Get("wagering/transactions/:id")
  @ApiOperation({ summary: "Consultar uma transação pelo UUID interno do sistema" })
  @ApiOkResponse({ description: "Transação encontrada" })
  @ApiNotFoundResponse({ description: "Transação não encontrada" })
  public async getTransactionById(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.unitOfWork.execute(async ({ transactions }) => {
      const tx = await transactions.findById(id);
      if (!tx) {
        throw new NotFoundException(`Transaction with id '${id}' was not found`);
      }

      return {
        id: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toProps(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        referenceTransactionId: tx.referenceTransactionId,
        status: tx.status,
        failureCode: tx.failureCode,
        balanceAtProcessed: tx.balanceAtProcessed?.toProps(),
        createdAt: tx.createdAt,
        processedAt: tx.processedAt,
      };
    });
  }

  @Get("providers/:providerId/transactions/:externalTransactionId")
  @ApiOperation({
    summary: "Consultar uma transação pela chave composta do provedor (providerId, externalTransactionId)",
  })
  @ApiOkResponse({ description: "Transação do provedor encontrada" })
  @ApiNotFoundResponse({ description: "Transação não encontrada para este provedor" })
  public async getTransactionByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<unknown> {
    return this.unitOfWork.execute(async ({ transactions }) => {
      const tx = await transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!tx) {
        throw new NotFoundException(
          `Transaction '${externalTransactionId}' for provider '${providerId}' was not found`,
        );
      }

      return {
        id: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toProps(),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        referenceTransactionId: tx.referenceTransactionId,
        status: tx.status,
        failureCode: tx.failureCode,
        balanceAtProcessed: tx.balanceAtProcessed?.toProps(),
        createdAt: tx.createdAt,
        processedAt: tx.processedAt,
      };
    });
  }
}
