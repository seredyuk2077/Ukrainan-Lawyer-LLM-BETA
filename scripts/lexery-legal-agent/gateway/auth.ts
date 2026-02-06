/**
 * U1 Auth — Dev Auth Provider (LEX-69)
 */
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { config } from '../lib/config.js';
import type { AuthContext, CreateRunRequest } from './types.js';

export interface AuthProvider {
  authenticate(req: Request, body?: CreateRunRequest): Promise<AuthContext>;
}

export class DevAuthProvider implements AuthProvider {
  async authenticate(req: Request, body?: CreateRunRequest): Promise<AuthContext> {
    const devKey = req.headers['x-dev-api-key'] as string | undefined;

    // 1) X-Dev-API-Key matches
    if (config.devApiKey && devKey === config.devApiKey) {
      return this.resolveContext(req, body);
    }

    // 2) NODE_ENV=development + DEV_ALLOW_ANONYMOUS + (tenant_id & user_id in body or header)
    if (
      config.isDev &&
      config.devAllowAnonymous &&
      (body?.allow_anonymous || body?.tenant_id || body?.user_id || req.headers['x-tenant-id'] || req.headers['x-user-id'])
    ) {
      return this.resolveContext(req, body);
    }

    if (config.devApiKey) {
      throw new AuthError(401, 'UNAUTHORIZED', 'Invalid or missing X-Dev-API-Key');
    }

    throw new AuthError(401, 'UNAUTHORIZED', 'Auth required. Set DEV_API_KEY or DEV_ALLOW_ANONYMOUS=true with tenant_id/user_id.');
  }

  private resolveContext(req: Request, body?: CreateRunRequest): AuthContext {
    const tenantId = body?.tenant_id || (req.headers['x-tenant-id'] as string) || this.fallbackUuid('tenant');
    const userId = body?.user_id || (req.headers['x-user-id'] as string) || this.fallbackUuid('user');

    return {
      tenant_id: tenantId,
      user_id: userId,
      plan_tier: 'dev',
      features: { doclist_enabled: true, web_assist_enabled: false },
    };
  }

  private fallbackUuid(seed: string): string {
    return randomUUID();
  }
}

export class AuthError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
