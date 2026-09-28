// Extra tool modules. Each module owns its own file; add new modules here with one line.
import type { ToolFactory } from './types';
import { vaultTools } from './vault';
import { rizehubTools } from './rizehub';
import { devTools } from './dev';
import { researchTools } from './research';

export const TOOL_FACTORIES: ToolFactory[] = [vaultTools, rizehubTools, devTools, researchTools];
