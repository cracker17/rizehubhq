-- Outbound sales emails are external actions: they are never auto-approved (CLAUDE.md rule 4).
-- Removes the OUTREACH_AUTO_APPROVE_FOLLOW_UPS path: sales_request_email_approval always leaves the approval pending.
create or replace function sales_request_email_approval(p_email uuid, p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e lead_emails; l leads; aid uuid; auto boolean; t text;
begin
  perform hq_guard();
  select * into e from lead_emails where id = p_email for update;
  if e.id is null or e.direction <> 'out' then raise exception 'outbound email % not found', p_email; end if;
  if e.status <> 'draft' then raise exception 'email is % (only drafts can be queued)', e.status; end if;
  select * into l from leads where id = e.lead_id;
  auto := false; -- every outbound email waits for the CEO (p_auto is ignored; kept for signature compatibility)
  t := left(case e.kind when 'reply' then 'Reply to ' when 'proposal' then 'Proposal to ' when 'follow_up' then 'Follow-up #' || coalesce(e.follow_up_number, 1) || ' to '
                        else 'Email to ' end || l.business_name || ' · ' || e.subject, 200);
  insert into approvals (kind, task_id, request_id, agent_id, title, summary, payload, status, decided_at, ceo_note)
  values ('external_action', e.task_id, (select request_id from tasks where id = e.task_id), 'sales', t,
          'To ' || e.to_email || case when e.needs_explicit_approval then ' · flagged: ' || array_to_string(e.flags, ', ') else '' end,
          jsonb_build_object('type', 'external_action', 'action_type', 'sales.email', 'auto_approved', auto,
                             'spec', jsonb_build_object('executor', 'worker', 'description', 'Send this email to ' || e.to_email || ' (' || l.business_name || ')',
                                                        'emails', jsonb_build_array(jsonb_build_object(
                                                          'email_id', e.id, 'lead_id', l.id, 'business_name', l.business_name, 'website', l.website,
                                                          'to', e.to_email, 'contact_name', l.contact_name, 'kind', e.kind, 'follow_up_number', e.follow_up_number,
                                                          'subject', e.subject, 'body', e.body, 'flags', to_jsonb(e.flags),
                                                          'needs_explicit_approval', e.needs_explicit_approval)))),
          case when auto then 'approved'::approval_status else 'pending'::approval_status end,
          case when auto then now() end,
          case when auto then 'Auto-approved follow-up (OUTREACH_AUTO_APPROVE_FOLLOW_UPS=true)' end)
  returning id into aid;
  update lead_emails set status = case when auto then 'approved' else 'pending_approval' end, approval_id = aid where id = e.id;
  perform hq_log('sales', 'action.requested', null, e.task_id, jsonb_build_object('approval_id', aid, 'action_type', 'sales.email', 'auto', auto, 'email_id', e.id));
  perform refresh_agent_status('sales');
  return jsonb_build_object('approval_id', aid, 'auto_approved', auto, 'status', case when auto then 'approved' else 'pending_approval' end);
end $$;
