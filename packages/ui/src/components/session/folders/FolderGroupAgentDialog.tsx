// The "group agent" dialog of a session folder: pick the agent sessions
// created in the folder start on, and how eager the folder is to offer that
// agent to sessions dropped into it later.

import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_GROUP_APPLY_RULE, GROUP_APPLY_RULES, type GroupApplyRule } from '@/lib/session-groups/groupPresetsApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionGroupPresetsStore } from '@/stores/useSessionGroupPresetsStore';

interface FolderGroupAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  folderName: string;
}

const RULE_OPTION_CLASS = 'flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start transition-colors hover:bg-interactive-hover/50';

export const FolderGroupAgentDialog: React.FC<FolderGroupAgentDialogProps> = ({
  open,
  onOpenChange,
  folderId,
  folderName,
}) => {
  const { t } = useI18n();
  const agents = useConfigStore((state) => state.agents);
  const preset = useSessionGroupPresetsStore((state) => state.presets[folderId]);
  const setFolderPreset = useSessionGroupPresetsStore((state) => state.setFolderPreset);
  const clearFolderPreset = useSessionGroupPresetsStore((state) => state.clearFolderPreset);

  const [agentDraft, setAgentDraft] = React.useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = React.useState<GroupApplyRule>(DEFAULT_GROUP_APPLY_RULE);

  const currentAgent = preset?.defaultAgent ?? null;
  const currentRule = preset?.applyRule ?? DEFAULT_GROUP_APPLY_RULE;

  React.useEffect(() => {
    // Drafts reset to the stored preset every time the dialog opens; the
    // stored values are part of the deps so an external change also resets.
    if (open) {
      setAgentDraft(currentAgent);
      setRuleDraft(currentRule);
    }
  }, [open, currentAgent, currentRule]);

  const selectableAgents = agents.filter((agent) => agent.mode !== 'subagent' && !agent.hidden);

  const handleSave = () => {
    if (agentDraft) {
      setFolderPreset(folderId, agentDraft, ruleDraft);
    } else {
      clearFolderPreset(folderId);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.groupPreset.dialogTitle', { folderName })}</DialogTitle>
          <DialogDescription>
            {t('sessions.sidebar.groupPreset.dialogDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {selectableAgents.length === 0
            ? <p className="text-sm text-muted-foreground">{t('sessions.sidebar.groupPreset.noAgents')}</p>
            : (
              <select
                value={agentDraft ?? ''}
                onChange={(event) => setAgentDraft(event.target.value || null)}
                aria-label={t('sessions.sidebar.groupPreset.agentSelectAria')}
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
              >
                <option value="">{t('sessions.sidebar.groupPreset.agentNone')}</option>
                {selectableAgents.map((agent) => (
                  <option key={agent.name} value={agent.name}>{agent.displayName}</option>
                ))}
              </select>
            )}

          <div className="flex flex-col gap-1.5 pt-1" role="radiogroup" aria-label={t('sessions.sidebar.groupPreset.ruleGroupAria')}>
            {GROUP_APPLY_RULES.map((rule) => (
              <button
                key={rule}
                type="button"
                role="radio"
                aria-checked={ruleDraft === rule}
                disabled={!agentDraft}
                onClick={() => setRuleDraft(rule)}
                className={`${RULE_OPTION_CLASS} ${ruleDraft === rule ? 'border-primary/50 bg-primary/10' : 'border-border'} disabled:opacity-50`}
              >
                <span className="text-sm font-medium">{t(`sessions.sidebar.groupPreset.rule.${rule}`)}</span>
                <span className="text-xs text-muted-foreground">{t(`sessions.sidebar.groupPreset.rule.${rule}Description`)}</span>
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={selectableAgents.length === 0}>
            {t('sessions.sidebar.groupPreset.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
