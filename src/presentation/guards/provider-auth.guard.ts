import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { IProviderIdentityPort } from "../../application/ports/provider-identity.port";
import { ProviderIdentityMismatchError } from "../../domain/errors/transaction.errors";

export const PROVIDER_IDENTITY_PORT = "IProviderIdentityPort";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly providerIdentityService: IProviderIdentityPort,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const claimedProviderId =
      request.body?.providerId || request.params?.providerId;

    if (!claimedProviderId) {
      return true;
    }

    const headerProviderId = (
      request.headers["x-provider-id"] || request.headers["x-provider-id"]
    ) as string | undefined;

    const authorizationHeader = request.headers["authorization"] as
      | string
      | undefined;

    const isValid = await this.providerIdentityService.validateProvider({
      claimedProviderId,
      headerProviderId,
      authorizationHeader,
    });

    if (!isValid) {
      throw new ProviderIdentityMismatchError(
        claimedProviderId,
        headerProviderId || "invalid-token",
      );
    }

    return true;
  }
}
