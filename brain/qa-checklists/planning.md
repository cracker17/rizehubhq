# QA checklist: planning

Reviewed by the CEO (and COO self-check). Each check is pass/fail.

1. **Schema valid**: plan JSON has title, client_slug, summary, assumptions, questions_for_ceo, due_date, priority, estimated_cost_usd, tasks. Verify: validate against docs/05 schema.
2. **Playbook matched**: summary names the playbook used and steps follow its order. Verify: compare to `brain/playbooks/<name>.md`.
3. **Valid routing**: every `agent_id` + `work_type` pair exists in `agents/roster.yaml`; dev matches client platform. Verify: lookup.
4. **Single owner**: each task has exactly one agent and one deliverable. Verify: read titles.
5. **Size**: no task exceeds ~2 h human effort. Verify: judge scope; multi-page or multi-section tasks fail.
6. **Criteria count**: every task has 3–7 acceptance criteria. Verify: count.
7. **Criteria testable**: no criterion uses vague words (good, nice, engaging, optimized, high quality) without a measure. Verify: word scan.
8. **Inputs named**: each task lists the files/URLs/dependency keys it needs. Verify: read instructions.
9. **Dependencies correct**: no cycles; tasks without real dependency are parallel. Verify: trace `depends_on`.
10. **External steps gated**: every publish/send/merge/deploy/spend/contact step says it goes via `request_external_action`. Verify: search instructions.
11. **No invented facts**: assumptions contain no prices, dates, stats or client facts not in brain/request. Verify: cross-check.
12. **Scope checked**: out-of-scope work flagged with a proposal task. Verify: compare to workspace services.
13. **Deadline feasible**: critical path fits before due_date or summary states the risk. Verify: sum path.
