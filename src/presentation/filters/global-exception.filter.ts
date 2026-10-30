import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DomainError } from "../../domain/errors/domain.error";

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  failureCode?: string;
  instance: string;
  timestamp: string;
  errors?: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const instance = request.url;
    const timestamp = new Date().toISOString();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = "Internal Server Error";
    let detail = "An unexpected error occurred processing your request.";
    let failureCode: string | undefined = undefined;
    let errors: unknown = undefined;

    // 1. Erros puros de Domínio (DomainError)
    if (exception instanceof DomainError) {
      status = exception.statusCode;
      failureCode = exception.failureCode;
      detail = exception.message;
      title = this.formatTitleFromFailureCode(exception.failureCode);
    }
    // 2. Exceções HTTP do NestJS (validações, 404 de rotas, etc.)
    else if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = exception.name;
      const resp = exception.getResponse();

      if (typeof resp === "string") {
        detail = resp;
      } else if (typeof resp === "object" && resp !== null) {
        const respObj = resp as Record<string, unknown>;
        detail =
          typeof respObj["message"] === "string"
            ? respObj["message"]
            : Array.isArray(respObj["message"])
              ? respObj["message"].join("; ")
              : exception.message;

        if (Array.isArray(respObj["message"])) {
          errors = respObj["message"];
        }
      }

      if (status === HttpStatus.BAD_REQUEST) {
        failureCode = "INVALID_PAYLOAD";
      } else if (status === HttpStatus.NOT_FOUND) {
        failureCode = "RESOURCE_NOT_FOUND";
      } else if (status === HttpStatus.FORBIDDEN) {
        failureCode = "FORBIDDEN";
      }
    }
    // 3. Tratamento de Erros de Banco de Dados / Driver PostgreSQL
    else if (
      exception !== null &&
      typeof exception === "object" &&
      "code" in exception
    ) {
      const dbError = exception as { code: string; message: string; constraint?: string };
      // 23505: unique_violation
      if (dbError.code === "23505") {
        status = HttpStatus.CONFLICT;
        title = "Unique Constraint Violation";
        if (dbError.constraint?.includes("wallet")) {
          failureCode = "WALLET_ALREADY_EXISTS";
          detail = "A wallet with the same currency already exists for this player.";
        } else if (dbError.constraint?.includes("idempotency")) {
          failureCode = "IDEMPOTENCY_PAYLOAD_MISMATCH";
          detail = "Concurrent duplicate request conflict.";
        } else {
          failureCode = "DUPLICATE_RESOURCE";
          detail = "Unique constraint violation in database.";
        }
      }
      // 57014: query_canceled / lock_timeout
      else if (dbError.code === "57014" || dbError.code === "55P03") {
        status = HttpStatus.SERVICE_UNAVAILABLE;
        failureCode = "LOCK_TIMEOUT";
        title = "Concurrency Lock Timeout";
        detail = "The wallet lock could not be acquired within the timeout window. Please retry.";
      } else {
        this.logger.error(`Unhandled database error: ${dbError.message} (code: ${dbError.code})`);
      }
    }
    // 4. Exceção desconhecida / genérica
    else {
      const errorMsg =
        exception instanceof Error ? exception.message : String(exception);
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`Unhandled unexpected exception on ${instance}: ${errorMsg}`, stack);
    }

    const problem: ProblemDetails = {
      type: `https://api.jungle.gaming/errors/${failureCode || "INTERNAL_ERROR"}`,
      title,
      status,
      detail,
      ...(failureCode ? { failureCode } : {}),
      instance,
      timestamp,
      ...(errors ? { errors } : {}),
    };

    response.status(status).json(problem);
  }

  private formatTitleFromFailureCode(code: string): string {
    return code
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
}
