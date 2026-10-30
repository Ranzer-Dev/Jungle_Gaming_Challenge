export abstract class IProviderIdentityPort {
  abstract validateProvider(params: {
    claimedProviderId: string;
    headerProviderId?: string;
    authorizationHeader?: string;
  }): Promise<boolean>;
}
