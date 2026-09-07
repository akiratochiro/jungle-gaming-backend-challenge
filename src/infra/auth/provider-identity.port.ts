/**
 * Extension point for authentication (see ARCHITECTURE.md §Auth).
 *
 * This challenge ships a no-op implementation: HTTP endpoints are open and the
 * provider identity is taken verbatim from the request/message body. To plug a
 * real Identity Provider (Keycloak / Zitadel / any OIDC), implement this port
 * to resolve the authenticated provider from a bearer token and bind the result
 * in `AppModule`. Domain-level validation of the provider identity carried in
 * the payload is unaffected and always runs.
 */
export interface AuthenticatedProvider {
  providerId: string;
}

export abstract class ProviderIdentityPort {
  /** Resolve the calling provider. `undefined` when the channel is trusted-internal (queue). */
  abstract resolve(request: unknown): Promise<AuthenticatedProvider | undefined>;
}

export class NoopProviderIdentity extends ProviderIdentityPort {
  async resolve(): Promise<AuthenticatedProvider | undefined> {
    return undefined;
  }
}
