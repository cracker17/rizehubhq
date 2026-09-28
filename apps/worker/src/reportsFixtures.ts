// Test fixture: one Manila day of report_facts() output.
import { emptyFacts, type DayFacts } from './reports';

export function sampleFacts(date = '2026-09-28'): DayFacts {
  const f = emptyFacts(date, '2026-09-29');
  const at = (h: number) => `${date}T0${h}:00:00+08:00`;
  f.agents = [
    { id: 'seo-1', name: 'SEO Writer 1', department: 'content' },
    { id: 'uiux-1', name: 'UI/UX Designer 1', department: 'design' },
    { id: 'qa-lead', name: 'QA Lead', department: 'qa' },
    { id: 'coo', name: 'COO', department: 'leadership' },
    { id: 'shopify-dev', name: 'Shopify Dev', department: 'dev' },
    { id: 'graphic-2', name: 'Graphic Designer 2', department: 'design' },
  ];
  f.done = [{ task_id: 't1', title: 'Bundle landing copy', agent_id: 'seo-1', client_name: 'Madam Muse', revision_count: 2 }];
  f.in_progress = [
    { task_id: 't2', title: 'Bundle wireframe', agent_id: 'uiux-1', status: 'working', client_name: 'Madam Muse' },
    { task_id: 't5', title: 'Meta descriptions', agent_id: 'seo-1', status: 'qa_pending', client_name: 'Vinyl Icons' },
  ];
  f.queued = [{ task_id: 't3', title: 'Build bundle section', agent_id: 'shopify-dev', status: 'pending', client_name: 'Madam Muse', priority: 'high' }];
  f.blocked = [{ task_id: 't4', title: 'Ad set B', agent_id: 'graphic-2', kind: 'failed', reason: 'Missing brand fonts', since: at(5), client_name: 'Vinyl Icons' }];
  f.approvals_waiting = [
    { id: 'a1', kind: 'plan', title: 'Plan: Vinyl Icons SEO report', agent_id: 'coo', created_at: at(6), type: null, priority: 'normal' },
    { id: 'a2', kind: 'external_action', title: 'Stuck: Ad set B', agent_id: 'graphic-2', created_at: at(5), type: 'task_failed', priority: 'normal' },
  ];
  f.events = [
    { actor: 'seo-1', action: 'task.submitted', task_id: 't1', task_title: 'Bundle landing copy', request_title: 'Bundle', at: at(2) },
    { actor: 'seo-1', action: 'task.submitted', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(3) },
    { actor: 'seo-1', action: 'task.submitted', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(4) },
    { actor: 'qa-lead', action: 'qa.revision', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(3) },
    { actor: 'qa-lead', action: 'qa.pass', task_id: 't1', task_title: 'Bundle landing copy', request_title: 'Bundle', at: at(2) },
    { actor: 'coo', action: 'plan.submitted', task_id: null, task_title: null, request_title: 'Vinyl Icons SEO report', at: at(6) },
    { actor: 'ea', action: 'report.morning_brief', task_id: null, task_title: null, request_title: null, at: at(8) },
  ];
  f.spend_usd = '0.4211';
  f.spend_by_actor = [{ actor: 'seo-1', usd: 0.3 }, { actor: 'uiux-1', usd: 0.1211 }];
  f.spend_by_client = [{ client_id: 'c1', name: 'Madam Muse', usd: 0.35 }];
  f.qa = { reviews: 2, passed: 1 };
  f.requests_created = 3;
  return f;
}
