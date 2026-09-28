// Validates every agents/*.md role file, that each work_type has an SOP + QA checklist, and that roster.yaml
// (agents + routing) matches the role files exactly.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { readRoster } from './deps';
import { listRoleIds, loadRole, type Role } from './roles';

const roster = readRoster(config.agentsDir);
let problems = 0;
const fail = (msg: string) => { console.error(`✗ ${msg}`); problems++; };
const roles = new Map<string, Role>();

for (const id of listRoleIds()) {
  try {
    const role = loadRole(id);
    roles.set(id, role);
    for (const wt of role.work_types) {
      for (const dir of ['sops', 'qa-checklists']) {
        if (!fs.existsSync(path.join(config.brainDir, dir, `${wt}.md`))) fail(`${id}: missing brain/${dir}/${wt}.md`);
      }
    }
    console.log(`✓ ${id.padEnd(10)} ${role.model_role.padEnd(7)} ${role.runtime.padEnd(7)} ${role.work_types.length} work types`);
  } catch (e) { fail(`${id}: ${(e as Error).message}`); }
}

// roster.agents ↔ role files (same ids, same runtime/model_role/department)
const listed = roster.agents ?? {};
for (const [id, meta] of Object.entries(listed)) {
  const role = roles.get(id);
  if (!role) { fail(`roster agents: ${id} has no agents/${id}.md`); continue; }
  for (const k of ['runtime', 'model_role', 'department', 'name'] as const) {
    if (meta[k] !== undefined && meta[k] !== role[k]) fail(`roster agents: ${id}.${k} is "${meta[k]}" but the role file says "${role[k]}"`);
  }
}
for (const id of roles.keys()) if (!(id in listed)) fail(`roster agents: agents/${id}.md is not listed in roster.yaml`);

// routing: every owner exists and lists the work type; every role work type is routed to that role
for (const [wt, owner] of Object.entries(roster.routing)) {
  for (const o of [owner].flat()) {
    const role = roles.get(o);
    if (!role) fail(`roster ${wt} → unknown agent ${o}`);
    else if (!role.work_types.includes(wt)) fail(`roster ${wt} → ${o}, but agents/${o}.md does not list ${wt} in work_types`);
  }
}
for (const [id, role] of roles) {
  for (const wt of role.work_types) if (![roster.routing[wt] ?? []].flat().includes(id)) fail(`${id}: work_type ${wt} is not routed to ${id} in roster.yaml`);
}
for (const [platform, dev] of Object.entries(roster.platform_to_dev ?? {})) if (!roles.has(dev)) fail(`platform_to_dev ${platform} → unknown agent ${dev}`);
for (const [k, qa] of Object.entries(roster.qa ?? {})) if (!roles.has(qa)) fail(`qa ${k} → unknown agent ${qa}`);

if (problems) { console.error(`${problems} problem(s)`); process.exit(1); }
console.log(`All ${roles.size} role files valid.`);
