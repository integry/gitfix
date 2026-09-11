import { useEffect, useState } from 'react';
import { PREVIEW_STORAGE_V1_DEFAULTS, type ManagedPreviewStorageStatus } from '@propr/shared';
import { getManagedPreviewStorageStatus } from '../../api/previewStorageApi';

const descriptions = {
  enabled: 'ProPR Connect stores full-resolution preview originals. GitHub attachments continue to publish as usual.',
  plus_required: 'Managed storage requires ProPR Plus. This installation continues to publish previews through GitHub.',
  disabled: 'Managed storage is disabled by ProPR Connect. GitHub attachment publication remains available.',
  unavailable: 'Managed storage is unavailable. Connect may be offline or may not support preview storage yet. Previews continue through GitHub.',
};
const labels = { enabled: 'Enabled', plus_required: 'Plus required', disabled: 'Disabled', unavailable: 'Unavailable' };
function bytes(value: number): string {
  if (value >= 1024 ** 3) return `${Number((value / 1024 ** 3).toFixed(2))} GiB`;
  if (value >= 1024 ** 2) return `${Number((value / 1024 ** 2).toFixed(2))} MiB`;
  return `${value} bytes`;
}

export default function ManagedPreviewStorageSection() {
  const [status, setStatus] = useState<ManagedPreviewStorageStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let active = true;
    void getManagedPreviewStorageStatus().then(value => { if (active) setStatus(value); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setRefreshing(true);
    try { setStatus(await getManagedPreviewStorageStatus()); }
    finally { setRefreshing(false); }
  };
  const values = status?.effective ?? PREVIEW_STORAGE_V1_DEFAULTS;
  return (
    <section aria-labelledby="managed-preview-storage-heading" className="mt-6 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between gap-3">
        <h4 id="managed-preview-storage-heading" className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Managed preview storage</h4>
        <span className={`text-[11px] ${status?.enabled ? 'text-green-700' : 'text-amber-700'}`} role="status">
          {status ? labels[status.state] : 'Loading…'}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-gray-600">{status ? descriptions[status.state] : 'Checking ProPR Connect storage availability…'}</p>
      <dl className="mt-3 grid grid-cols-1 gap-3 rounded border border-gray-200 bg-gray-50 p-3 text-xs sm:grid-cols-3">
        <div><dt className="text-gray-500">Installation quota</dt><dd className="mt-1 font-medium text-gray-900">{bytes(values.quotaBytes)}</dd></div>
        <div><dt className="text-gray-500">Maximum original size</dt><dd className="mt-1 font-medium text-gray-900">{bytes(values.maxObjectBytes)}</dd></div>
        <div><dt className="text-gray-500">Retention</dt><dd className="mt-1 font-medium text-gray-900">{values.retentionDays} days</dd></div>
      </dl>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-gray-500">{status?.effective ? 'Effective limits reported by ProPR Connect.' : 'Standard Plus limits shown; effective limits are currently unavailable.'}</p>
        <button type="button" disabled={refreshing || !status} onClick={() => void refresh()} className="shrink-0 text-xs text-gray-600 underline disabled:opacity-50">{refreshing ? 'Refreshing…' : 'Refresh status'}</button>
      </div>
    </section>
  );
}
