// Validates every agents/*.md role file and that each work_type has an SOP + QA checklist.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { config } from './config';
import { listRoleIds, loadRole } from './roles';

const roster = YAML.parse(fs.readFileSync(path.join(config.agentsDir, 'roster.yaml'), 'utf8')) as { routing: Record<string, string | string[]> };
let problems = 0;
for (const id of listRoleIds()) {
  try {
    const role = loadRole(id);
    for (const wt of role.work_types) {
      for (const dir of ['sops', 'qa-checklists']) {
        if (!fs.existsSync(path.join(config.brainDir, dir, `${wt}.md`))) { console.error(`✗ ${id}: missing brain/${dir}/${wt}.md`); problems++; }
      }
    }
    console.log(`✓ ${id.padEnd(15)} ${role.model_role.padEnd(10)} ${role.work_types.length} work types`);
  } catch (e) { console.error(`✗ ${id}: ${(e as Error).message}`); problems++; }
}
for (const [wt, owner] of Object.entries(roster.routing)) {
  for (const o of [owner].flat()) if (!fs.existsSync(path.join(config.agentsDir, `${o}.md`))) { console.error(`✗ roster ${wt} → unknown agent ${o}`); problems++; }
}
if (problems) { console.error(`${problems} problem(s)`); process.exit(1); }
console.log('All role files valid.');
