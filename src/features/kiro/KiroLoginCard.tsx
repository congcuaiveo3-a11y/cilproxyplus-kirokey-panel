import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { oauthApi } from '@/services/api';
import { kiroApi, type KiroImportedCredential } from '@/services/api/kiro';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage } from '@/utils/helpers';
import { useNotificationStore } from '@/stores';
import {
  buildKiroApiKeyPayload,
  classifyKiroPoll,
  parseKiroApiKeys,
  summarizeKiroImportPayload,
  validateKiroRegion,
  validateKiroStartUrl,
  type KiroDeviceCode,
  type KiroLoginMethod,
} from './kiroLogin';
import iconKiro from '@/assets/icons/kiro.svg';
import styles from './KiroLoginCard.module.scss';

const POLL_INTERVAL_MS = 3000;
const DEFAULT_REGION = 'us-east-1';

interface LoginState {
  method: KiroLoginMethod;
  startUrl: string;
  region: string;
  state?: string;
  polling: boolean;
  deviceCode?: KiroDeviceCode;
  status?: 'waiting' | 'success' | 'error';
  error?: string;
}

interface ImportState {
  payload: string;
  loading: boolean;
  error?: string;
  imported?: KiroImportedCredential[];
}

interface ApiKeyState {
  keys: string;
  region: string;
  loading: boolean;
  error?: string;
  imported?: KiroImportedCredential[];
}

/**
 * KiroLoginCard drives the Kiro management login and credential import flows.
 *
 * Kiro needs a dedicated card rather than a generic provider card because the
 * backend requires a method choice, and IAM Identity Center additionally needs a
 * start URL and region that no other provider collects.
 */
