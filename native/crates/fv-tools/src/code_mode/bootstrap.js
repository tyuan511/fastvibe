// Only JSON and promises cross the host bridge; there is no module loader or ambient I/O.
(() => {
  const catalog=JSON.parse(__catalog);
  const invoke=__call, append=__text, picture=__image, sound=__audio, put=__store, get=__load, yieldNow=__yield, delay=__delay, finish=__exit;
  for(const key of ['__catalog','__call','__text','__image','__audio','__store','__load','__yield','__delay','__exit']) delete globalThis[key];
  const stringify=value => { const text=typeof value==='string'?value:JSON.stringify(value); return text===undefined?'undefined':text; };
  globalThis.text=value=>append(stringify(value));
  globalThis.image=value=>picture(JSON.stringify(value));
  globalThis.audio=value=>sound(JSON.stringify(value));
  globalThis.generatedImage=value=>{image(value.image_url);if(value.output_hint)text(value.output_hint);};
  globalThis.store=(key,value)=>{if(typeof key!=='string')throw new TypeError('store key must be a string');const s=JSON.stringify(value);if(s===undefined)throw new TypeError('store requires a JSON value');put(key,s);};
  globalThis.load=key=>{if(typeof key!=='string')throw new TypeError('load key must be a string');const s=get(key);return s==null?undefined:JSON.parse(s);};
  globalThis.notify=value=>{text(value);yieldNow();};
  globalThis.yield_control=async()=>{yieldNow();};
  globalThis.exit=()=>finish();
  let timerId=0;const timers=new Set();
  globalThis.setTimeout=(callback,ms=0)=>{if(typeof callback!=='function')throw new TypeError('timer callback must be a function');if(!Number.isFinite(ms)||ms<0)throw new TypeError('invalid timer delay');const id=++timerId;timers.add(id);delay(Math.floor(Math.min(ms,600000))).then(()=>{if(timers.delete(id))callback();});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);
  const tools=Object.create(null);
  for(const entry of catalog)Object.defineProperty(tools,entry.name,{value:async(input={})=>JSON.parse(await invoke(entry.name,JSON.stringify(input))),enumerable:true});
  Object.defineProperty(globalThis,'tools',{value:Object.freeze(tools),writable:false});
  Object.defineProperty(globalThis,'ALL_TOOLS',{value:Object.freeze(catalog),writable:false});
})();
