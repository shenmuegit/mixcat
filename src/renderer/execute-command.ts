import type { AppCommand, AppReply } from '../shared/types';

export type ExecuteOptions = { handleFailure: 'caller' };
export type Execute = (command: AppCommand, actionId?: string, options?: ExecuteOptions) => Promise<AppReply | null>;
