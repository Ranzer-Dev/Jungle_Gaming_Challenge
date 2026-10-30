import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { IUnitOfWork } from "../../application/ports/repositories.port";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../application/use-cases/reconcile-wallet.use-case";
import { WalletNotFoundError } from "../../domain/errors/wallet.errors";
import { CreateWalletDto } from "../dtos/create-wallet.dto";
import { LedgerQueryDto } from "../dtos/ledger-query.dto";

export const UNIT_OF_WORK_PORT = "IUnitOfWork";

@ApiTags("Wallets")
@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: IUnitOfWork,
  ) {}

  @Post()
  @ApiOperation({ summary: "Criar uma nova carteira para o jogador" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "Chave única de idempotência para criação segura e sem duplicidades",
  })
  @ApiCreatedResponse({ description: "Carteira criada com sucesso" })
  @ApiConflictResponse({ description: "Jogador já possui uma carteira ativa nesta moeda" })
  public async createWallet(
    @Body() dto: CreateWalletDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.createWalletUseCase.execute({
      playerId: dto.playerId,
      initialBalance: {
        amount: dto.initialBalance ?? "0.00",
        currency: dto.currency,
      },
    });

    res.status(HttpStatus.CREATED).json(result);
  }

  @Get(":id")
  @ApiOperation({ summary: "Consultar saldo e metadados de uma carteira" })
  @ApiOkResponse({ description: "Carteira encontrada com saldo materializado atual" })
  @ApiNotFoundResponse({ description: "Carteira não encontrada" })
  public async getWalletById(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{
    id: string;
    playerId: string;
    currency: string;
    balance: { amount: string; currency: string };
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return this.unitOfWork.execute(async ({ wallets }) => {
      const wallet = await wallets.findById(id);
      if (!wallet) {
        throw new WalletNotFoundError(id);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toProps(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      };
    });
  }

  @Get(":id/ledger")
  @ApiOperation({
    summary: "Consultar extrato append-only imutável da carteira (paginação por cursor Base64)",
  })
  @ApiOkResponse({ description: "Página de lançamentos do ledger retornada" })
  @ApiNotFoundResponse({ description: "Carteira não encontrada" })
  public async getWalletLedger(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ): Promise<{
    items: Array<{
      id: string;
      walletId: string;
      transactionId: string;
      direction: string;
      money: { amount: string; currency: string };
      balanceBefore: { amount: string; currency: string };
      balanceAfter: { amount: string; currency: string };
      createdAt: Date;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    return this.unitOfWork.execute(async ({ wallets, ledgers }) => {
      const wallet = await wallets.findById(id);
      if (!wallet) {
        throw new WalletNotFoundError(id);
      }

      const { entries, nextCursor } = await ledgers.findByWalletId(id, {
        limit: query.limit,
        cursor: query.cursor,
      });

      return {
        items: entries.map((e) => ({
          id: e.id,
          walletId: e.walletId,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toProps(),
          balanceBefore: e.balanceBefore.toProps(),
          balanceAfter: e.balanceAfter.toProps(),
          createdAt: e.createdAt,
        })),
        nextCursor,
        hasMore: nextCursor !== null,
      };
    });
  }

  @Post(":id/reconciliation")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Auditar consistência matemática entre o saldo materializado e a soma do ledger",
  })
  @ApiOkResponse({ description: "Resultado da auditoria de reconciliação financeira" })
  @ApiNotFoundResponse({ description: "Carteira não encontrada" })
  public async reconcileWallet(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<{
    walletId: string;
    balance: { amount: string; currency: string };
    ledgerSum: { amount: string; currency: string };
    consistent: boolean;
    checkedEntries: number;
  }> {
    return this.reconcileWalletUseCase.execute({ walletId: id });
  }
}
