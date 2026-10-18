import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsSection,
  SettingsFieldRow,
  SETTINGS_ICON_BUTTON_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';

// Which Python the debug panel runs. Set once here; the panel and the editor
// gutter pick it up, and an empty value lets each project's .venv win.
export const PythonDebugSettings: React.FC = () => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopSettings().then((data) => {
      if (cancelled || data == null) {
        return;
      }
      setValue(data.pythonInterpreter ?? '');
    }).catch(() => {
      // A settings read failure keeps the field empty; saving still works.
    }).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowse = React.useCallback(async () => {
    if (!isDesktopShell()) {
      return;
    }
    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setValue(selected.path.trim());
      }
    } catch {
      // A cancelled or failed dialog leaves the field as it was.
    }
  }, []);

  const handleBlur = React.useCallback(() => {
    void updateDesktopSettings({ pythonInterpreter: value.trim() });
  }, [value]);

  return (
    <SettingsSection settingsItem="debug.python" title={t('debug.settings.section')}>
      <SettingsFieldRow
        settingsItem="debug.python.interpreter"
        label={t('debug.launch.pythonPath')}
        description={t('debug.settings.pythonInterpreter.description')}
        alignEnd={false}
        controlClassName="@xl:w-[20rem]"
      >
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={handleBlur}
          placeholder={t('debug.settings.pythonInterpreter.placeholder')}
          disabled={isLoading}
          className="h-8 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleBrowse}
          disabled={isLoading || !isDesktopShell()}
          className={SETTINGS_ICON_BUTTON_CLASS}
          aria-label={t('settings.openchamber.opencodeCli.actions.browseAria')}
          title={t('settings.openchamber.opencodeCli.actions.browse')}
        >
          <Icon name="folder" className="h-4 w-4" />
        </Button>
      </SettingsFieldRow>
    </SettingsSection>
  );
};
