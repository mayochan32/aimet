import type { AccessMode } from '../types.js';

/**
 * VS Code qualifies extension-provided BYOK models as
 * `<vendor>/<id>` or `<vendor>/<group>/<id>`. Keep this allowlist aligned
 * with VS Code's built-in BYOK vendors so an arbitrary slash in a model id
 * never becomes route evidence by itself.
 */
const BYOK_PROVIDERS: Readonly<Record<string, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  ollama: 'ollama',
  openrouter: 'openrouter',
  azure: 'azure.ai.openai',
  xai: 'xai',
  customoai: 'custom',
  customendpoint: 'custom',
};

type QualifiedByokModel = {
  vendor: string;
  provider: string;
  model: string;
};

export type CopilotModelIdentity = {
  model: string;
  accessMode: AccessMode;
  provider: string;
};

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function serverHost(serverAddress: string | null): string {
  return (serverAddress ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
}

export function isCopilotHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com') ||
    host === 'githubcopilot.com' || host.endsWith('.githubcopilot.com');
}

function qualifiedByokModel(value: unknown): QualifiedByokModel | null {
  const raw = stringValue(value);
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const vendor = raw.slice(0, slash).toLowerCase();
  const provider = BYOK_PROVIDERS[vendor];
  if (!provider) return null;
  return { vendor, provider, model: raw.slice(slash + 1) };
}

function normalizedProvider(value: unknown): string {
  const provider = stringValue(value).toLowerCase();
  if (!provider) return 'unknown';
  return BYOK_PROVIDERS[provider] ?? provider;
}

function endpointProvider(host: string): string | null {
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai';
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === 'api.x.ai' || host.endsWith('.x.ai')) return 'xai';
  if (host.endsWith('.openai.azure.com')) return 'azure.ai.openai';
  return null;
}

/**
 * Resolve model, access route and provider from all evidence on one request.
 * A qualified local-BYOK model is authoritative over a zero-valued Copilot
 * credit attribute, which current VS Code builds can still emit. Positive
 * credits conflict with a BYOK identifier and are reported as mixed rather
 * than silently choosing the wrong billing route.
 */
export function copilotModelIdentity(options: {
  requestModel?: unknown;
  responseModel?: unknown;
  reportedProvider?: unknown;
  serverAddress?: string | null;
  credits?: number | null;
}): CopilotModelIdentity {
  const request = stringValue(options.requestModel);
  const response = stringValue(options.responseModel);
  const qualifiedRequest = qualifiedByokModel(request);
  const qualifiedResponse = qualifiedByokModel(response);
  const qualified = qualifiedRequest ?? qualifiedResponse;
  const selected = response || request || 'unknown';
  const selectedQualified = qualifiedByokModel(selected);
  const model = selectedQualified?.model ?? selected;
  const host = serverHost(options.serverAddress ?? null);
  const reported = normalizedProvider(options.reportedProvider);
  const directProvider = reported !== 'unknown' && reported !== 'github';
  const specificReportedProvider = directProvider && reported !== 'custom';
  const directHost = Boolean(host) && !isCopilotHost(host);
  const positiveCredits = options.credits !== null && options.credits !== undefined && options.credits > 0;

  let accessMode: AccessMode;
  if (qualified) accessMode = positiveCredits ? 'mixed' : 'byok';
  else if (directHost || directProvider) accessMode = 'byok';
  else if (options.credits !== null && options.credits !== undefined) accessMode = 'copilot';
  else if (reported === 'github' || isCopilotHost(host)) accessMode = 'copilot';
  else accessMode = 'unknown';

  let provider: string;
  if (specificReportedProvider) provider = reported;
  else provider = endpointProvider(host) ?? qualified?.provider ??
      (directHost ? 'custom' : accessMode === 'copilot' ? 'github' : reported);

  // Different qualified vendors on one request are contradictory evidence.
  if (qualifiedRequest && qualifiedResponse && qualifiedRequest.vendor !== qualifiedResponse.vendor) {
    accessMode = 'mixed';
    provider = 'mixed';
  }

  return { model, accessMode, provider };
}
