import { useState } from 'react';
import { useDesktopVoicePreference } from '../../hooks/useDesktopVoicePreference';

export default function DesktopVoiceSettingsSection() {
  const preference = useDesktopVoicePreference();
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  return (
    <section aria-labelledby="desktop-voice-settings-heading">
      <h4 id="desktop-voice-settings-heading" className="mb-4 text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Desktop voice · Experimental
      </h4>
      <label className="flex items-center justify-between gap-4 rounded-md border border-gray-200 bg-gray-50 p-3">
        <span className="text-xs font-medium text-gray-700">Enable experimental desktop voice</span>
        <input
          type="checkbox"
          checked={preference.enabled}
          disabled={!preference.available}
          aria-describedby="desktop-voice-explanation"
          className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          onChange={event => {
            setError(null);
            try { preference.setEnabled(event.target.checked); } catch {
              setError({ key: preference.key, message: 'Could not save this preference. Voice is off for this session. Try disabling it again before reloading.' });
            }
          }}
        />
      </label>
      <p id="desktop-voice-explanation" className="mt-3 text-xs leading-5 text-gray-500">
        Off by default. Saved for this account and instance on this device; browser settings are separate.
        Enables on-demand briefings and a microphone check. Microphone access does not enable speech recognition
        in this desktop runtime; use text briefings or voice commands in a supported browser.
        Turning this off stops voice activity and hides its controls. Enabling it does not request microphone access.
      </p>
      {error && error.key === preference.key && <p role="alert" className="mt-3 text-xs text-red-600">{error.message}</p>}
    </section>
  );
}
