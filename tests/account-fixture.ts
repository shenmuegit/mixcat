import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexPort, NativeClientOptions } from '../src/shared/types.js';

export function accountFixture() {
  const calls: { method: string; params: any }[] = [];
  let options!: NativeClientOptions;
  let authenticated = true;
  let refreshes = 0;
  const factory = (value: NativeClientOptions): CodexPort => {
    options = value;
    const save = () => writeFileSync(join(options.home, 'auth.json'), JSON.stringify({ tokens: { access_token: `test-access-${refreshes}`, account_id: 'test-account', refresh_token: 'test-refresh-never-forwarded' } }));
    return { async connect() { save(); }, async close() {}, async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'account/read') { if (params.refreshToken) { refreshes++; save(); } return { account: authenticated ? { type: 'chatgpt', email: 'shared@example.invalid', planType: 'plus' } : null }; }
      if (method === 'account/login/start') return { authUrl: 'https://auth.openai.com/test-login' };
      return {};
    } };
  };
  return { factory, calls, get options() { return options; }, set authenticated(value: boolean) { authenticated = value; } };
}
