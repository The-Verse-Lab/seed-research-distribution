/**
 * The Observatory single-page UI, served as one self-contained HTML document.
 *
 * Plain HTML/CSS/vanilla JS (no build step). The client script uses string concatenation
 * rather than template literals so it nests cleanly inside this module's template string.
 *
 * @author Runkai Zhang
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Seed · Observatory</title>
<style>
  :root{
    --bg:#0e0f13; --panel:#16181d; --panel2:#1b1e25; --border:#272b34; --text:#d6d9e0;
    --dim:#7c828d; --accent:#6ea8fe; --green:#63d089; --red:#f0857d; --yellow:#e6c07b; --purple:#bca6f5;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif}
  header{display:flex;gap:14px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
  header .title{font-weight:700;letter-spacing:.3px}
  header .title b{color:var(--accent)}
  header .spacer{flex:1}
  select,button{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:7px;padding:6px 10px;font:inherit;cursor:pointer}
  button:hover,select:hover{border-color:var(--accent)}
  label.live{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:13px;cursor:pointer}
  .tabs{display:flex;gap:4px;padding:8px 16px 0;background:var(--panel);border-bottom:1px solid var(--border)}
  .tab{padding:8px 14px;border:none;border-bottom:2px solid transparent;background:none;color:var(--dim);border-radius:0}
  .tab.active{color:var(--text);border-bottom-color:var(--accent)}
  .tab .n{color:var(--dim);font-size:12px;margin-left:5px}
  main{padding:18px;max-width:1000px;margin:0 auto}
  .empty{color:var(--dim);text-align:center;padding:60px 0}

  /* transcript */
  .ev{margin:0 0 12px}
  .ev.narr{white-space:pre-wrap}
  .ev.dlg .who{color:var(--accent);font-weight:600}
  .ev.dlg .to{color:var(--dim);font-weight:400}
  .ev.dice{font-family:var(--mono);font-size:13px;color:var(--yellow)}
  .ev.dice .ok{color:var(--green)} .ev.dice .bad{color:var(--red)}
  .ev.chg{color:var(--dim);font-style:italic;font-size:13px}
  .ev.sys{color:var(--dim);font-family:var(--mono);font-size:12px;opacity:.7}

  /* llm calls */
  .call{border:1px solid var(--border);border-radius:9px;margin:0 0 10px;overflow:hidden;background:var(--panel)}
  .call-head{display:flex;gap:10px;align-items:center;padding:9px 12px;cursor:pointer;font-size:13px}
  .call-head:hover{background:var(--panel2)}
  .call .call-body{display:none;padding:4px 12px 14px;border-top:1px solid var(--border)}
  .call.open .call-body{display:block}
  .badge{font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:5px;background:var(--panel2);border:1px solid var(--border)}
  .role-narrator{color:var(--accent)} .role-utility{color:var(--purple)} .role-embedding{color:var(--green)}
  .model{font-family:var(--mono);color:var(--dim)}
  .kind{color:var(--dim);font-size:12px}
  .lat{margin-left:auto;color:var(--dim);font-family:var(--mono);font-size:12px}
  .fin{font-size:11px;padding:2px 7px;border-radius:5px;font-family:var(--mono)}
  .fin.ok{color:var(--green);background:rgba(99,208,137,.1)} .fin.bad{color:var(--red);background:rgba(240,133,125,.1)} .fin.warn{color:var(--yellow);background:rgba(230,192,123,.1)}
  .time{color:var(--dim);font-size:12px}
  /* turns */
  .tkind{color:var(--accent);font-weight:600}
  .tinput{color:var(--text);font-style:italic;margin-left:6px}
  .beat{padding:2px 0 2px 6px;font-size:13px}
  .tcall{font-family:var(--mono);font-size:12px;padding:3px 0}
  .sec{margin-top:12px}
  .seclabel{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:5px}
  .seclabel.err{color:var(--red)}
  /* module attribution (per-turn: who ran, what they did) */
  .mods{display:grid;gap:2px}
  .mod{display:flex;gap:8px;align-items:baseline;font-family:var(--mono);font-size:12px}
  .mod .ph{color:var(--dim);min-width:58px}
  .mod .mid{min-width:130px}
  .mod .cmds{color:var(--green)}
  .mod .emi{color:var(--purple)}
  .mod .ms{margin-left:auto;color:var(--dim)}
  .mod.slow .ms{color:var(--yellow);font-weight:600}
  .mod.err .mid{color:var(--red)}
  /* brief composition (per-call: what the prompt is made of) */
  .bbrow{display:flex;gap:9px;align-items:center;font-family:var(--mono);font-size:12px;padding:1px 0}
  .bbkey{min-width:190px;flex:none}
  .bbrow .bar{height:8px;background:var(--accent);border-radius:3px;opacity:.72;flex:none}
  .bbn{margin-left:auto;color:var(--dim);white-space:nowrap}
  .bblab .bbkey{padding-left:16px;color:var(--dim);font-size:11.5px}
  .msg{margin:0 0 6px}
  .mrole{font-family:var(--mono);font-size:11px;color:var(--purple);margin-bottom:2px}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12.5px;background:var(--panel2);border:1px solid var(--border);border-radius:7px;padding:9px 11px;max-height:340px;overflow:auto}
  pre.reason{color:var(--yellow);opacity:.92}

  /* state */
  .state{display:grid;gap:14px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:14px}
  .card h3{margin:0 0 10px;font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
  .row{display:flex;justify-content:space-between;gap:14px;padding:4px 0;border-bottom:1px dashed var(--border)}
  .row:last-child{border-bottom:none}
  .row span:first-child{color:var(--dim)}
  .dim{color:var(--dim)}

  /* cost */
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
  .stat{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:12px 14px}
  .slabel{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim)}
  .sval{font-size:21px;font-weight:600;margin:4px 0;color:var(--text)}
  .ssub{font-size:11px;color:var(--dim)}
  .pricebar{margin:0 0 14px;color:var(--dim);font-size:13px}
  .price{width:84px;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 7px;font:inherit;margin:0 4px}
  table.stats{width:100%;border-collapse:collapse;font-size:13px}
  table.stats th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:6px 10px;border-bottom:1px solid var(--border)}
  table.stats td{padding:7px 10px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:12.5px}
  table.stats td.role-narrator{color:var(--accent)} table.stats td.role-utility{color:var(--purple)} table.stats td.role-embedding{color:var(--green)}
