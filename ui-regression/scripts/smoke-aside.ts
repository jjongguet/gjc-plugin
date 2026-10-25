import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startUiFixture} from '../tests/fixtures/server.mjs';
import {runAsideScenario} from '../lib/aside';
import {validateScenario} from '../lib/scenario';
const account=process.env.UI_REGRESSION_ACCOUNT;
if(!account)throw Error('explicit_ephemeral_account_required');
const fixture=await startUiFixture();
try {
 const scenario=JSON.parse(await readFile(new URL('../tests/fixtures/scenario.json',import.meta.url),'utf8'));
 scenario.steps[0].url=fixture.origin+'/';
 const pass=await runAsideScenario(validateScenario(scenario),account,60000);
 assert.equal(pass.status,'passed','actual_aside_pass_failed:'+pass.reason);assert.equal(pass.assertions.length,2);assert.equal(pass.cleanup,'confirmed');
 const mismatch=structuredClone(scenario);mismatch.id='local-mismatch';mismatch.steps[4].expected='Deliberate mismatch';
 const fail=await runAsideScenario(validateScenario(mismatch),account,60000);
 assert.equal(fail.status,'failed','actual_aside_mismatch_not_observed:'+fail.reason);assert.equal(fail.reason,'assertion_failed');assert.equal(fail.assertions.filter(a=>a.status==='failed').length,1);assert.equal(fail.cleanup,'confirmed');assert.equal(fixture.submissions(),0);
 const summary={schemaVersion:1,kind:'package-browser-consumer-report',actualAside:true,productionCredentials:false,submissions:fixture.submissions(),pass:{status:pass.status,assertions:pass.assertions,cleanup:pass.cleanup},mismatch:{status:fail.status,reason:fail.reason,assertions:fail.assertions,cleanup:fail.cleanup},currentUiState:'not_reobserved',browserBuildBinding:'unverified'};
 console.log(JSON.stringify(summary));
}finally{await fixture.close();}
