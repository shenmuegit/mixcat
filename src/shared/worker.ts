import type { CommandEnvelope } from './types.js';

export interface CoreWorkerRequest { id: string; envelope?: CommandEnvelope; inspectId?: string; shutdown?: boolean; systemEvent?: 'power-resume'; }
