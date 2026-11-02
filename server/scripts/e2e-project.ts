// End-to-end check of town projects (contract v4) on NEAR testnet: a new player pledges coin to the bridge project
// through the relayer (session key, gas-free), the pledge shows on chain, and the player withdraws it again.
// The project is left unfinished on purpose, so real players build the bridge.
//
//   node server/scripts/e2e-project.ts
import { e2eSetup } from './e2e-lib.ts';

const { chain, game, link, newPlayer, signedCall, settleAll, bal, check, passed } = await e2eSetup();
const step = (s: string) => console.log('\n== ' + s);
const pid = game.econ.projects[0].id;
const coinPledged = async () => Number((await chain.getProject(pid))?.pledged.find((l) => l.token_id === 'coin')?.amount ?? 0);

step('the project exists on chain with what economy/config.json says it needs');
const p0 = await chain.getProject(pid);
check(`project ${pid} found, not done`, !!p0 && !p0.done);
check('needs 60 Kayu, 20 Bijih, 300 Koin', JSON.stringify(p0?.need) === JSON.stringify([{ token_id: 'wood', amount: '60' }, { token_id: 'ore', amount: '20' }, { token_id: 'coin', amount: '300' }]));
const before = await coinPledged();

step('a new player gets the starter kit settled');
const A = await newPlayer('A');
await settleAll();
check('A has 100 coin on chain', (await bal(A.accountId, 'coin')) === 100);

step('A pledges 40 coin (session key, relayed gas-free)');
const pl = await signedCall(A, 'project_contribute', { id: pid, contribution: [{ token_id: 'coin', amount: '40' }] });
console.log(`  ${pl.status} ${link(pl.txHash)} ${pl.error ?? ''}`);
check('the board shows 40 more coin, and A among the contributors', (await coinPledged()) === before + 40 && !!(await chain.getProject(pid))?.contributors.some((c) => c.account_id === A.accountId));
check('A has 60 coin left', (await bal(A.accountId, 'coin')) === 60);

step('A withdraws the pledge');
const wd = await signedCall(A, 'project_withdraw', { id: pid });
console.log(`  ${wd.status} ${link(wd.txHash)} ${wd.error ?? ''}`);
check('A has 100 coin again and the board is back where it was', (await bal(A.accountId, 'coin')) === 100 && (await coinPledged()) === before);
check('Dusun Seberang is still closed on the server map', !game.map?.unlocked.includes('seberang'));

console.log(passed() ? '\nPROJECT E2E PASS' : '\nPROJECT E2E FAIL');
if (!passed()) process.exitCode = 1;
