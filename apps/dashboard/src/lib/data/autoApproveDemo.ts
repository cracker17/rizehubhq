import 'server-only';
// DEMO auto-approve rules, kept in server memory so Settings works without a database. Starts empty (the default:
// every plan waits for the CEO), same as a fresh LIVE install.
import { randomUUID } from 'node:crypto';
import type { AutoApproveRule, AutoApproveRuleInput } from '@rizehubhq/shared';
import { demoSnapshot } from '@/lib/mock';

let rules: AutoApproveRule[] = [];

export function demoRules() {
  const slugs = new Set(demoSnapshot().clients.map((c) => c.slug));
  return {
    list: (): AutoApproveRule[] => rules,
    save(input: AutoApproveRuleInput): AutoApproveRule[] {
      const bad = input.client_scope === 'listed' ? input.client_slugs.find((s) => !slugs.has(s)) : undefined;
      if (bad) throw new Error(`unknown client ${bad}`);
      const row: AutoApproveRule = {
        id: input.id ?? randomUUID(), name: input.name.trim(), enabled: input.enabled, max_cost_usd: input.max_cost_usd,
        max_tasks: input.max_tasks, work_types: [...new Set(input.work_types)], client_scope: input.client_scope,
        client_slugs: input.client_scope === 'listed' ? [...new Set(input.client_slugs)] : [],
        created_at: rules.find((r) => r.id === input.id)?.created_at ?? new Date().toISOString(),
      };
      if (input.id && !rules.some((r) => r.id === input.id)) throw new Error('rule not found');
      rules = input.id ? rules.map((r) => (r.id === input.id ? row : r)) : [...rules, row];
      return rules;
    },
    remove(id: string): AutoApproveRule[] {
      rules = rules.filter((r) => r.id !== id);
      return rules;
    },
  };
}
