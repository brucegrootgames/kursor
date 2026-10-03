import type { AppState, Block } from '../shared/protocol';

export type TextBlock = Extract<Block, { type: 'text' }>;
export type ThinkingBlock = Extract<Block, { type: 'thinking' }>;
export type ToolBlock = Extract<Block, { type: 'tool' }>;
export type PermissionBlock = Extract<Block, { type: 'permission' }>;
export type QuestionBlock = Extract<Block, { type: 'question' }>;
export type PlanBlock = Extract<Block, { type: 'plan' }>;
export type TodoBlock = Extract<Block, { type: 'todo' }>;
export type Density = AppState['settings']['toolCallDensity'];
