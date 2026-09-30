// Extra tool modules. Each module owns its own file; add new modules here with one line.
import type { ToolFactory } from './types';
import { vaultTools } from './vault';
import { rizehubTools } from './rizehub';
import { devTools } from './dev';
import { researchTools } from './research';
import { brainWriteTools } from './brainWrite';
import { salesTools } from './sales';
import { gmailTools } from './gmail';
import { calendarTools } from './calendar';
import { storageTools } from './storage';
import { memoryTools } from './memory';

// salesTools returns nothing for any role but `sales` (and the runner only exposes names listed in the role file).
// First factory wins a name: gmailTools (connected Gmail accounts) and calendarTools (connected calendars) come before
// researchTools (old placeholders).
export const TOOL_FACTORIES: ToolFactory[] = [vaultTools, rizehubTools, devTools, gmailTools, calendarTools, storageTools, researchTools, brainWriteTools, salesTools, memoryTools];
