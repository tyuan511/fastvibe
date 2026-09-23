/**
 * Page scripts for the Jev browser loop, ported from browser-use/jev-ultrafast
 * (`jev_ultrafast/snapshot.js` and the act/settle expressions in `browser.py`, commit
 * 1231850, MIT License, Copyright (c) 2026 Browser Use).
 *
 * Why these and not the side pane's `SNAPSHOT_BODY`: the decision model can only choose
 * among what the snapshot offers, and the product snapshot offers the first 150 elements
 * in DOM order with the whole page's text. The port offers what is on screen — elements
 * whose centre is in the viewport, and visible text — with each control's role,
 * accessible name, current value and checked/selected state, native `<select>` options as
 * separate targets, and scroll/wait as explicit controls. It also gives every node a
 * code-owned identity and the semantic keys the executor compares before acting.
 *
 * Adaptations: the page global is `__fastvibeDecision`, and the scripts are strings the
 * host injects (webview `executeJavaScript`), not CDP evaluations. Date/time inputs are
 * offered as text fields: the original skips them, which left a form's delivery-time
 * field invisible and the loop re-typing a neighbouring field instead. The nearest
 * off-screen controls are offered too, marked `offscreen`, and the target script scrolls
 * one into view before acting: with only on-screen controls, a target below the fold
 * (a "Next" link, a pager, a directory further down a list) left Jev choosing BLOCKED.
 */

/** One executable candidate, as the observe script reports it. */
export type ObservedAction = {
  /** Code-owned id, `e1`… for element actions, `scroll_down` / `scroll_up` / `wait` for controls. */
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  /** Identity of the DOM node (a WeakMap id in the page), absent for controls. */
  node?: number;
  role?: string;
  label: string;
  value?: string;
  /** For a `<select>` option: the label of what is selected now. */
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  rect?: { x: number; y: number; w: number; h: number };
  delta?: number;
  /** Outside the viewport; acting on it scrolls it into view first. */
  offscreen?: boolean;
};

export type DecisionObservation = {
  url: string;
  title: string;
  w: number;
  h: number;
  /** Visible text only, up to 6000 characters. */
  text: string;
  scroll: { y: number; height: number };
  actions: ObservedAction[];
  /** Full semantic state; any change means the page is not the one decided on. */
  marker: unknown;
  /** Document, URL, viewport and safe form state. */
  page_key: unknown;
  /** Per node: identity, role, name, value, state and nearby context. */
  guards: Record<string, unknown>;
  omitted_actions: number;
};

/** Off-screen controls offered in addition to the on-screen ones, nearest first. */
export const OFFSCREEN_LIMIT = 60;

/** Observe the page. Returns `null` while the document has no body (navigating). */
export const OBSERVE_SCRIPT = String.raw`(() => {
  if (!document.body) return null;
  const cache = window.__fastvibeDecision ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
      if (['date','time','datetime-local','month','week'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[], offscreen=[];
  const add=(e,r,rname,far)=>{
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    if (far) base.offscreen=true;
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  };
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || x>=innerWidth) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    if (y<0 || y>=innerHeight) { offscreen.push([e,r,rname,y<0 ? -y : y-innerHeight]); continue; }
    add(e,r,rname,false);
  }
  // FastVibe addition: the nearest off-screen controls, marked, so a target below the fold
  // (a "Next" link, a pager) can be chosen directly; the executor scrolls it into view.
  offscreen.sort((a,b)=>a[3]-b[3]);
  for (const [e,r,rname] of offscreen.slice(0,${OFFSCREEN_LIMIT})) add(e,r,rname,true);
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()`;

/** The observe script's `marker` only, for the full semantic freshness comparison. */
export const MARKER_SCRIPT = `(() => { const state=${OBSERVE_SCRIPT}; return state?.marker ?? null; })()`;

/** `[pageKey, guard(node)]` for a scoped click/select freshness check. */
export function guardScript(node: number): string {
  return `(() => { const c=window.__fastvibeDecision; return c ? [c.pageKey(),c.guard(c.nodes.get(${Math.trunc(node)}))] : null; })()`;
}

/**
 * Resolve the observed node right before input: connected, enabled, visible, centre in
 * the viewport and not covered. Returns the centre point, or `null` when the target
 * changed. A `select` action is performed here (value + input/change events).
 */
export function targetScript(action: ObservedAction): string {
  return String.raw`(action => {
  const e=window.__fastvibeDecision?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  let r=e.getBoundingClientRect();
  if (r.y+r.height/2<0 || r.y+r.height/2>=innerHeight) { e.scrollIntoView({block:'center',inline:'nearest'}); r=e.getBoundingClientRect(); }
  const x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`;
}

/**
 * Wait after an interaction: two animation frames or 50 ms, or up to 200 ms for an
 * editable combobox's suggestions to appear — so the next decision does not choose from
 * a popup that has not arrived.
 */
export function settleScript(action: ObservedAction): string {
  return String.raw`(action => new Promise(resolve => {
  const field=window.__fastvibeDecision?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve(true)};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(${JSON.stringify({ node: action.node ?? null, kind: action.kind })})`;
}
