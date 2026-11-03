import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialTree, readMemoryTree } from '../src/main/bot/memory/files.ts';
import { ViviMemoryService } from '../src/main/bot/memory/service.ts';
import type { ViviMemorySource } from '../src/main/bot/memory/types.ts';
const source = (id: string, at: number): ViviMemorySource => ({ id, createdAt:at, conversationId:'router', requestId:id,epoch:1,role:'router',kind:'input',text:'Remember concise weekly reports' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'vivi-service-'));
  const sources: ViviMemorySource[] = [];
  let clock = 100, calls = 0, loads = 0;
  const options = { root:join(dir,'memories'), sources:()=>sources, now:()=>clock, debounceMs:100000,
    loadMaterial:async()=> { loads++; return 'actual checked output'; },
    complete:async(_system: string, user: string)=> { calls++; assert.match(user,/actual checked output/); return JSON.stringify({raw_memory:'Concise weekly reports',rollout_summary:'User explicitly prefers concise weekly reports'}); },
    consolidate:async({cwd}:{cwd:string})=> { writeFileSync(join(cwd,'MEMORY.md'),'# Preferences\nConcise weekly reports\n'); writeFileSync(join(cwd,'memory_summary.md'),'v1\n## Index\nSee MEMORY.md Preferences\n'); }
  };
  const service = new ViviMemoryService(options);
  return {dir,sources,options,service, setClock:(n:number)=>clock=n, calls:()=>calls, loads:()=>loads, cleanup:async()=>{await service.stop();rmSync(dir,{recursive:true,force:true});}};
}
test('explicit remembering is not extracted again when its receipt completes', async()=>{
  const f=fixture();
  try {
    f.service.start(); await f.service.run();
    const running=source('same-input',101);
    const context=await f.service.context();
    await f.service.update({expectedRevision:context.revision,quote:'Remember',edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:'# Preferences\nConcise weekly reports'}]},running,()=>true);
    f.sources.push({...running,createdAt:200,outcome:'completed',title:'Updated display title'});
    await f.service.run();
    assert.equal(f.calls(),0);
    assert.match((await f.service.read('MEMORY.md')).content,/Concise/);
    assert.ok((await f.service.search('Remember')).some(hit=>hit.path.startsWith('rollout_summaries/explicit-')), '明确记忆保留可查的用户原话来源');
  } finally {await f.cleanup();}
});
test('first launch skips history; later sources persist, deduplicate and catch up after reopening', async()=>{
  const f=fixture();
  try {
    f.sources.push(source('old',50)); f.service.start(); await f.service.run(); assert.equal(f.calls(),0);
    f.sources.push(source('new',101)); await f.service.run(); assert.equal(f.calls(),1); assert.equal(f.loads(),1);
    await f.service.run(); assert.equal(f.calls(),1);
    await f.service.stop();
    f.sources.push(source('offline',102));
    const reopened = new ViviMemoryService(f.options); reopened.start(); await reopened.run(); await reopened.stop();
    assert.equal(f.calls(),2); assert.match((await reopened.context()).summary,/Index/);
    f.service.start(); await f.service.run(); assert.equal(f.calls(),2);
  } finally {await f.cleanup();}
});
test('invalid model output preserves last valid files and retries are bounded', async()=>{
  const f=fixture();
  try {
    f.service.start(); await f.service.run(); const before=await f.service.context();
    f.sources.push(source('new',101));
    f.options.consolidate=async({cwd})=>{writeFileSync(join(cwd,'memory_summary.md'),'bad');};
    for (let i=0;i<3;i++) { f.setClock(1000+i*100000); await assert.rejects(f.service.run(),/Invalid memory summary/); }
    f.setClock(900000); await f.service.run(); assert.equal(f.calls(),3);
    assert.equal((await f.service.context()).revision,before.revision);
  } finally {await f.cleanup();}
});
test('CAS, source quote and cancellation checks protect foreground edits across two instances',async()=>{
  const f=fixture();
  try {
    f.service.start(); await f.service.run(); const context=await f.service.context();
    const update={expectedRevision:context.revision,quote:'Remember',edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:'# Preferences\n## Weekly\nConcise'}]};
    const other=new ViviMemoryService(f.options);
    const results=await Promise.allSettled([f.service.update(update,source('a',101),()=>true),other.update(update,source('b',102),()=>true)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(f.service.update(update,source('a',101),()=>false),/current/);
    await assert.rejects(f.service.update({...update,quote:'invented'},source('a',101),()=>true),/original/);
    const fresh=await f.service.context([{path:'MEMORY.md',heading:'Weekly',offset:999}]);
    assert.match(fresh.excerpts[0].content,/Concise/);
    for(const path of ['../outside.md','/tmp/outside.md','rollout_summaries/../MEMORY.md']) await assert.rejects(f.service.read(path),/path/);
  } finally {await f.cleanup();}
});
test('a pre-forget source that completes late cannot become new memory', async()=>{
  const f=fixture();
  try {
    f.service.start(); await f.service.run();
    f.setClock(200);
    const context=await f.service.context();
    await f.service.update({expectedRevision:context.revision,quote:'Remember',forget:true,edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:'# Retained'}]},source('forget-current',200),()=>true);
    f.sources.push({...source('old-work-completed-late',150),kind:'result',role:'worker',outcome:'ready'});
    await f.service.run();
    assert.equal(f.calls(),0);
  } finally {await f.cleanup();}
});
test('foreground forget succeeds while consolidation is pending and late results cannot resurrect notes',async()=>{
  const f=fixture();
  let entered!:()=>void, release!:()=>void;
  const ready=new Promise<void>(r=>entered=r), held=new Promise<void>(r=>release=r);
  try {
    f.service.start(); await f.service.run();
    f.options.consolidate=async()=>{entered();await held;};
    f.sources.push(source('new',101)); const run=f.service.run(); const settled=run.catch(()=>{}); await ready;
    const context=await f.service.context();
    const result=await f.service.update({expectedRevision:context.revision,quote:'Remember',forget:true,edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:'# Retained unrelated knowledge'}]},source('forget',102),()=>true);
    assert.notEqual(result.revision,context.revision);
    release(); await settled;
    assert.match((await f.service.read('MEMORY.md')).content,/Retained/);
    assert.equal((await f.service.search('Concise')).length,0);
    await f.service.run(); assert.equal(f.calls(),1);
    assert.equal(readFileSync(join(f.dir,'memories-baseline','MEMORY.md'),'utf8'),'# Retained unrelated knowledge\n');
  } finally {release?.();await f.cleanup();}
});
test('ordinary correction wins over an older background result without waiting for the model',async()=>{
  const f=fixture(); let entered!:()=>void, release!:()=>void;
  const ready=new Promise<void>(r=>entered=r), held=new Promise<void>(r=>release=r);
  try {
    f.service.start(); await f.service.run();
    const original=f.options.consolidate;
    f.options.consolidate=async(request)=>{entered();await held;await original(request);};
    f.sources.push(source('new',101)); const pending=f.service.run(); const rejected=assert.rejects(pending,/changed during consolidation/); await ready;
    const c=await f.service.context();
    await f.service.update({expectedRevision:c.revision,quote:'Remember',edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:'# Corrected preference'}]},source('correction',102),()=>true);
    release();await rejected;
    assert.match((await f.service.read('MEMORY.md')).content,/Corrected/);
  } finally {release?.();await f.cleanup();}
});
test('read and search are bounded; overlapping edits and invalid summary are atomic failures',async()=>{
  const f=fixture();
  try {
    f.service.start();await f.service.run();
    const c=await f.service.context();
    await f.service.update({expectedRevision:c.revision,quote:'Remember',edits:[{path:'MEMORY.md',oldText:'# Vivi memory',newText:Array.from({length:200},(_,i)=>`line ${i} hit`).join('\n')}]},source('edit',101),()=>true);
    assert.equal((await f.service.search('hit')).length,30);
    assert.equal((await f.service.read('MEMORY.md',1,999)).content.split('\n').length,120);
    const fresh=await f.service.context();
    await assert.rejects(f.service.update({expectedRevision:fresh.revision,quote:'Remember',edits:[{path:'MEMORY.md',oldText:'line 0 hit',newText:'changed'},{path:'MEMORY.md',oldText:'line 0',newText:'overlap'}]},source('edit2',102),()=>true),/Overlapping/);
    await assert.rejects(f.service.update({expectedRevision:fresh.revision,quote:'Remember',edits:[{path:'memory_summary.md',oldText:'v1',newText:'v2'}]},source('edit2',102),()=>true),/Invalid memory summary/);
    assert.equal((await f.service.context()).revision,fresh.revision);
  } finally {await f.cleanup();}
});
test('deleted or modified sources cannot publish orphan knowledge',async()=>{
  for (const action of ['delete','modify']) {
    const f=fixture();let entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
    try {
      f.service.start();await f.service.run();const before=await f.service.context();
      const original=f.options.consolidate;
      f.options.consolidate=async(request)=>{entered();await held;await original(request);};
      f.sources.push(source('new',101));const run=f.service.run();const rejected=assert.rejects(run,/source changed/);await ready;
      if(action==='delete') f.sources.length=0;else f.sources[0].text='Corrected original source';
      release();await rejected;
      assert.equal((await f.service.context()).revision,before.revision);
      assert.equal(f.loads(),1);
    } finally {release?.();await f.cleanup();}
  }
});
test('stop waits for the consolidator abort acknowledgement before deleting its workspace',async()=>{
  const f=fixture();let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let acknowledged=false;
  try {
    const service=new ViviMemoryService({...f.options,consolidate:async({cwd,signal})=>{
      entered();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>{
        setTimeout(()=>{writeFileSync(join(cwd,'abort-check.md'),'agent has stopped');acknowledged=true;resolve();},15);
      },{once:true}));
    }});
    service.start();await service.run();f.sources.push(source('new',101));const run=service.run();const rejected=assert.rejects(run,/cancelled/);await ready;
    await service.stop();await rejected;
    assert.equal(acknowledged,true);
    assert.equal(readdirSync(f.dir).some(name=>name.startsWith('memories-work-')),false);
  } finally {await f.cleanup();}
});
test('more than 256 notes remain bounded while later batches and revised sources keep learning',async()=>{
  const f=fixture();
  try {
    f.service.start();await f.service.run();
    await f.service.files.locked(()=>{
      const tree=initialTree();tree.set('MEMORY.md','# Explicit preference\nAlways retain the weekly report structure.\n');
      for(let i=0;i<260;i++) tree.set(`rollout_summaries/old-${i}.md`,`created_at: ${i}\n\nHistorical summary\n\n## Raw memory\n${'经验'.repeat(500)}\n`);
      f.service.files.publish(tree,f.service.files.state());
    });
    f.options.consolidate=async()=>{};
    f.sources.push(source('new',1001));await f.service.run();
    let tree=readMemoryTree(f.options.root);
    assert.equal([...tree.keys()].filter(path=>path.startsWith('rollout_summaries/')).length,256);
    assert.ok(Buffer.byteLength(tree.get('raw_memories.md')!)<=400000);
    assert.match(tree.get('MEMORY.md')!,/Always retain/);
    f.sources[0].text='Remember an updated concise weekly report';await f.service.run();
    tree=readMemoryTree(f.options.root);
    assert.equal([...tree.values()].filter(text=>text.includes('source_id: "new"')).length,1);
    assert.equal(f.calls(),2);
    f.sources.push(source('later',1002));await f.service.run();assert.equal(f.calls(),3);
    assert.equal([...readMemoryTree(f.options.root).keys()].filter(path=>path.startsWith('rollout_summaries/')).length,256);
  } finally {await f.cleanup();}
});
test('startup time boundary retains newly completed sources during async initialization',async()=>{
  const f=fixture(); let release!:()=>void;
  try {
    const held=new Promise<readonly ViviMemorySource[]>(r=>release=()=>r([source('history',50),source('during-start',101)]));
    let first=true;
    const service=new ViviMemoryService({...f.options,sources:()=>{if(first){first=false;return held;}return [source('history',50),source('during-start',101)];}});
    service.start(); release(); await service.run(); await service.stop(); assert.equal(f.calls(),1);
  } finally {await f.cleanup();}
});
