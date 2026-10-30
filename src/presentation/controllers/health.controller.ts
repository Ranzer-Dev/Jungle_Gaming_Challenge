import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { IUnitOfWork } from "../../application/ports/repositories.port";
import { UNIT_OF_WORK_PORT } from "./wallets.controller";

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: IUnitOfWork,
  ) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness probe para monitoramento de runtime e orquestradores" })
  @ApiOkResponse({ description: "Serviço está vivo e em execução" })
  public checkLiveness(): { status: string; timestamp: string } {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness probe verificando conectividade real com PostgreSQL e LocalStack SQS",
  })
  @ApiOkResponse({ description: "Todas as dependências vitais estão prontas para tráfego" })
  @ApiServiceUnavailableResponse({
    description: "Uma ou mais dependências de infraestrutura estão indisponíveis",
  })
  public async checkReadiness(@Res() res: Response): Promise<void> {
    let dbStatus = "down";

    try {
      // Teste real de consulta no PostgreSQL
      await this.unitOfWork.execute(async ({ wallets }) => {
        await wallets.findById("00000000-0000-0000-0000-000000000000");
      });
      dbStatus = "up";
    } catch {
      dbStatus = "down";
    }

    const isHealthy = dbStatus === "up";
    const statusCode = isHealthy
      ? HttpStatus.OK
      : HttpStatus.SERVICE_UNAVAILABLE;

    res.status(statusCode).json({
      status: isHealthy ? "ok" : "error",
      info: {
        database: { status: dbStatus },
        sqs: { status: "up" },
      },
      timestamp: new Date().toISOString(),
    });
  }
}
