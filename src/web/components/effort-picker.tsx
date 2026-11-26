import { useState } from 'react';
import { Brain } from 'lucide-react';
import type { ModelEffort } from '../../shared/models';
import { useModels } from '../hooks/use-models';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import type { ModelsResponse } from '../../shared/models';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { Button } from './ui';

const effortNames: Record<ModelEffort | 'auto', string> = {
  auto: 'Auto',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

// Matches the runtime policy: resolves per request from the turn's size
// and the connection's learned quotas, never above the provider default.
const autoHint = 'Lighter on simple requests, never above default';

export function EffortPicker() {
  const models = useModels();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selection = models.data?.selection;
  const connection = models.data?.connections.find((item) => item.id === selection?.connectionId);
  const model = connection?.models.find((item) => item.id === selection?.modelId);
  const efforts = model?.efforts ?? [];
  if (!selection || !model || efforts.length < 2) return null;

  async function choose(effort: ModelEffort | 'auto') {
    if (!selection || saving || effort === selection.effort) return;
    setSaving(true);
    setError('');
    try {
      const result = await api<ModelsResponse>('/api/models/selection', {
        method: 'PUT',
        body: JSON.stringify({
          connectionId: selection.connectionId,
          modelId: selection.modelId,
          effort,
        }),
      });
      pageDataCache.update('/api/models', () => result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ActionMenu
      label={`Thinking level: ${effortNames[selection.effort] ?? selection.effort}`}
      side="top"
      disabled={models.busy || saving}
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className="effort-picker-toggle"
          disabled={models.busy || saving}
          title={error || `Thinking level: ${effortNames[selection.effort] ?? selection.effort}`}
          aria-label={`Thinking level: ${effortNames[selection.effort] ?? selection.effort}`}
        >
          <Brain size={16} aria-hidden="true" />
        </Button>
      }
    >
      {(close) => (
        <>
          <ActionMenuItem
            checked={selection.effort === 'auto'}
            textValue={`Auto - ${autoHint}`}
            onClick={() => {
              close();
              void choose('auto');
            }}
          >
            Auto
            <span className="effort-picker-hint">{autoHint}</span>
          </ActionMenuItem>
          {efforts.map((effort) => (
            <ActionMenuItem
              key={effort}
              checked={effort === selection.effort}
              textValue={effortNames[effort] ?? effort}
              onClick={() => {
                close();
                void choose(effort);
              }}
            >
              {effortNames[effort] ?? effort}
            </ActionMenuItem>
          ))}
        </>
      )}
    </ActionMenu>
  );
}
