-- Claude Agent SDK runtime (docs/05 "Claude runtime"): agents.runtime may now also be 'claude'.
-- Mirrors AGENT_RUNTIME in packages/shared/src/status.ts. No agent is switched here: every agent keeps its runtime;
-- the CEO opts one in by editing its role file + agents/roster.yaml (and this column) once an Anthropic API key and a
-- monthly budget are set.
alter table agents drop constraint if exists agents_runtime_check;
alter table agents add constraint agents_runtime_check check (runtime in ('worker', 'hermes', 'claude'));
