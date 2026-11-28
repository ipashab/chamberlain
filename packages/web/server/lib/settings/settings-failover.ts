import { z } from 'zod';
import type { SanitizedSettings, SettingsDocument } from './settings-helpers.js';

/**
 * Настройки отказоустойчивости провайдеров (lib/limit-failover): цепочка
 * запасных моделей и провайдеры с переключением аккаунтов. Пустой список —
 * осознанный выбор «без запасных моделей», поэтому сохраняется; отсутствующий
 * ключ означает, что список ни разу не сохраняли, и тогда на сервере действует
 * старая одиночная пара fallbackModel/fallbackVariant (см. DOCUMENTATION.md).
 */
export const sanitizeFailoverSettings = (
  candidate: SettingsDocument,
  result: SanitizedSettings,
  normalizeStringArray: (input: SettingsDocument[string]) => string[],
) => {
  if (Array.isArray(candidate.fallbackModels)) {
    const chainEntry = z.object({
      providerID: z.string().trim().min(1),
      modelID: z.string().trim().min(1),
      variant: z.string().trim().min(1).optional().catch(undefined),
    });
    const entries: Array<{ providerID: string; modelID: string; variant?: string }> = [];
    const seen = new Set<string>();
    for (const item of candidate.fallbackModels) {
      if (entries.length >= 8) break;
      const parsed = chainEntry.safeParse(item);
      if (!parsed.success) continue;
      const key = `${parsed.data.providerID}/${parsed.data.modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(parsed.data.variant
        ? { providerID: parsed.data.providerID, modelID: parsed.data.modelID, variant: parsed.data.variant }
        : { providerID: parsed.data.providerID, modelID: parsed.data.modelID });
    }
    result.fallbackModels = entries;
  }
  if (Array.isArray(candidate.accountSwitchProviders)) {
    result.accountSwitchProviders = normalizeStringArray(candidate.accountSwitchProviders);
  }
};
