import { describe, expect, it } from 'vitest';
import type { MilestoneTemplateRecord } from '../../../api/types';
import { buildNodeFromTemplate, serializeSla } from '../workflowModels';

// Template default SLA (what the editor falls back to for fields the step does not override).
const template = {
  templateId: 'TMPL_FULFILLMENT_SHIP',
  definition: {
    defaultSla: { mode: 'STATIC', warning: '72h', jeopardy: '96h', hardMax: '7d', expected: '48h' },
  },
} as unknown as MilestoneTemplateRecord;

describe('SLA round-trip (open + save must not change semantics)', () => {
  it('keeps percentage thresholds for ML steps instead of writing template durations', () => {
    // Shipped config for the iPhone ship-to-home step S4
    const stored = {
      mode: 'ML_PREDICTED',
      modelId: 'fulfillment_ship_xgb_aft_v1.onnx',
      hardMin: '6h',
      hardMax: '7d',
      fallbackExpected: '48h',
      warningPct: 80,
      jeopardyPct: 95,
    };
    const node = buildNodeFromTemplate(template, 'S4', 'iPhone Ship-to-Home Delivery', ['S3'], stored);

    expect(node.sla.usesPctThresholds).toBe(true);
    const saved = serializeSla(node.sla);
    expect(saved.warningPct).toBe(80);
    expect(saved.jeopardyPct).toBe(95);
    expect(saved).not.toHaveProperty('warning');
    expect(saved).not.toHaveProperty('jeopardy');
    expect(saved).not.toHaveProperty('extra');
    expect(saved).not.toHaveProperty('usesPctThresholds');
  });

  it('preserves keys the editor does not model', () => {
    const stored = {
      mode: 'ML_PREDICTED',
      hardMax: '35d',
      warning: '24d',
      jeopardy: '30d',
      rightCensoredSurvival: true,
      someFutureFlag: { a: 1 },
    };
    const saved = serializeSla(buildNodeFromTemplate(template, 'T3', 'Mail-Back', [], stored).sla);
    expect(saved.rightCensoredSurvival).toBe(true);
    expect(saved.someFutureFlag).toEqual({ a: 1 });
    expect(saved.warning).toBe('24d');
  });

  it('switches to fixed thresholds only when the admin types one', () => {
    const stored = { mode: 'ML_PREDICTED', hardMax: '7d', warningPct: 80, jeopardyPct: 95 };
    const node = buildNodeFromTemplate(template, 'S4', 'Ship', [], stored);
    const edited = { ...node.sla, warning: '60h', usesPctThresholds: false };
    const saved = serializeSla(edited);
    expect(saved.warning).toBe('60h');
    expect(saved).not.toHaveProperty('warningPct');
    expect(saved).not.toHaveProperty('jeopardyPct');
  });
});