export function KiroLoginCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showNotification } = useNotificationStore();
  const [login, setLogin] = useState<LoginState>({
    method: 'builder-id',
    startUrl: '',
    region: '',
    polling: false,
  });
  const [importState, setImportState] = useState<ImportState>({ payload: '', loading: false });
  const [apiKeyState, setApiKeyState] = useState<ApiKeyState>({
    keys: '',
    region: '',
    loading: false,
  });
  const pollTimer = useRef<number | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== undefined) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const methodOptions = [
    { value: 'builder-id', label: t('kiro_login.method_builder_id') },
    { value: 'idc', label: t('kiro_login.method_idc') },
  ];

  const startPolling = useCallback(
    (state: string) => {
      stopPolling();
      pollTimer.current = window.setInterval(async () => {
        try {
          const outcome = classifyKiroPoll(await oauthApi.getAuthStatus(state));
          switch (outcome.kind) {
            case 'device_code':
              setLogin((prev) =>
                prev.state === state ? { ...prev, deviceCode: outcome.deviceCode } : prev
              );
              break;
            case 'success':
              stopPolling();
              notifyAuthFilesChanged();
              setLogin((prev) =>
                prev.state === state
                  ? { ...prev, polling: false, status: 'success', deviceCode: undefined }
                  : prev
              );
              showNotification(t('kiro_login.status_success'), 'success');
              break;
            case 'error':
              stopPolling();
              setLogin((prev) =>
                prev.state === state
                  ? { ...prev, polling: false, status: 'error', error: outcome.message }
                  : prev
              );
              showNotification(`${t('kiro_login.status_error')} ${outcome.message}`, 'error');
              break;
            case 'pending':
              break;
          }
        } catch (err: unknown) {
          stopPolling();
          setLogin((prev) =>
            prev.state === state
              ? { ...prev, polling: false, status: 'error', error: getErrorMessage(err) }
              : prev
          );
        }
      }, POLL_INTERVAL_MS);
    },
    [showNotification, stopPolling, t]
  );

  const startLogin = async () => {
    if (login.method === 'idc') {
      const startUrl = validateKiroStartUrl(login.startUrl);
      if (!startUrl.valid) {
        showNotification(t('kiro_login.start_url_invalid'), 'warning');
        return;
      }
      if (!validateKiroRegion(login.region)) {
        showNotification(t('kiro_login.region_invalid'), 'warning');
        return;
      }
    }

    stopPolling();
    setLogin((prev) => ({
      ...prev,
      polling: true,
      status: 'waiting',
      error: undefined,
      deviceCode: undefined,
      state: undefined,
    }));

    try {
      const res = await kiroApi.startAuth({
        method: login.method,
        startUrl: login.startUrl.trim() || undefined,
        region: login.region.trim() || undefined,
      });
      if (!res.state) {
        setLogin((prev) => ({
          ...prev,
          polling: false,
          status: 'error',
          error: t('kiro_login.missing_state'),
        }));
        showNotification(t('kiro_login.missing_state'), 'error');
        return;
      }
      setLogin((prev) => ({ ...prev, state: res.state, polling: true, status: 'waiting' }));
      startPolling(res.state);
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setLogin((prev) => ({ ...prev, polling: false, status: 'error', error: message }));
      showNotification(`${t('kiro_login.start_error')} ${message}`, 'error');
    }
  };

  const cancelLogin = async () => {
    stopPolling();
    const state = login.state;
    setLogin((prev) => ({
      ...prev,
      polling: false,
      status: undefined,
      deviceCode: undefined,
      state: undefined,
      error: undefined,
    }));
    if (!state) return;
    try {
      await oauthApi.cancelAuthSession(state);
    } catch {
      // Cancellation is best-effort: the session also expires on its own.
    }
  };

  const copyValue = async (value: string) => {
    const copied = await copyToClipboard(value);
    showNotification(
      t(copied ? 'notification.link_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  const runImport = async () => {
    const summary = summarizeKiroImportPayload(importState.payload);
    if (!summary.valid) {
      const message =
        summary.reason === 'invalid_json'
          ? t('kiro_login.import_invalid_json')
          : t('kiro_login.import_required');
      setImportState((prev) => ({ ...prev, error: message }));
      showNotification(message, 'warning');
      return;
    }

    setImportState((prev) => ({ ...prev, loading: true, error: undefined, imported: undefined }));
    try {
      const res = await kiroApi.importCredentials(importState.payload.trim());
      setImportState({ payload: '', loading: false, imported: res.imported });
      notifyAuthFilesChanged();
      showNotification(t('kiro_login.import_success', { count: res.count }), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setImportState((prev) => ({ ...prev, loading: false, error: message }));
      showNotification(`${t('kiro_login.import_error')} ${message}`, 'error');
    }
  };

  const runApiKeyImport = async () => {
    const keys = parseKiroApiKeys(apiKeyState.keys);
    if (keys.length === 0) {
      const message = t('kiro_login.api_key_required');
      setApiKeyState((prev) => ({ ...prev, error: message }));
      showNotification(message, 'warning');
      return;
    }
    if (!validateKiroRegion(apiKeyState.region)) {
      showNotification(t('kiro_login.region_invalid'), 'warning');
      return;
    }

    setApiKeyState((prev) => ({ ...prev, loading: true, error: undefined, imported: undefined }));
    try {
      const res = await kiroApi.importCredentials(
        buildKiroApiKeyPayload(keys, apiKeyState.region)
      );
      setApiKeyState({ keys: '', region: '', loading: false, imported: res.imported });
      notifyAuthFilesChanged();
      showNotification(t('kiro_login.api_key_success', { count: res.count }), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      setApiKeyState((prev) => ({ ...prev, loading: false, error: message }));
      showNotification(`${t('kiro_login.api_key_error')} ${message}`, 'error');
    }
  };

  return (
    <Card
      title={
        <span className={styles.cardTitle}>
          <img src={iconKiro} alt="" className={styles.cardTitleIcon} />
          <span>{t('kiro_login.title')}</span>
        </span>
      }
      extra={
        <Button onClick={startLogin} loading={login.polling}>
          {login.status === 'success'
            ? t('kiro_login.login_another_account')
            : t('kiro_login.start_button')}
        </Button>
      }
    >
      <div className={styles.cardContent}>
        <div className={styles.hint}>{t('kiro_login.hint')}</div>

        <div className={styles.methodRow}>
          <div className={styles.methodField}>
            <label className={styles.fieldLabel} htmlFor="kiro-method">
              {t('kiro_login.method_label')}
            </label>
            <Select
              id="kiro-method"
              value={login.method}
              options={methodOptions}
              onChange={(value) =>
                setLogin((prev) => ({ ...prev, method: value as KiroLoginMethod }))
              }
              fullWidth
            />
          </div>
        </div>

        {login.method === 'idc' && (
          <div className={styles.methodRow}>
            <div className={styles.methodField}>
              <Input
                label={t('kiro_login.start_url_label')}
                hint={t('kiro_login.start_url_hint')}
                placeholder="https://my-tenant.awsapps.com/start"
                value={login.startUrl}
                onChange={(e) => setLogin((prev) => ({ ...prev, startUrl: e.target.value }))}
              />
            </div>
            <div className={styles.methodField}>
              <Input
                label={t('kiro_login.region_label')}
                hint={t('kiro_login.region_hint', { region: DEFAULT_REGION })}
                placeholder={DEFAULT_REGION}
                value={login.region}
                onChange={(e) => setLogin((prev) => ({ ...prev, region: e.target.value }))}
              />
            </div>
          </div>
        )}

        {login.deviceCode && (
          <div className={styles.deviceBox}>
            <div className={styles.deviceLabel}>{t('kiro_login.device_code_label')}</div>
            <div className={styles.userCode}>{login.deviceCode.userCode}</div>
            <div className={styles.deviceLabel}>{t('kiro_login.verification_url_label')}</div>
            <div className={styles.deviceValue}>{login.deviceCode.verificationUrl}</div>
            <div className={styles.deviceActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  window.open(login.deviceCode!.verificationUrl, '_blank', 'noopener,noreferrer')
                }
              >
                {t('kiro_login.open_link')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => copyValue(login.deviceCode!.verificationUrl)}
              >
                {t('kiro_login.copy_link')}
              </Button>
              {login.deviceCode.userCode && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => copyValue(login.deviceCode!.userCode)}
                >
                  {t('kiro_login.copy_code')}
                </Button>
              )}
            </div>
          </div>
        )}

        {login.status === 'waiting' && (
          <div className="status-badge">{t('kiro_login.status_waiting')}</div>
        )}
        {login.status === 'success' && (
          <div className="status-badge success">{t('kiro_login.status_success')}</div>
        )}
        {login.status === 'error' && (
          <div className="status-badge error">
            {t('kiro_login.status_error')} {login.error || ''}
          </div>
        )}

        {login.polling && (
          <div className={styles.deviceActions}>
            <Button variant="secondary" size="sm" onClick={cancelLogin}>
              {t('kiro_login.cancel_button')}
            </Button>
          </div>
        )}

        {login.status === 'success' && (
          <div className={styles.deviceActions}>
            <Button variant="secondary" size="sm" onClick={() => navigate('/auth-files')}>
              {t('kiro_login.view_auth_files')}
            </Button>
          </div>
        )}

        <div>
          <label className={styles.fieldLabel} htmlFor="kiro-import-payload">
            {t('kiro_login.import_label')}
          </label>
          <textarea
            id="kiro-import-payload"
            className={styles.importArea}
            value={importState.payload}
            spellCheck={false}
            placeholder={t('kiro_login.import_placeholder')}
            onChange={(e) =>
              setImportState((prev) => ({ ...prev, payload: e.target.value, error: undefined }))
            }
          />
          <div className={styles.hint}>{t('kiro_login.import_hint')}</div>
          <div className={styles.importActions}>
            <Button variant="secondary" size="sm" onClick={runImport} loading={importState.loading}>
              {t('kiro_login.import_button')}
            </Button>
          </div>
          {importState.error && <div className="status-badge error">{importState.error}</div>}
          {importState.imported && importState.imported.length > 0 && (
            <div className={styles.resultList}>
              {importState.imported.map((item, index) => (
                <div className={styles.resultItem} key={item['auth-file'] ?? index}>
                  <span className={styles.resultKey}>{item.auth_method}</span>
                  <span>{item.email || item.provider}</span>
                  <span className={styles.resultKey}>{item['auth-file']}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className={styles.fieldLabel} htmlFor="kiro-api-keys">
            {t('kiro_login.api_key_label')}
          </label>
          <textarea
            id="kiro-api-keys"
            className={styles.importArea}
            value={apiKeyState.keys}
            spellCheck={false}
            placeholder={t('kiro_login.api_key_placeholder')}
            onChange={(e) =>
              setApiKeyState((prev) => ({ ...prev, keys: e.target.value, error: undefined }))
            }
          />
          <div className={styles.methodRow}>
            <div className={styles.methodField}>
              <Input
                label={t('kiro_login.api_key_region_label')}
                hint={t('kiro_login.api_key_region_hint')}
                placeholder={t('kiro_login.api_key_region_placeholder')}
                value={apiKeyState.region}
                onChange={(e) => setApiKeyState((prev) => ({ ...prev, region: e.target.value }))}
              />
            </div>
          </div>
          <div className={styles.hint}>{t('kiro_login.api_key_hint')}</div>
          <div className={styles.importActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={runApiKeyImport}
              loading={apiKeyState.loading}
            >
              {t('kiro_login.api_key_button')}
            </Button>
          </div>
          {apiKeyState.error && <div className="status-badge error">{apiKeyState.error}</div>}
          {apiKeyState.imported && apiKeyState.imported.length > 0 && (
            <div className={styles.resultList}>
              {apiKeyState.imported.map((item, index) => (
                <div className={styles.resultItem} key={item['auth-file'] ?? index}>
                  <span className={styles.resultKey}>{item.auth_method}</span>
                  <span>{item.region}</span>
                  <span className={styles.resultKey}>{item['auth-file']}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
