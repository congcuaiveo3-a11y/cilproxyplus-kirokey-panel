/**
 * Kiro login/import logic shared by the OAuth page.
 *
 * The polling contract is inherited from the shared management OAuth status
 * endpoint: while a Kiro device flow is pending, the backend reports progress
 * through the `error` field as `device_code|<verification url>|<user code>`.
 * Treating that string as a failure would abort every device login, so the
 * classification below is deliberate rather than defensive.
 */

export type KiroLoginMethod = 'builder-id' | 'idc';

export interface KiroDeviceCode {
  verificationUrl: string;
  userCode: string;
}

export type KiroPollOutcome =
  | { kind: 'pending' }
  | { kind: 'device_code'; deviceCode: KiroDeviceCode }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export interface KiroAuthStatusResponse {
  status: 'ok' | 'wait' | 'error';
  error?: string;
}

const DEVICE_CODE_PREFIX = 'device_code|';

/**
 * classifyKiroPoll maps one status response onto a UI outcome.
 */
export const classifyKiroPoll = (response: KiroAuthStatusResponse): KiroPollOutcome => {
  if (response.status === 'ok') return { kind: 'success' };
  if (response.status === 'wait') return { kind: 'pending' };

  const raw = (response.error ?? '').trim();
  if (raw.startsWith(DEVICE_CODE_PREFIX)) {
    const [, verificationUrl = '', userCode = ''] = raw.split('|');
    if (verificationUrl) {
      return { kind: 'device_code', deviceCode: { verificationUrl, userCode } };
    }
    return { kind: 'pending' };
  }
  return { kind: 'error', message: raw };
};

/**
 * validateKiroStartUrl mirrors the backend validator so an obvious mistake is
 * reported before a request is sent. The backend remains authoritative.
 */
export const validateKiroStartUrl = (raw: string): { valid: boolean; reason?: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, reason: 'required' };
  if (trimmed.length > 512) return { valid: false, reason: 'too_long' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'invalid' };
  }
  if (parsed.protocol !== 'https:') return { valid: false, reason: 'https_required' };
  if (parsed.username || parsed.password) return { valid: false, reason: 'invalid' };
  if (parsed.search || parsed.hash) return { valid: false, reason: 'invalid' };
  if (!parsed.hostname) return { valid: false, reason: 'invalid' };
  return { valid: true };
};

/**
 * validateKiroRegion accepts the conservative AWS region shape the backend
 * interpolates into the OIDC endpoint host.
 */
export const validateKiroRegion = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^[a-z0-9-]{1,32}$/.test(trimmed);
};

/**
 * summarizeKiroImportPayload reports how many credentials a payload contains
 * without revealing any secret. It accepts the same container shapes as the
 * backend: a single object, an array, `{accounts:[...]}` and
 * `{credentials:{...}}`.
 */
export const summarizeKiroImportPayload = (
  raw: string
): { valid: boolean; count: number; reason?: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, count: 0, reason: 'required' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: false, count: 0, reason: 'invalid_json' };
  }

  const count = countCredentialObjects(parsed, 0);
  if (count === 0) return { valid: false, count: 0, reason: 'no_credentials' };
  return { valid: true, count };
};

const countCredentialObjects = (node: unknown, depth: number): number => {
  if (depth > 4 || node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return node.reduce<number>((total, item) => total + countCredentialObjects(item, depth + 1), 0);
  }
  const record = node as Record<string, unknown>;
  if ('accounts' in record) return countCredentialObjects(record.accounts, depth + 1);
  if ('credentials' in record) return countCredentialObjects(record.credentials, depth + 1);
  return 1;
};

/**
 * parseKiroApiKeys splits an operator-supplied key list into individual keys.
 *
 * One key per line is the documented form, but comma-separated input is accepted
 * because keys are usually pasted from a spreadsheet or a chat message. Duplicates
 * are collapsed so a double paste does not create two identical credentials.
 */
export const parseKiroApiKeys = (raw: string): string[] => {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of raw.split(/[\s,]+/)) {
    const key = candidate.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
};

/**
 * buildKiroApiKeyPayload renders the key list as the credential document the
 * import endpoint accepts. The region is passed through verbatim so a blank value
 * lets the backend probe for the key's home region instead of guessing one; an
 * API key never re-probes after import, so a wrong region would be permanent.
 */
export const buildKiroApiKeyPayload = (keys: string[], region: string): string => {
  const trimmedRegion = region.trim();
  const credentials = keys.map((key) => ({
    kiroApiKey: key,
    authMethod: 'api_key',
    ...(trimmedRegion ? { region: trimmedRegion } : {}),
  }));
  return JSON.stringify(credentials.length === 1 ? credentials[0] : credentials);
};

/** Social providers Kiro accepts a bare refresh token for. */
export type KiroSocialProvider = 'Google' | 'Github';

/**
 * parseKiroRefreshTokens splits an operator-supplied refresh token list.
 *
 * Refresh tokens are long opaque strings, so only line and comma separators are
 * honoured; splitting on whitespace would corrupt a token that contains one.
 * Duplicates collapse so a double paste does not import the same account twice.
 */
export const parseKiroRefreshTokens = (raw: string): string[] => {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const candidate of raw.split(/[\r\n,]+/)) {
    const token = candidate.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
};

/**
 * buildKiroRefreshTokenPayload renders a social refresh token list as the
 * credential document the import endpoint accepts.
 *
 * Google and GitHub credentials refresh through Kiro's own endpoint, which needs
 * nothing but the refresh token, so no client credentials are sent. The backend
 * exchanges each token during import and rejects the ones that are already dead.
 */
export const buildKiroRefreshTokenPayload = (
  tokens: string[],
  provider: KiroSocialProvider
): string => {
  const credentials = tokens.map((refreshToken) => ({
    refreshToken,
    authMethod: 'social',
    provider,
  }));
  return JSON.stringify(credentials.length === 1 ? credentials[0] : credentials);
};
