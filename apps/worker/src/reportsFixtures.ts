// Test fixture: one Manila day of report_facts() output.
import { emptyFacts, type DayFacts } from './reports';

export function sampleFacts(date = '2026-09-28'): DayFacts {
  const f = emptyFacts(date, '2026-09-29');
  const at = (h: number) => `${date}T0${h}:00:00+08:00`;
  f.agents = [
    { id: 'writer', name: 'Content Writer', department: 'content' },
    { id: 'designer', name: 'Graphic Designer', department: 'design' },
    { id: 'qa-lead', name: 'QA', department: 'qa' },
    { id: 'coo', name: 'COO', department: 'leadership' },
    { id: 'web-dev', name: 'Web Developer', department: 'dev' },
    { id: 'sales', name: 'Sales Agent', department: 'growth' },
  ];
  f.done = [{ task_id: 't1', title: 'Bundle landing copy', agent_id: 'writer', client_name: 'Madam Muse', revision_count: 2 }];
  f.in_progress = [
    { task_id: 't2', title: 'Bundle wireframe', agent_id: 'designer', status: 'working', client_name: 'Madam Muse' },
    { task_id: 't5', title: 'Meta descriptions', agent_id: 'writer', status: 'qa_pending', client_name: 'Vinyl Icons' },
  ];
  f.queued = [{ task_id: 't3', title: 'Build bundle section', agent_id: 'web-dev', status: 'pending', client_name: 'Madam Muse', priority: 'high' }];
  f.blocked = [{ task_id: 't4', title: 'Ad set B', agent_id: 'designer', kind: 'failed', reason: 'Missing brand fonts', since: at(5), client_name: 'Vinyl Icons' }];
  f.approvals_waiting = [
    { id: 'a1', kind: 'plan', title: 'Plan: Vinyl Icons SEO report', agent_id: 'coo', created_at: at(6), type: null, priority: 'normal' },
    { id: 'a2', kind: 'external_action', title: 'Stuck: Ad set B', agent_id: 'designer', created_at: at(5), type: 'task_failed', priority: 'normal' },
  ];
  f.events = [
    { actor: 'writer', action: 'task.submitted', task_id: 't1', task_title: 'Bundle landing copy', request_title: 'Bundle', at: at(2) },
    { actor: 'writer', action: 'task.submitted', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(3) },
    { actor: 'writer', action: 'task.submitted', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(4) },
    { actor: 'qa-lead', action: 'qa.revision', task_id: 't5', task_title: 'Meta descriptions', request_title: 'SEO', at: at(3) },
    { actor: 'qa-lead', action: 'qa.pass', task_id: 't1', task_title: 'Bundle landing copy', request_title: 'Bundle', at: at(2) },
    { actor: 'coo', action: 'plan.submitted', task_id: null, task_title: null, request_title: 'Vinyl Icons SEO report', at: at(6) },
    { actor: 'coo', action: 'report.morning_brief', task_id: null, task_title: null, request_title: null, at: at(8) },
  ];
  f.spend_usd = '0.4211';
  f.spend_by_actor = [{ actor: 'writer', usd: 0.3 }, { actor: 'designer', usd: 0.1211 }];
  f.spend_by_client = [{ client_id: 'c1', name: 'Madam Muse', usd: 0.35 }];
  f.qa = { reviews: 2, passed: 1 };
  f.requests_created = 3;
  return f;
}