</style>
</head>
<body>
<header>
  <div class="title">Seed <b>Observatory</b></div>
  <select id="campaign" title="campaign"></select>
  <button id="refresh" title="reload">↻</button>
  <div class="spacer"></div>
  <label class="live"><input type="checkbox" id="live" /> live</label>
  <button id="exp-md">Export .md</button>
  <button id="exp-json">Export .json</button>
</header>
<div class="tabs">
  <button class="tab active" data-tab="transcript">Transcript <span class="n" id="count-events">0</span></button>
  <button class="tab" data-tab="llm">LLM Calls <span class="n" id="count-llm">0</span></button>
  <button class="tab" data-tab="turns">Turns <span class="n" id="count-turns">0</span></button>
  <button class="tab" data-tab="state">State</button>
  <button class="tab" data-tab="cost">Cost</button>
</div>
<main id="main"><div class="empty">Loading…</div></main>

<script>
var S={campaign:null,character:'',names:{},events:[],llm:[],traces:[],gameState:null,playset:null,maxSeq:-1,maxId:0,maxTraceSeq:-1,tab:'transcript',es:null,priceIn:0,priceOut:0};
function el(id){return document.getElementById(id);}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function nameOf(id){return S.names[id]||id;}
function locName(id){var ls=(S.playset&&S.playset.world&&S.playset.world.locations)||[];for(var i=0;i<ls.length;i++)if(ls[i].id===id)return ls[i].name;return id;}
function questName(id){var qs=(S.playset&&S.playset.campaign&&S.playset.campaign.quests)||[];for(var i=0;i<qs.length;i++)if(qs[i].id===id)return qs[i].name;return id;}
function optionValue(c){return c.campaignId+'\\t'+(c.characterId||'');}
function splitOption(v){var i=v.indexOf('\\t');return i<0?{campaignId:v,characterId:''}:{campaignId:v.slice(0,i),characterId:v.slice(i+1)};}
function query(){return 'campaign='+encodeURIComponent(S.campaign)+'&character='+encodeURIComponent(S.character||'');}

