import { CanActivate, Injectable } from '@nestjs/common';

/**
 * No-op guard — the deliberate auth choice for this challenge (auth is not
 * scored; see ARCHITECTURE.md). Swap for a real JWT/OIDC guard without touching
 * controllers: they already declare `@UseGuards(AuthGuard)`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
