import type { ToolSet } from 'ai';
import type { ToolContext } from '../runner';

/** A tool module returns real implementations for some tool names (keys = names used in role files). */
export type ToolFactory = (ctx: ToolContext) => ToolSet;
