import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installAccountFixture(fixture, safe) {
  writeFileSync(safe(join(fixture, 'app-server')), String.raw`
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({tokens:{access_token:'fixture-shared-access',account_id:'fixture-shared-account',refresh_token:'fixture-refresh-not-forwarded'}}));
createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line); if(request.id===undefined)return;
  const result=request.method==='account/read'?{account:{type:'chatgpt',email:'shared@example.invalid',planType:'plus'}}:request.method==='initialize'?{userAgent:'account-fixture',codexHome:process.env.CODEX_HOME}:{};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
});
`);
}
