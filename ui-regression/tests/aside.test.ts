import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, createContext } from 'node:vm';
import { buildAsideCode, parseAsideObservations, runAsideScenario } from '../lib/aside';
import type { UiScenario } from '../lib/scenario';

const scenario: UiScenario = {id:'local',expectedBehavior:'Shows ready',steps:[{action:'goto',url:'http://127.0.0.1:4311/'},{action:'assert',selector:'#ready',kind:'text',match:'exact',expected:'Ready'}]};
const nonce = 'fixture-nonce';
const frame = (value: object) => 'UI_ASIDE_FRAME ' + JSON.stringify({version:1,nonce,...value});
const frames = () => [frame({type:'step',step:0,status:'passed',assertion:false}),frame({type:'step',step:1,status:'passed',assertion:true}),frame({type:'terminal',completed:2,reason:'complete'}),frame({type:'cleanup',status:'confirmed'})];
const parse = (lines:string[], exit=0) => parseAsideObservations(lines.join('\n'),nonce,scenario,exit);

type FakeControl = { tag: string; type: string | null; name: string; id: string; autocomplete: string; text: string; target: string | null };
type InterpreterOptions = { count?: number; visible?: boolean; control?: Partial<FakeControl>; text?: string; navigateOnClick?: boolean };

async function executeInterpreter(input: UiScenario, options: InterpreterOptions = {}) {
  const events: string[] = [], lines: string[] = [], closed: object[] = [];
  let currentUrl = input.steps[0].action === 'goto' ? input.steps[0].url : '';
  const control: FakeControl = {tag:'button',type:'button',name:'',id:'',autocomplete:'',text:'Continue',target:null,...options.control};
  const element = {
    tagName:control.tag.toUpperCase(),id:control.id,textContent:control.text,
    getAttribute:(name:string) => ({type:control.type,name:control.name,autocomplete:control.autocomplete,target:control.target,href:null})[name as 'type' | 'name' | 'autocomplete' | 'target' | 'href'] ?? null,
  };
  const owned = {
    url:() => currentUrl,
    goto:async (url:string) => { events.push(`goto:${url}`); currentUrl = url; },
    locator:(selector:string) => {
      events.push(`locator:${selector}`);
      return {
        count:async () => { events.push(`count:${selector}`); return options.count ?? 1; },
        isVisible:async () => { events.push(`visible:${selector}`); return options.visible ?? true; },
        evaluate:async (read:(el:typeof element) => unknown) => { events.push(`evaluate:${selector}`); return read(element); },
        click:async () => { events.push(`click:${selector}`); if (options.navigateOnClick) currentUrl = 'https://outside.invalid/'; },
        fill:async (value:string) => { events.push(`fill:${selector}:${value}`); },
        innerText:async () => { events.push(`text:${selector}`); return options.text ?? 'Ready'; },
      };
    },
  };
  const context = createContext({
    URL,
    console:{log:(value:unknown) => lines.push(String(value))},
    openTab:async (url:string) => { events.push(`open:${url}`); currentUrl = url; return owned; },
    closeTab:async (tab:object) => { expect(tab).toBe(owned); events.push('close'); closed.push(tab); },
    snapshot:async (tab:object, scope?:{selector:string}) => {
      expect(tab).toBe(owned); events.push(`snapshot:${scope?.selector ?? '*'}`);
      return {tree:'synthetic tree',diff:'synthetic diff'};
    },
  },{codeGeneration:{strings:false,wasm:false}});
  // The wrapper only supplies top-level await; the body is the actual generated interpreter.
  await new Script(`(async () => { ${buildAsideCode(input,nonce)} })()`).runInContext(context,{timeout:1000});
  expect('injected' in context).toBe(false);
  expect(closed).toEqual([owned]);
  expect(events.filter(event => event.startsWith('open:'))).toEqual([`open:${input.steps[0].action === 'goto' ? input.steps[0].url : ''}`]);
  expect(events.at(-1)).toBe('close');
  return {events,lines,result:parseAsideObservations(lines.join('\n'),nonce,input,0)};
}

