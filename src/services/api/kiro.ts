/**
 * Kiro login and credential import API
 */

import { apiClient } from './client';

export type KiroLoginMethod = 'builder-id' | 'idc';

export interface KiroStartAuthOptions {
  method: KiroLoginMethod;
  startUrl?: string;
  region?: string;
}

export interface KiroStartAuthResponse {
  status: 'ok';
  state: string;
  method: string;
  region?: string;
  start_url?: string;
}

export interface KiroImportedCredential {
  'auth-file'?: string;
  auth_method?: string;
  provider?: string;
  email?: string;
  region?: string;
  expires_at?: string;
}

export interface KiroImportResponse {
  status: 'ok';
  count: number;
  imported: KiroImportedCredential[];
  failed?: Array<{ index?: number; message?: string }>;
}

/**
 * Device-code progress is delivered through the shared OAuth status endpoint,
 * which reports pending Kiro device flows as `device_code|<url>|<user code>`.
 */
export interface KiroDeviceCodeStatus {
  verificationUrl: string;
  userCode: string;
}

export const parseKiroDeviceCodeStatus = (value?: string): KiroDeviceCodeStatus | null => {
  if (!value || !value.startsWith('device_code|')) return null;
  const [, verificationUrl = '', userCode = ''] = value.split('|');
  if (!verificationUrl) return null;
  return { verificationUrl, userCode };
};

export const kiroApi = {
  startAuth: ({ method, startUrl, region }: KiroStartAuthOptions) => {
    const params: Record<string, string> = { method };
    if (method === 'idc') {
      if (startUrl) params.start_url = startUrl;
      if (region) params.region = region;
    }
    return apiClient.get<KiroStartAuthResponse>('/kiro-auth-url', { params });
  },

  importCredentials: (payload: string) =>
    apiClient.post<KiroImportResponse>('/kiro/import', payload, {
      headers: { 'Content-Type': 'application/json' },
    }),
};
