import { Injectable } from "@nestjs/common";
import { IProviderIdentityPort } from "../../application/ports/provider-identity.port";

@Injectable()
export class DefaultProviderIdentityService implements IProviderIdentityPort {
  public async validateProvider(params: {
    claimedProviderId: string;
    headerProviderId?: string;
    authorizationHeader?: string;
  }): Promise<boolean> {
    const { claimedProviderId, headerProviderId, authorizationHeader } = params;

    // Se o header X-Provider-Id foi enviado, ele deve ser idêntico ao providerId do corpo
    if (headerProviderId && headerProviderId.trim() !== claimedProviderId.trim()) {
      return false;
    }

    // Se o Authorization Bearer token foi fornecido com formato Bearer <providerId>[:secret]
    if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
      const token = authorizationHeader.replace("Bearer ", "").trim();
      const tokenProvider = token.split(":")[0];
      if (tokenProvider && tokenProvider !== claimedProviderId) {
        return false;
      }
    }

    return true;
  }
}