describe('Generated Aside interpreter guards',() => {
  const actionScenario = (action:'click' | 'fill'): UiScenario => ({
    ...scenario,steps:[scenario.steps[0],action === 'click' ? {action,selector:'#control'} : {action,selector:'#control',value:'sample'},
      {action:'click',selector:'#later'},{action:'assert',selector:'#ready',kind:'visible'}],
  });
  const rejected = async (input:UiScenario,options:InterpreterOptions,reason:string) => {
    const execution = await executeInterpreter(input,options);
    expect(execution.result.status).toBe('failed');
    expect(execution.result.reason).toBe(reason);
    expect(execution.result.cleanup).toBe('confirmed');
    expect(execution.result.steps).toEqual([{step:0,action:'goto',status:'passed'}]);
    expect(execution.events.some(event => event.includes('#later') || event.includes('#ready'))).toBe(false);
    return execution;
  };
  for (const action of ['click','fill'] as const) {
    for (const [name,options,reason] of [
      ['missing',{count:0},'missing_target'],
      ['ambiguous',{count:2},'ambiguous_target'],
      ['hidden',{visible:false},'hidden_target'],
    ] as const) {
      it(`rejects ${name} ${action} targets before any mutation`,async () => {
        const {events} = await rejected(actionScenario(action),options,reason);
        expect(events.some(event => /^(click|fill|evaluate):/.test(event))).toBe(false);
        expect(events.indexOf('snapshot:#control')).toBeLessThan(events.indexOf('locator:#control'));
      });
    }
  }
  it('stops immediately when a permitted click navigates outside the initial origin',async () => {
    const {events} = await rejected(actionScenario('click'),{navigateOnClick:true},'origin_drift');
    expect(events.filter(event => event.startsWith('click:'))).toEqual(['click:#control']);
    expect(events.filter(event => event === 'snapshot:#control')).toHaveLength(1);
    expect(events.some(event => event.startsWith('fill:'))).toBe(false);
  });
  for (const [label,control] of [
    ['name',{name:'payment'}],['id',{id:'credential'}],['autocomplete',{autocomplete:'email'}],
    ['text',{text:'Sign in'}],['password type',{type:'password'}],['file type',{type:'file'}],
    ['submit type',{type:'submit'}],['external target',{target:'_blank'}],
  ] satisfies [string,Partial<FakeControl>][]) {
    for (const action of ['click','fill'] as const) {
      it(`rejects ${label} controls before ${action}`,async () => {
        const {events} = await rejected(actionScenario(action),{control:{tag:action === 'fill' ? 'input' : 'button',type:action === 'fill' ? 'text' : 'button',...control}},'unsupported_control');
        expect(events).toContain('evaluate:#control');
        expect(events.some(event => /^(click|fill):/.test(event))).toBe(false);
      });
    }
  }
  for (const action of ['click','fill'] as const) {
    it(`takes fresh snapshots before each lookup and after a successful ${action}`,async () => {
      const input:UiScenario = {...scenario,steps:[scenario.steps[0],
        action === 'fill' ? {action,selector:'#control',value:'sample'} : {action,selector:'#control'},
        {action:'assert',selector:'#ready',kind:'text',match:'exact',expected:'Ready'}]};
      const {events,result} = await executeInterpreter(input,{control:{tag:action === 'fill' ? 'input' : 'button',type:action === 'fill' ? 'text' : 'button'},text:' \r\nReady\r\n '});
      expect(result.status).toBe('passed');
      expect(events).toEqual(['open:http://127.0.0.1:4311/','snapshot:*','snapshot:#control','locator:#control',
        'count:#control','visible:#control','evaluate:#control',action === 'fill' ? 'fill:#control:sample' : 'click:#control','snapshot:#control',
        'snapshot:#ready','locator:#ready','count:#ready','visible:#ready','text:#ready','close']);
    });
  }
  for (const [match,text,status] of [
    ['exact',' Ready\r\n','passed'],['exact','Ready now','failed'],['substring',' Ready now\r\n','passed'],['substring','Not yet','failed'],
  ] as const) {
    it(`executes ${match} text semantics for ${JSON.stringify(text)}`,async () => {
      const input:UiScenario = {...scenario,steps:[scenario.steps[0],{action:'assert',selector:'#ready',kind:'text',match,expected:'Ready'}]};
      const {result} = await executeInterpreter(input,{text});
      expect(result.status).toBe(status);
      expect(result.reason).toBe(status === 'passed' ? 'complete' : 'assertion_failed');
      expect(result.assertions).toEqual([{step:1,id:'step-1',kind:`text_${match}`,status}]);
    });
  }
  it('keeps quote and backslash-bearing DSL strings as data in the generated interpreter',async () => {
    const value = '"; globalThis.injected = true; // \\ literal';
    const selector = '[data-label="quoted\\value"]';
    const input:UiScenario = {...scenario,expectedBehavior:value,steps:[scenario.steps[0],{action:'fill',selector,value},
      {action:'assert',selector,kind:'text',match:'exact',expected:value}]};
    const {events,result,lines} = await executeInterpreter(input,{control:{tag:'textarea',type:null},text:value});
    expect(result.status).toBe('passed');
    expect(events).toContain(`fill:${selector}:${value}`);
    expect(events).toContain(`text:${selector}`);
    expect(lines.some(line => line.includes(value))).toBe(false);
    expect(buildAsideCode(input,nonce)).toContain(`const scenario = ${JSON.stringify(input)};`);
  });
});

