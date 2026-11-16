import type { Response } from 'express';
import type { AppConfig } from './config.js';
import { ApiError } from './validation.js';

/**
 * Outbound redirects are resolved against an allow-list built from this
 * process's own configuration: the frontend origin and the SSO endpoints it was
 * started with. Nothing derived from a request can steer a browser elsewhere,
 * and targets are normalized through URL() so dot-segment or userinfo tricks
 * cannot slip past the origin comparison.
 */
export function allowedRedirectOrigins(cfg: AppConfig): Set<string> {
  const origins = new Set<string>();
  origins.add(normalizeOrigin(cfg.frontendOrigin));
  for (const provider of Object.values(cfg.providers)) {
    origins.add(normalizeOrigin(provider.authorizeUrl));
    origins.add(normalizeOrigin(provider.tokenUrl));
    origins.add(normalizeOrigin(provider.redirectUri));
  }
  origins.delete('');
  return origins;
}

function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

/** Sends a 302 whose Location is guaranteed to be an allow-listed https/http origin. */
export function redirectAllowlisted(cfg: AppConfig, res: Response, target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new ApiError('redirect_refused', 'Redirect target is not an absolute URL', 500);
  }
  const schemeOk = url.protocol === 'http:' || url.protocol === 'https:';
  if (!schemeOk || !allowedRedirectOrigins(cfg).has(url.origin)) {
    throw new ApiError('redirect_refused', `Refused redirect to non-allow-listed origin ${url.origin}`, 500);
  }
  res.status(302).set('Location', url.toString()).end();
}