async function loadCampaigns(){
  var list=await (await fetch('/api/campaigns')).json();
  var sel=el('campaign');sel.innerHTML='';
  list.forEach(function(c){var o=document.createElement('option');o.value=optionValue(c);o.textContent=c.campaignId+(c.characterId?' · '+c.characterId:' · legacy');sel.appendChild(o);});
  if(list.length){sel.value=optionValue(list[0]);await selectCampaign(list[0].campaignId,list[0].characterId||'');}
  else{el('main').innerHTML='<div class="empty">No sessions yet. Play a turn (bun run dev) and hit ↻.</div>';}
}
async function selectCampaign(cid,character){
  if(S.es){S.es.close();S.es=null;el('live').checked=false;}
  S.campaign=cid;S.character=character||'';
  var d=await (await fetch('/api/data?'+query())).json();
  S.names=d.names||{};S.events=d.events||[];S.llm=d.llm||[];S.traces=d.traces||[];S.gameState=d.state;S.playset=d.playset;
  S.maxSeq=S.events.reduce(function(m,e){return Math.max(m,e.seq);},-1);
  S.maxId=S.llm.reduce(function(m,c){return Math.max(m,c.id);},0);
  S.maxTraceSeq=S.traces.reduce(function(m,t){return Math.max(m,t.turnSeq);},-1);
  render();
}
function render(){
  el('count-events').textContent=S.events.length;el('count-llm').textContent=S.llm.length;var ctn=el('count-turns');if(ctn)ctn.textContent=S.traces.length;
  if(S.tab==='cost'&&document.activeElement&&document.activeElement.classList&&document.activeElement.classList.contains('price')){recomputeCost();return;}
  renderTab();
}
function setTab(t){S.tab=t;var ts=document.querySelectorAll('.tab');for(var i=0;i<ts.length;i++)ts[i].classList.toggle('active',ts[i].getAttribute('data-tab')===t);renderTab();}
function renderTab(){
  var m=el('main');
  if(S.tab==='transcript')m.innerHTML=renderTranscript();
  else if(S.tab==='llm'){m.innerHTML=renderLlm();var hs=document.querySelectorAll('.call-head');for(var i=0;i<hs.length;i++)hs[i].onclick=function(){
    var p=this.parentElement;p.classList.toggle('open');
    // The block breakdown is computed server-side on demand — fetch it the first time this call is
    // opened, never for the whole (possibly thousands-long) list.
    if(p.classList.contains('open')){var host=p.querySelector('.brief');if(host)loadBrief(host.getAttribute('data-brief-id'),host);}
  };}
  else if(S.tab==='turns'){m.innerHTML=renderTurns();var ths=document.querySelectorAll('.call-head');for(var i=0;i<ths.length;i++)ths[i].onclick=function(){this.parentElement.classList.toggle('open');};}
  else if(S.tab==='state')m.innerHTML=renderState();
  else{m.innerHTML=renderStats();var pi=el('pi'),po=el('po');
    if(pi)pi.oninput=function(){S.priceIn=parseFloat(this.value)||0;localStorage.setItem('seedPriceIn',S.priceIn);recomputeCost();};
    if(po)po.oninput=function(){S.priceOut=parseFloat(this.value)||0;localStorage.setItem('seedPriceOut',S.priceOut);recomputeCost();};}
}
function renderTranscript(){
  if(!S.events.length)return '<div class="empty">No events yet.</div>';
  var h='';
  S.events.forEach(function(e){
    if(e.kind==='narration')h+='<div class="ev narr">'+esc(e.text)+'</div>';
    else if(e.kind==='dialogue')h+='<div class="ev dlg"><span class="who">'+esc(nameOf(e.actorId))+'</span>'+(e.toId?'<span class="to"> → '+esc(nameOf(e.toId))+'</span>':'')+': '+esc(e.text)+'</div>';
    else if(e.kind==='diceRolled'){var v=e.success===undefined?'':(e.success?'<span class="ok">SUCCESS</span>':'<span class="bad">FAIL</span>');h+='<div class="ev dice">🎲 '+esc(e.purpose||e.notation)+' → <b>'+esc(e.total)+'</b> '+v+'</div>';}
    else if(e.kind==='stateChanged')h+='<div class="ev chg">'+esc(e.summary)+'</div>';
    else if(e.kind==='system')h+='<div class="ev sys">['+esc(e.level)+'] '+esc(e.message)+'</div>';
  });
  return h;
}
function renderLlm(){
  if(!S.llm.length)return '<div class="empty">No model calls logged yet.</div>';
  var h='';var arr=S.llm.slice().reverse();
  arr.forEach(function(c){
    var fin=c.finish==='ok'?'ok':(c.finish==='error'?'bad':'warn');
    var tok=(c.promptTokens||c.completionTokens)?(' · '+(c.promptTokens||0)+'→'+(c.completionTokens||0)+' tok'):'';
    var msgs=(c.request&&c.request.messages)||[];var mh='';
    msgs.forEach(function(m){mh+='<div class="msg"><div class="mrole">'+esc(m.role)+'</div><pre>'+esc(m.content)+'</pre></div>';});
    var reason=c.reasoningText?('<div class="sec"><div class="seclabel">reasoning</div><pre class="reason">'+esc(c.reasoningText)+'</pre></div>'):'';
    var err=c.error?('<div class="sec"><div class="seclabel err">error</div><pre>'+esc(c.error)+'</pre></div>'):'';
    h+='<div class="call"><div class="call-head">'
      +'<span class="badge role-'+esc(c.role)+'">'+esc(c.role)+'</span>'
      +'<span class="model">'+esc(c.model||'—')+'</span><span class="kind">'+esc(c.kind)+'</span>'
      +'<span class="lat">'+esc(c.latencyMs)+'ms'+tok+'</span>'
      +'<span class="fin '+fin+'">'+esc(c.finish)+'</span>'
      +'<span class="time">'+new Date(c.at).toLocaleTimeString()+'</span></div>'
      +'<div class="call-body">'
      +'<div class="sec"><div class="seclabel">brief composition</div><div class="brief" data-brief-id="'+esc(c.id)+'"></div></div>'
      +'<div class="sec"><div class="seclabel">request</div>'+mh+'</div>'
      +'<div class="sec"><div class="seclabel">response</div><pre>'+esc(c.responseText||'(empty)')+'</pre></div>'
      +reason+err+'</div></div>';
  });
  return h;
}
async function loadBrief(id,host){
  if(host.getAttribute('data-loaded'))return;
  host.setAttribute('data-loaded','1');
  host.innerHTML='<div class="dim">…</div>';
  try{var d=await (await fetch('/api/brief?'+query()+'&id='+encodeURIComponent(id))).json();host.innerHTML=renderBrief(d);}
  catch(e){host.innerHTML='<div class="dim">unavailable</div>';}
}
function renderBrief(d){
  if(!d||d.error||!d.blocks||!d.blocks.length)return '<div class="dim">no assembled brief in this call'+(d&&d.error?' ('+esc(d.error)+')':'')+'</div>';
  var tot=d.totalBytes||1,max=1;
  d.blocks.forEach(function(b){if(b.bytes>max)max=b.bytes;});
  // ~t is a 4-bytes-per-token estimate over the BRIEF message only; the provider's promptTokens
  // covers the whole request (system prompt included). They are not meant to reconcile — the
  // estimate is for comparing blocks against each other, not against the bill.
  var h='<div class="dim" style="margin-bottom:6px">'+fmt(tot)+' bytes across '+d.blocks.length+' blocks'
    +' · ~t = 4 bytes/token estimate, for comparing blocks (not the tokenizer)'
    +(d.promptTokens?(' · whole request billed '+fmt(d.promptTokens)+' prompt tokens'):'')+'</div>';
  d.blocks.forEach(function(b){
    h+='<div class="bbrow"><span class="bbkey">'+esc(b.key)+'</span>'
      +'<span class="bar" style="width:'+Math.max(2,Math.round(b.bytes/max*200))+'px"></span>'
      +'<span class="bbn">'+fmt(b.bytes)+'B · ~'+fmt(b.approxTokens)+'t · '+(b.bytes/tot*100).toFixed(1)+'%</span></div>';
    (b.labels||[]).forEach(function(l){
      h+='<div class="bbrow bblab"><span class="bbkey">'+esc(l.label)+'</span><span class="bbn">'+fmt(l.bytes)+'B</span></div>';
    });
  });
  return h;
}
function renderTurns(){
  if(!S.traces.length)return '<div class="empty">No turns traced yet. Play a turn (bun run dev / web) and hit ↻.</div>';
  // Group the LLM calls under the turn they belong to (turnSeq stamped at the call site).
  var byTurn={};S.llm.forEach(function(c){if(c.turnSeq!==undefined&&c.turnSeq!==null){(byTurn[c.turnSeq]||(byTurn[c.turnSeq]=[])).push(c);}});
  var h='';var arr=S.traces.slice().reverse();
  arr.forEach(function(t){
    var calls=byTurn[t.turnSeq]||[];
    var kind=t.classifierKind?esc(t.classifierKind):(t.trigger==='heartbeat'?'heartbeat':'—');
    var tgt=t.classifierTargetId?(' → '+esc(nameOf(t.classifierTargetId))):'';
    var conf=(typeof t.classifierConfidence==='number')?(' <span class="dim">('+t.classifierConfidence.toFixed(2)+')</span>'):'';
    var fb=t.fallback?' <span class="fin bad">freeform-fallback</span>':'';
    var inp=t.input?('<span class="tinput">'+esc(t.input)+'</span>'):(t.npcId?('<span class="dim">'+esc(nameOf(t.npcId))+'</span>'):'');
    var beats='';
    (t.npcBeats||[]).forEach(function(b){beats+='<div class="beat">'+esc(b.name)+(b.dialogue?(': “'+esc(b.dialogue)+'”'):'')+(b.action?(' — '+esc(b.action)):'')+'</div>';});
    (t.eventBeats||[]).forEach(function(e){beats+='<div class="beat dim">· '+esc(e)+'</div>';});
    var beatsSec=beats?('<div class="sec"><div class="seclabel">npc actions</div>'+beats+'</div>'):'';
    var checkSec=t.classifierCheck?('<div class="sec"><div class="seclabel">check</div><pre>'+esc(t.classifierCheck.ability||'?')+' DC '+esc(String(t.classifierCheck.dc))+'</pre></div>'):'';
    var fbSec=t.fallback?('<div class="sec"><div class="seclabel err">fallback reason</div><pre>'+esc(t.fallback)+'</pre></div>'):'';
    var socSec='';
    if(t.socialModifiers&&t.socialModifiers.length){var sm='';t.socialModifiers.forEach(function(s){sm+='<div class="beat dim">'+esc(nameOf(s.actorId))+' → '+esc(nameOf(s.targetId))+': '+esc(s.summary)+'</div>';});
      socSec='<div class="sec"><div class="seclabel">social read</div>'+sm+'</div>';}
    var dropSec='';
    if(t.groundingFallbacks&&t.groundingFallbacks.length){var df='';t.groundingFallbacks.forEach(function(g){var na=g.act?' "'+esc(g.act)+(g.target?' '+esc(g.target):'')+'"':'';df+='<div class="beat dim">'+esc(nameOf(g.actorId))+na+' — '+esc(g.reason)+' <span class="dim">('+(typeof g.confidence==='number'?g.confidence.toFixed(2):'?')+')</span></div>';});
      dropSec='<div class="sec"><div class="seclabel">dropped actions</div>'+df+'</div>';}
    var consentSec='';
    if(t.consentBlocks&&t.consentBlocks.length){var cb='';t.consentBlocks.forEach(function(c){cb+='<div class="beat dim">'+esc(nameOf(c.actorId))+' — '+esc(c.command)+' held for your word <span class="dim">('+esc(c.reason)+', '+esc(c.path)+')</span></div>';});
      consentSec='<div class="sec"><div class="seclabel">consent gate</div>'+cb+'</div>';}
    var auditBadge='';var auditSec='';
    if(t.audit&&t.audit.length){auditBadge=' <span class="fin bad">audit ×'+t.audit.length+'</span>';
      var av='';t.audit.forEach(function(a){av+='<div class="beat">'+esc(a.kind)+' — '+esc(a.detail)+'</div>';});
      auditSec='<div class="sec"><div class="seclabel err">continuity audit</div>'+av+'</div>';}
    var callsSec='';
    if(calls.length){var ch='';calls.forEach(function(c){var fin=c.finish==='ok'?'ok':(c.finish==='error'?'bad':'warn');
      ch+='<div class="tcall"><span class="badge role-'+esc(c.role)+'">'+esc(c.role)+'</span> <span class="model">'+esc(c.model||'—')+'</span> <span class="kind">'+esc(c.kind)+'</span> <span class="fin '+fin+'">'+esc(c.finish)+'</span> <span class="dim">'+esc(c.latencyMs)+'ms</span></div>';});
      callsSec='<div class="sec"><div class="seclabel">model calls ('+calls.length+')</div>'+ch+'</div>';}
    // Per-module attribution: who ran this tick, what they changed, what it cost. The quiet
    // handlers are counted, never dropped — the header always says how many ran without a trace row.
    var modSec='';
    if(t.modules&&t.modules.length){
      var mh='';
      t.modules.forEach(function(m){
        var did=[];
        if(m.applied&&m.applied.length)did.push('<span class="cmds">applied '+esc(m.applied.join(', '))+'</span>');
        if(m.enqueued&&m.enqueued.length)did.push('<span class="cmds">queued '+esc(m.enqueued.join(', '))+'</span>');
        if(m.emitted)did.push('<span class="emi">'+esc(m.emitted)+' ev</span>');
        if(m.error)did.push('<span class="fin bad">'+esc(m.error)+'</span>');
        mh+='<div class="mod'+(m.error?' err':'')+(m.ms>=50?' slow':'')+'">'
          +'<span class="ph">'+esc(m.phase)+'</span><span class="mid">'+esc(m.moduleId)+'</span>'
          +'<span>'+did.join(' · ')+'</span><span class="ms">'+esc(m.ms)+'ms</span></div>';
      });
      modSec='<div class="sec"><div class="seclabel">modules ('+t.modules.length+' active'
        +(t.modulesQuiet?(' · '+t.modulesQuiet+' quiet'):'')+')</div><div class="mods">'+mh+'</div></div>';
    }else if(t.modulesQuiet){
      modSec='<div class="sec"><div class="seclabel">modules</div><div class="dim">'+esc(t.modulesQuiet)+' handlers ran, none changed anything</div></div>';
    }
    var empty=(!checkSec&&!fbSec&&!beatsSec&&!socSec&&!dropSec&&!consentSec&&!auditSec&&!callsSec&&!modSec)?'<div class="sec dim">no recorded detail</div>':'';
    h+='<div class="call"><div class="call-head">'
      +'<span class="badge">#'+esc(t.turnSeq)+'</span>'
      +'<span class="tkind">'+kind+tgt+'</span>'+conf+fb+auditBadge+' '+inp
      +'<span class="lat">'+(calls.length?calls.length+' calls · ':'')+new Date(t.atEnd).toLocaleTimeString()+'</span></div>'
      +'<div class="call-body">'+checkSec+fbSec+beatsSec+socSec+dropSec+consentSec+auditSec+callsSec+modSec+empty+'</div></div>';
  });
  return h;
}
function renderState(){
  var s=S.gameState;if(!s)return '<div class="empty">No saved state.</div>';
  var party=(s.party||[]).map(nameOf).join(', ');var comp=(s.companions||[]).map(nameOf).join(', ');
  var quests='';if(s.quests)Object.keys(s.quests).forEach(function(q){quests+='<div class="row"><span>'+esc(questName(q))+'</span><span class="dim">'+esc(s.quests[q])+'</span></div>';});
  var actors='';if(s.actors)Object.keys(s.actors).forEach(function(id){var a=s.actors[id];actors+='<div class="row"><span>'+esc(nameOf(id))+'</span><span class="dim">'+esc(a.currentHp)+' hp · '+esc(locName(a.locationId))+'</span></div>';});
  return '<div class="state">'
    +'<div class="card"><h3>Party</h3>'
    +'<div class="row"><span>Location</span><span>'+esc(locName(s.partyLocationId))+'</span></div>'
    +'<div class="row"><span>Time</span><span>+'+esc(s.clock)+' min</span></div>'
    +'<div class="row"><span>Player(s)</span><span>'+esc(party)+'</span></div>'
    +'<div class="row"><span>Companions</span><span>'+esc(comp)+'</span></div></div>'
    +'<div class="card"><h3>Quests</h3>'+(quests||'<div class="dim">none</div>')+'</div>'
    +'<div class="card"><h3>Actors</h3>'+(actors||'<div class="dim">none</div>')+'</div>'
    +'<div class="card"><h3>Raw state</h3><pre>'+esc(JSON.stringify(s,null,2))+'</pre></div></div>';
}
function fmt(n){return n>=1000?(n/1000).toFixed(n>=10000?0:1)+'k':String(n);}
function card(label,val,sub,id){return '<div class="stat"><div class="slabel">'+label+'</div><div class="sval"'+(id?' id="'+id+'"':'')+'>'+val+'</div><div class="ssub">'+sub+'</div></div>';}
function cost(p,k){return (p/1e6*S.priceIn)+(k/1e6*S.priceOut);}
function renderStats(){
  var calls=S.llm;if(!calls.length)return '<div class="empty">No model calls yet.</div>';
  var n=calls.length,pt=0,ct=0,lat=0,ok=0,empty=0,err=0,roles={};
  calls.forEach(function(c){var p=c.promptTokens||0,k=c.completionTokens||0,l=c.latencyMs||0;pt+=p;ct+=k;lat+=l;
    if(c.finish==='ok')ok++;else if(c.finish==='empty')empty++;else err++;
    var r=roles[c.role]||(roles[c.role]={calls:0,pt:0,ct:0,lat:0});r.calls++;r.pt+=p;r.ct+=k;r.lat+=l;});
  var tot=pt+ct;var tps=lat>0?(ct/(lat/1000)):0;var avg=n?lat/n:0;
  var fin=ok+' ok'+(empty?' · '+empty+' empty':'')+(err?' · '+err+' err':'');
  var cards='<div class="cards">'
    +card('Calls',n,fin)
    +card('Tokens',fmt(tot),fmt(pt)+' in → '+fmt(ct)+' out')
    +card('Throughput',tps.toFixed(1)+' tok/s','completion / wall-time')
    +card('Avg latency',Math.round(avg)+' ms','per call')
    +card('Est. cost','$'+cost(pt,ct).toFixed(4),'at the prices below','cost-total')+'</div>';
  var prices='<div class="pricebar">$ / 1M tokens — input <input class="price" id="pi" type="number" min="0" step="0.01" value="'+S.priceIn+'"> output <input class="price" id="po" type="number" min="0" step="0.01" value="'+S.priceOut+'"> <span class="dim">(leave 0 for local / free models)</span></div>';
  var rows='';Object.keys(roles).forEach(function(rn){var r=roles[rn];var rt=r.lat>0?(r.ct/(r.lat/1000)).toFixed(1):'—';
    rows+='<tr><td class="role-'+rn+'">'+rn+'</td><td>'+r.calls+'</td><td>'+fmt(r.pt)+'</td><td>'+fmt(r.ct)+'</td><td>'+Math.round(r.lat/r.calls)+' ms</td><td>'+rt+'</td><td id="cost-'+rn+'">$'+cost(r.pt,r.ct).toFixed(4)+'</td></tr>';});
  var table='<table class="stats"><thead><tr><th>role</th><th>calls</th><th>in tok</th><th>out tok</th><th>avg lat</th><th>tok/s</th><th>$</th></tr></thead><tbody>'+rows+'</tbody></table>';
  var note='<div class="dim" style="margin-top:10px">Token counts come from the model usage report (streaming uses stream_options.include_usage); calls without a report count as 0.</div>';
  return cards+prices+table+note;
}
function recomputeCost(){if(S.tab!=='cost')return;var pt=0,ct=0,roles={};S.llm.forEach(function(c){var p=c.promptTokens||0,k=c.completionTokens||0;pt+=p;ct+=k;var r=roles[c.role]||(roles[c.role]={pt:0,ct:0});r.pt+=p;r.ct+=k;});var t=el('cost-total');if(t)t.textContent='$'+cost(pt,ct).toFixed(4);Object.keys(roles).forEach(function(rn){var e=el('cost-'+rn);if(e)e.textContent='$'+cost(roles[rn].pt,roles[rn].ct).toFixed(4);});}
function toggleLive(){
  if(el('live').checked){
    S.es=new EventSource('/api/stream?'+query()+'&sinceSeq='+S.maxSeq+'&sinceId='+S.maxId+'&sinceTraceSeq='+S.maxTraceSeq);
    S.es.onmessage=function(ev){
      var d=JSON.parse(ev.data);var changed=false;
      if(d.events&&d.events.length){d.events.forEach(function(e){S.events.push(e);S.maxSeq=Math.max(S.maxSeq,e.seq);});changed=true;}
      if(d.llm&&d.llm.length){d.llm.forEach(function(c){S.llm.push(c);S.maxId=Math.max(S.maxId,c.id);});changed=true;}
      if(d.traces&&d.traces.length){d.traces.forEach(function(t){S.traces.push(t);S.maxTraceSeq=Math.max(S.maxTraceSeq,t.turnSeq);});changed=true;}
      if(changed)render();
    };
    S.es.onerror=function(){};
  }else if(S.es){S.es.close();S.es=null;}
}
function exportFile(fmt){window.open('/api/export?'+query()+'&format='+fmt);}
window.onload=function(){
  S.priceIn=parseFloat(localStorage.getItem('seedPriceIn'))||0;
  S.priceOut=parseFloat(localStorage.getItem('seedPriceOut'))||0;
  loadCampaigns();
  el('campaign').onchange=function(){var v=splitOption(this.value);selectCampaign(v.campaignId,v.characterId);};
  el('refresh').onclick=function(){if(S.campaign)selectCampaign(S.campaign,S.character);else loadCampaigns();};
  el('live').onchange=toggleLive;
  el('exp-md').onclick=function(){exportFile('md');};
  el('exp-json').onclick=function(){exportFile('json');};
  var ts=document.querySelectorAll('.tab');for(var i=0;i<ts.length;i++)ts[i].onclick=function(){setTab(this.getAttribute('data-tab'));};
};
</script>
</body>
</html>`;