describe('Aside observation boundary',() => {
  it('requires ordered terminal and cleanup observations plus successful exit',() => {
    expect(parse(frames()).status).toBe('passed');
    expect(parse(frames()).assertions).toEqual([{step:1,id:'step-1',kind:'text_exact',status:'passed'}]);
    expect(parse(frames()).steps).toEqual([{step:0,action:'goto',status:'passed'},{step:1,action:'assert',status:'passed'}]);
    expect(parse(frames(),1).status).not.toBe('passed');
    expect(parse([]).reason).toBe('missing_observations');
    expect(parse(frames().slice(0,3)).status).not.toBe('passed');
    expect(parse([...frames(),frames()[0]]).reason).toBe('malformed_observations');
    expect(parse([frames()[1],...frames()]).reason).toBe('malformed_observations');
  });
  it('rejects malformed, spoofed, oversized and mismatched frames',() => {
    expect(parse(['UI_ASIDE_FRAME {']).reason).toBe('malformed_observations');
    expect(parse(frames().map(line => line.replace(nonce,'other'))).status).not.toBe('passed');
    expect(parse([frame({type:'step',step:0,status:'passed',assertion:true})]).status).not.toBe('passed');
    expect(parse(['x'.repeat(1048577)]).reason).toBe('output_overflow');
    expect(parse(['UI_ASIDE_FRAME '+ 'x'.repeat(65536)]).reason).toBe('malformed_observations');
    expect(parse([...frames().slice(0,3),frame({type:'cleanup',status:'unconfirmed'})]).reason).toBe('cleanup_unconfirmed');
  });
  for (const reason of ['origin_drift','missing_target','ambiguous_target','hidden_target','unsupported_control','assertion_failed']) {
    it(`never passes ${reason}`,() => {
      const result = parse([frames()[0],frame({type:'terminal',completed:1,reason}),frames()[3]]);
      expect(result.status).toBe('failed'); expect(result.reason).toBe(reason);
    });
  }
  it('generates a local fixed interpreter with owned-tab lifecycle and no attachment',() => {
    const code = buildAsideCode(scenario,nonce);
    expect(code).toContain('await (async function ()');
    expect(code.match(/openTab\(/g)?.length).toBe(1);
    expect(code).toContain('await closeTab(owned)');
    expect(code).toContain('finally'); expect(code).toContain('snapshot(owned,{selector:step.selector})');
    for (const forbidden of ['attachActive','attachBrowser','listBrowserTabs','page.close','eval(','require(','import ']) expect(code).not.toContain(forbidden);
  });
});

describe('Aside invocation lifecycle',() => {
  it('rejects total timeout beyond 90 seconds without invocation',async()=>{
    let calls=0;const result=await runAsideScenario(scenario,'route',90001,undefined,{invoke:async()=>{calls++;throw Error('unexpected');}});
    expect(result.reason).toBe('invalid_timeout');expect(result.status).toBe('not_run');expect(calls).toBe(0);
  });
  async function withLock(work:(dir:string)=>Promise<void>) {
    const dir = await mkdtemp(join(await realpath(tmpdir()),'ui-aside-'));
    try { await work(dir); } finally { await rm(dir,{recursive:true,force:true}); }
  }
  it('invokes exactly once and excludes private values from receipts',async () => withLock(async dir => {
    let calls = 0;
    const result = await runAsideScenario(scenario,'private-account',1000,undefined,{lockDir:dir,invoke:async args => {
      calls++; expect(args.slice(0,3)).toEqual(['repl','--account','private-account']);
      const actualNonce = JSON.parse(args[3].match(/const nonce = ("[^"]+");/)![1]);
      return {exitCode:0,signal:null,stdout:frames().join('\n').replaceAll(nonce,actualNonce),stderr:'private raw error'};
    }});
    expect(calls).toBe(1); expect(result.status).toBe('passed');
    const receipt = JSON.stringify(result);
    for (const secret of ['private-account','private raw error','#ready','Ready']) expect(receipt).not.toContain(secret);
  }));
  it('does not steal existing locks or invoke on pre-cancellation',async () => withLock(async dir => {
    await writeFile(join(dir,'run.lock'),'');
    let calls = 0;
    const deps = {lockDir:dir,invoke:async () => {calls++; return {exitCode:0,signal:null,stdout:'',stderr:''};}};
    expect((await runAsideScenario(scenario,'account',1000,undefined,deps)).reason).toBe('busy');
    const controller = new AbortController(); controller.abort();
    expect((await runAsideScenario(scenario,'account',1000,controller.signal,deps)).reason).toBe('cancelled');
    expect(calls).toBe(0);
  }));
  it('classifies timeout and mid-run cancellation without raw errors',async () => withLock(async dir => {
    const invoke = async (_args:string[],signal:AbortSignal) => new Promise<never>((_resolve,reject) => signal.addEventListener('abort',() => reject(new Error('private diagnostic')),{once:true}));
    expect((await runAsideScenario(scenario,'account',5,undefined,{lockDir:dir,invoke})).reason).toBe('timeout');
    const controller = new AbortController();
    const pending = runAsideScenario(scenario,'account',1000,controller.signal,{lockDir:dir,invoke:async (args,signal) => {queueMicrotask(() => controller.abort()); return invoke(args,signal);}});
    expect((await pending).reason).toBe('cancelled');
  }));
  it('bounds combined fake capture and rejects missing CLI',async () => withLock(async dir => {
    const overflow = await runAsideScenario(scenario,'account',1000,undefined,{lockDir:dir,invoke:async () => ({exitCode:0,signal:null,stdout:'',stderr:'x'.repeat(1048577)})});
    expect(overflow.reason).toBe('output_overflow');
    const missing = await runAsideScenario(scenario,'account',1000,undefined,{lockDir:dir,invoke:async () => {throw Object.assign(new Error('private'),{code:'ENOENT'});}});
    expect(missing.status).toBe('unavailable'); expect(missing.reason).toBe('missing_cli');
  }));
  it('bounds mocks that ignore cancellation',async () => withLock(async dir => {
    const result = await runAsideScenario(scenario,'account',5,undefined,{lockDir:dir,invoke:async () => new Promise<never>(() => {})});
    expect(result.status).toBe('incomplete'); expect(result.reason).toBe('cleanup_unconfirmed');
    expect(result.cleanup).toBe('unconfirmed');
  }));
  it('rejects symlink ancestors before invoking',async () => withLock(async dir => {
    await symlink(dir,join(dir,'alias'));
    let calls = 0;
    const result = await runAsideScenario(scenario,'account',1000,undefined,{lockDir:join(dir,'alias','child'),invoke:async () => {calls++; return {exitCode:0,signal:null,stdout:'',stderr:''};}});
    expect(result.status).toBe('not_run'); expect(calls).toBe(0);
  }));
});
