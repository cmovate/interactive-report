// Campaign Edit Modal — loaded by campaigns.html
// ══════════════════════════════════════════════════════════════════
// CAMPAIGN EDIT MODAL
// ══════════════════════════════════════════════════════════════════

// State vars declared as globals in campaigns.html (var cmId, cmData, etc.)
// Initialized here:
cmId = null; cmData = null; cmTab = null; cmLoaded = {}; cmSettings = null; cmCtPage = 1;
msgEditCanvas = null;
CKEY.new = 'new'; CKEY.existingNo = 'existing_no_history'; CKEY.existingYes = 'existing_with_history';

async function openCampaignModal(id) {
  cmId = id; cmData = null; cmLoaded = {}; cmSettings = null; cmCtPage = 1;
  document.getElementById('cm-name').textContent = 'Loading...';
  document.getElementById('cm-meta').textContent = '';
  document.getElementById('cm-st-btn').textContent = '';
  document.getElementById('cm-back').style.display = 'flex';
  ['analytics','companies','audience','settings'].forEach(t => document.getElementById('cmb-'+t).innerHTML = '');
  try {
    const d = await fetch('/api/campaigns/'+id+'?workspace_id='+workspaceId).then(r=>r.json());
    if (d.error) throw new Error(d.error);
    cmData = d;
    const s = typeof d.settings==='string' ? JSON.parse(d.settings) : (d.settings||{});
    cmSettings = JSON.parse(JSON.stringify(s));
    document.getElementById('cm-name').textContent = d.name;
    document.getElementById('cm-meta').textContent =
      (d.audience_type==='company'?'Company targeting':'People targeting') +
      ' \u00b7 ' + (d.account_id||'\u2014') +
      ' \u00b7 ' + (parseInt(d.contact_count)||0) + ' contacts';
    const sb = document.getElementById('cm-st-btn');
    sb.textContent = d.status==='active' ? '\u23f8 Pause' : '\u25b6 Resume';
    sb.style.color  = d.status==='active' ? '#DC2626' : '#1D9E75';
  } catch(e) { document.getElementById('cm-name').textContent='Error: '+e.message; }
  switchCMTab('analytics');
}

function closeCM() {
  document.getElementById('cm-back').style.display = 'none';
  cmId = cmData = null;
}

async function switchCMTab(tab) {
  cmTab = tab;
  document.querySelectorAll('.cm-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.cm-body').forEach(el=>el.style.display=el.id==='cmb-'+tab?'block':'none');
  document.getElementById('cm-foot').style.display = tab==='settings'?'flex':'none';
  if (!cmLoaded[tab]) { cmLoaded[tab]=true; await loadCMTab(tab); }
}

async function loadCMTab(tab) {
  const el = document.getElementById('cmb-'+tab);
  el.innerHTML = '<div class="tab-spin">Loading...</div>';
  try {
    if (tab==='analytics') {
      const d = await fetch('/api/campaigns/'+cmId+'/ab-analytics?workspace_id='+workspaceId).then(r=>r.json());
      el.innerHTML = buildAnalyticsHTML(d);
    } else if (tab==='companies') {
      const d = await fetch('/api/campaigns/'+cmId+'/companies?workspace_id='+workspaceId).then(r=>r.json());
      el.innerHTML = buildCompaniesHTML(d.items||[]);
    } else if (tab==='audience') {
      await loadCMContacts(1);
    } else if (tab==='settings') {
      el.innerHTML = buildSettingsHTML();
    }
  } catch(e) { el.innerHTML = '<div class="tab-err">Error: '+esc(e.message)+'</div>'; }
}

function buildAnalyticsHTML(data) {
  const o = data.overall||{};
  const iap = parseInt(o.invites_sent)>0 ? Math.round(parseInt(o.invites_approved)/parseInt(o.invites_sent)*100) : 0;
  const rr  = parseInt(o.messages_sent)>0? Math.round(parseInt(o.messages_replied)/parseInt(o.messages_sent)*100): 0;
  let html = `<div class="analytics-section-label">Overview</div>
    <div class="overview-grid">
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.total_contacts)||0}</div><div class="overview-card-label">Contacts</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.invites_sent)||0}</div><div class="overview-card-label">Invites sent</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.invites_approved)||0}</div><div class="overview-card-rate">${iap}%</div><div class="overview-card-label">Approved</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.messages_sent)||0}</div><div class="overview-card-label">Msgs sent</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.messages_replied)||0}</div><div class="overview-card-rate">${rr}%</div><div class="overview-card-label">Replied</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.positive_replies)||0}</div><div class="overview-card-label">Positive</div></div>
      <div class="overview-card"><div class="overview-card-num">${parseInt(o.total_msgs_sent)||0}</div><div class="overview-card-label">Total msgs</div></div>
    </div><div class="analytics-section-label">A/B/C message performance</div>`;
  const steps = data.steps||[];
  if (!steps.length) return html+'<div class="no-ab-msg">No messages sent yet.</div>';
  const VC={A:'variant-a',B:'variant-b',C:'variant-c'};
  return html + steps.map(step=>{
    const vs=step.variants||[]; if(!vs.length)return '';
    const mx=Math.max(...vs.map(v=>v.rate)); const isAB=vs.length>1;
    const rows=vs.map(v=>{
      const best=isAB&&v.rate===mx&&mx>0; const bw=mx>0?Math.round(v.rate/mx*80):0;
      return `<tr class="${best?'best-row':''}"><td><span class="variant-pill ${VC[v.label]||'variant-a'}">${v.label}</span>${best?'<span class="best-badge">&#10003; Best</span>':''}</td><td style="font-weight:600;">${v.sent}</td><td>${v.replied}</td><td><div class="rate-bar-wrap"><div class="rate-bar" style="width:${bw}px;"></div><span class="rate-text">${v.rate}%</span></div></td></tr>`;
    }).join('');
    const di=step.delay?` \u2014 wait ${step.delay} ${step.unit}`:'';
    return `<div class="ab-step-block"><div class="ab-step-title">Message ${step.step}${di}</div><table class="ab-table"><thead><tr><th>Variant</th><th>Sent</th><th>Replied</th><th>Reply rate</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
}

function buildCompaniesHTML(companies) {
  const sc = cmData?.settings?.searchConfig;
  const auto = cmData?.audience_type==='company' && sc?.titles?.length;
  let tbl = '';
  if (!companies.length) {
    tbl = '<div style="text-align:center;color:#aaa;padding:40px;background:#fafafa;border-radius:10px;">No companies in this campaign yet.</div>';
  } else {
    const rows = companies.map(co=>{
      const li = co.li_company_url ? `<a class="cell-link" href="${esc(safeUrl(co.li_company_url))}" target="_blank" rel="noopener">LinkedIn &#8599;</a>` : '<span style="color:#ccc;">\u2014</span>';
      const dt = co.created_at ? new Date(co.created_at).toLocaleDateString() : '\u2014';
      return `<tr><td style="font-weight:500;">${esc(co.company_name||'\u2014')}</td><td>${li}</td><td style="text-align:center;color:#888;">${co.contact_count||0}</td><td style="color:#aaa;font-size:12px;">${dt}</td></tr>`;
    }).join('');
    tbl = `<div class="tbl-wrap"><table class="cm-table"><thead><tr><th>Company</th><th>LinkedIn</th><th style="text-align:center;">Contacts</th><th>Added</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const autoInfo = auto
    ? `<div class="auto-box">&#10003; Auto-search: will find <strong>${esc(sc.titles.join(', '))}</strong> &middot; Max <strong>${sc.maxPerCompany||10}</strong> per company</div>`
    : `<p style="font-size:12px;color:#888;margin-bottom:10px;">Enter job titles to search for at each company.</p><div style="display:flex;gap:10px;margin-bottom:10px;"><div style="flex:1;"><label class="fsl">Job titles</label><input type="text" id="add-co-titles" style="width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;font-family:inherit;" placeholder="VP R&D, CTO"></div><div><label class="fsl">Max/co.</label><input type="number" id="add-co-lim" style="width:64px;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;text-align:center;" value="10" min="1" max="50"></div></div>`;
  return `<div style="font-size:14px;font-weight:500;margin-bottom:14px;">${companies.length} compan${companies.length!==1?'ies':'y'} in this campaign</div>
    ${tbl}
    <div class="add-card"><div class="add-card-title">+ Add more companies</div>${autoInfo}
      <textarea id="add-co-ta" class="add-ta" rows="4" placeholder="Paste LinkedIn company URLs (one per line)&#10;https://www.linkedin.com/company/example"></textarea>
      <div id="add-co-res" class="add-res"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="primary-btn" id="add-co-btn" onclick="addCMCompanies()">&#128269; Search &amp; Add</button></div>
    </div>`;
}

async function addCMCompanies() {
  const ta=document.getElementById('add-co-ta');
  const urls=(ta?.value||'').split('\n').map(s=>s.trim()).filter(s=>s.includes('linkedin.com/company/'));
  if (!urls.length) { alert('Please paste at least one LinkedIn company URL.'); return; }
  const sc=cmData?.settings?.searchConfig;
  const auto=cmData?.audience_type==='company'&&sc?.titles?.length;
  let titles,limit;
  if(auto){titles=sc.titles;limit=sc.maxPerCompany||10;}
  else{titles=(document.getElementById('add-co-titles')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);limit=parseInt(document.getElementById('add-co-lim')?.value)||10;if(!titles.length){alert('Please enter job titles.');return;}}
  const res=document.getElementById('add-co-res'),btn=document.getElementById('add-co-btn');
  res.innerHTML='<span style="color:#888;">&#8987; Searching... this may take a few minutes</span>';btn.disabled=true;btn.textContent='Searching...';
  const cos=urls.map(u=>{const sl=(u.match(/linkedin\.com\/company\/([^/?&#\s]+)/i)||[])[1]||'';return{name:sl.split('-').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' '),url:u};});
  try{
    const r=await fetch('/api/opportunities/attach-to-campaign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:cmData.workspace_id,campaign_id:cmId,companies:cos,titles,limit})});
    const d=await r.json();if(!r.ok)throw new Error(d.error);
    res.innerHTML=`<span style="color:#0F6E56;">&#10003; ${d.contacts_added} contacts added &middot; ${d.companies_searched} searched &middot; ${d.contacts_found} found</span>`;
    ta.value='';cmLoaded.companies=false;cmLoaded.audience=false;
    if(cmTab==='companies'){cmLoaded.companies=true;const d2=await fetch('/api/campaigns/'+cmId+'/companies?workspace_id='+workspaceId).then(r=>r.json());document.getElementById('cmb-companies').innerHTML=buildCompaniesHTML(d2.items||[]);}
    load();
  }catch(e){res.innerHTML=`<span style="color:#DC2626;">&#10007; ${esc(e.message)}</span>`;}
  finally{btn.disabled=false;btn.innerHTML='&#128269; Search &amp; Add';}
}

async function loadCMContacts(page){
  cmCtPage=page;
  const el=document.getElementById('cmb-audience');
  if(!el.innerHTML.includes('cm-table'))el.innerHTML='<div class="tab-spin">Loading...</div>';
  try{const d=await fetch(`/api/campaigns/${cmId}/contacts?workspace_id=${workspaceId}&page=${page}&limit=50`).then(r=>r.json());el.innerHTML=buildAudienceHTML(d);}
  catch(e){el.innerHTML=`<div class="tab-err">Error: ${esc(e.message)}</div>`;}
}

function buildAudienceHTML(data){
  const{items=[],total=0,page=1,pages=1}=data;
  let tbl='';
  if(!items.length){tbl='<div style="text-align:center;color:#aaa;padding:40px;background:#fafafa;border-radius:10px;">No contacts yet.</div>';}
  else{
    const rows=items.map(c=>{const name=[c.first_name,c.last_name].filter(Boolean).join(' ')||'(unknown)';const nameEl=c.li_profile_url?`<a class="cell-link" href="${esc(safeUrl(c.li_profile_url))}" target="_blank" rel="noopener" style="font-weight:500;">${esc(name)}</a>`:`<span style="font-weight:500;">${esc(name)}</span>`;return`<tr><td>${nameEl}</td><td style="font-size:12px;color:#666;">${esc(c.title||'\u2014')}</td><td style="font-size:12px;color:#888;">${esc(c.company||'\u2014')}</td><td>${buildChips(c)}</td><td><button class="rm-btn" onclick="removeCMContact(${c.id})" title="Remove">&times;</button></td></tr>`;}).join('');
    tbl=`<div class="tbl-wrap"><table class="cm-table"><thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  let pager='';
  if(pages>1){const b=[`<button class="pg" onclick="loadCMContacts(${page-1})" ${page<=1?'disabled':''}>&#8249; Prev</button>`];for(let p=Math.max(1,page-2);p<=Math.min(pages,page+2);p++)b.push(`<button class="pg${p===page?' on':''}" onclick="loadCMContacts(${p})">${p}</button>`);b.push(`<button class="pg" onclick="loadCMContacts(${page+1})" ${page>=pages?'disabled':''}>Next &#8250;</button>`);pager=`<div class="pager">${b.join('')}</div>`;}
  return`<div style="font-size:14px;font-weight:500;margin-bottom:14px;">${total} contact${total!==1?'s':''}</div>
    ${tbl}${pager}
    <div class="add-card"><div class="add-card-title">+ Add contacts</div>
      <p style="font-size:12px;color:#888;margin-bottom:10px;">Paste LinkedIn profile URLs (one per line). Contacts will be enriched automatically.</p>
      <textarea id="add-ct-ta" class="add-ta" rows="4" placeholder="https://www.linkedin.com/in/johndoe&#10;https://www.linkedin.com/in/janedoe"></textarea>
      <div id="add-ct-res" class="add-res"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="primary-btn" id="add-ct-btn" onclick="addCMContacts()">+ Add contacts</button></div>
    </div>`;
}

function buildChips(c){
  const ch=[];
  if(c.positive_reply)ch.push('<span class="sc sc-g">&#10003; Replied</span>');
  else if(c.msg_replied)ch.push('<span class="sc sc-t">Replied</span>');
  else if(c.msg_sent)ch.push('<span class="sc sc-x">Messaged</span>');
  if(c.already_connected)ch.push('<span class="sc sc-g">Connected</span>');
  else if(c.invite_approved)ch.push('<span class="sc sc-g">Approved</span>');
  else if(c.invite_sent)ch.push('<span class="sc sc-b">Invited</span>');
  return ch.length?ch.join(''):'<span class="sc sc-x">New</span>';
}

async function addCMContacts(){
  const ta=document.getElementById('add-ct-ta');
  const urls=(ta?.value||'').split('\n').map(s=>s.trim()).filter(s=>s.includes('linkedin.com/in/'));
  if(!urls.length){alert('Please paste at least one LinkedIn profile URL (linkedin.com/in/...).');return;}
  const res=document.getElementById('add-ct-res'),btn=document.getElementById('add-ct-btn');
  res.innerHTML='<span style="color:#888;">&#8987; Adding...</span>';btn.disabled=true;btn.textContent='Adding...';
  try{
    const r=await fetch(`/api/campaigns/${cmId}/contacts`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,contacts:urls.map(li_profile_url=>({li_profile_url}))})});
    const d=await r.json();if(!r.ok)throw new Error(d.error);
    res.innerHTML=`<span style="color:#0F6E56;">&#10003; ${d.added} added &middot; ${d.skipped} skipped &middot; ${d.enrichment_queued} enrichment queued</span>`;
    ta.value='';await loadCMContacts(1);load();
  }catch(e){res.innerHTML=`<span style="color:#DC2626;">&#10007; ${esc(e.message)}</span>`;}
  finally{btn.disabled=false;btn.textContent='+ Add contacts';}
}

async function removeCMContact(cid){
  if(!confirm('Remove this contact from the campaign?'))return;
  try{const r=await fetch(`/api/campaigns/${cmId}/contacts/${cid}?workspace_id=${workspaceId}`,{method:'DELETE'});if(!r.ok)throw new Error((await r.json()).error);await loadCMContacts(cmCtPage);load();}
  catch(e){alert('Failed: '+e.message);}
}

function buildSettingsHTML(){
  if(!cmSettings)return'<div class="tab-spin">Settings not available.</div>';
  const s=cmSettings,conn=s.connection||{},eng=s.engagement||{},hrs=s.hours||{};
  const ce=conn.enabled!==false,wo=!!conn.withdraw_after_days,wd=conn.withdraw_after_days||14,re=!!conn.resend;
  const dh=DAYS.map(d=>{const h=hrs[d.key]||{on:parseInt(d.key)<=5,from:'09:00',to:'18:00'};
    return`<div class="day-card${h.on?'':' off'}" id="edc-${d.key}"><div class="day-head"><span class="day-name">${d.label}</span><button class="day-toggle${h.on?' on':''}" id="edt-${d.key}" onclick="teDay('${d.key}')"></button></div><div id="ets-${d.key}"${h.on?'':' style="display:none;"'}><div class="time-inputs"><div class="time-row"><span class="time-lbl">from</span><input class="time-input" type="time" value="${h.from}" onchange="uh('${d.key}','from',this.value)"></div><div class="time-row"><span class="time-lbl">to</span><input class="time-input" type="time" value="${h.to}" onchange="uh('${d.key}','to',this.value)"></div></div></div><div id="eoff-${d.key}" class="day-off-label"${h.on?' style="display:none;"':''}>off</div></div>`;}).join('');
  const eh=ENGAGEMENT_ACTIONS.map(a=>`<div class="engagement-item"><div><div class="eng-label">${a.label}</div>${a.sub?`<div class="eng-sub">${a.sub}</div>`:''}</div><button class="toggle${eng[a.key]?' on':''}" id="ee-${a.key}" onclick="teEng('${a.key}')"></button></div>`).join('');
  return`
    <div class="section-label">Connection requests</div>
    <div class="conn-section">
      <div class="conn-row"><div><div class="conn-label">Send connection requests</div><div class="conn-sub">Automatically send LinkedIn invites to all prospects</div></div><button class="toggle${ce?' on':''}" id="ect" onclick="teConn()"></button></div>
      <div id="eco" class="conn-options" style="display:${ce?'':'none'};">
        <div class="conn-opt-row"><div class="conn-opt-label">Withdraw if not accepted after</div><div style="display:flex;align-items:center;gap:8px;"><input class="num-input" type="number" value="${wd}" min="1" id="ewd" oninput="if(cmSettings.connection)cmSettings.connection.withdraw_after_days=parseInt(this.value)||14"> days<button class="toggle${wo?' on':''}" id="ewt" onclick="teWd()"></button></div></div>
        <div id="ert" class="conn-opt-row" style="display:${wo?'':'none'};"><div class="conn-opt-label">Resend request after 21+ days</div><button class="toggle${re?' on':''}" id="ert-btn" onclick="teRes()"></button></div>
      </div>
    </div>
    <div class="section-label" style="margin-top:24px;">Message sequences</div>
    <div class="sequence-grid" id="cm-msgs">${buildCMSeqHTML()}</div>
    <div class="section-label" style="margin-top:24px;">Engagement actions</div>
    <div class="engagement-list">${eh}</div>
    <div class="section-label" style="margin-top:24px;">Working hours</div>
    <div style="font-size:12px;color:#888;margin-bottom:10px;">Campaign only runs during these hours (server timezone).</div>
    <div class="hours-grid">${dh}</div><div style="height:20px;"></div>`;
}

function buildCMSeqHTML(){
  const msgs=cmSettings?.messages||{};
  function cards(arr,canvas){return(arr||[]).map((m,i)=>{const v0=(m.variants||[])[0]||(m.text?{text:m.text}:{text:''});const preview=v0.text||'';const bgs=(m.variants||[]).length>1?`<span class="variant-badge">${(m.variants||[]).map(v=>`<span class="vbadge vbadge-${v.label.toLowerCase()}">${v.label}</span>`).join('')}</span>`:'';return`<div class="seq-msg"><button class="seq-msg-remove" onclick="removeCMMsg('${canvas}',${i})">&times;</button><div class="seq-msg-delay">Wait ${m.delay} ${m.unit} ${bgs}</div><div class="seq-msg-text">${esc(preview.slice(0,80))}${preview.length>80?'...':''}</div></div>`;}).join('')+`<button class="add-msg-btn" onclick="openCMMsg('${canvas}')">+ Add message</button>`;}
  return`<div class="sequence-canvas"><div class="seq-head"><div class="seq-head-title">New contacts</div><div class="seq-head-sub">Not yet connected</div></div><div class="seq-body">${cards(msgs.new,'new')}</div></div><div style="display:flex;flex-direction:column;gap:10px;"><div class="sequence-canvas"><div class="seq-head"><div class="seq-head-title">Existing \u2014 no history</div><div class="seq-head-sub">Connected, never messaged</div></div><div class="seq-body">${cards(msgs.existing_no_history,'existingNo')}</div></div><div class="sequence-canvas"><div class="seq-head"><div class="seq-head-title">Existing \u2014 with history</div><div class="seq-head-sub">Connected, previous conversation</div></div><div class="seq-body">${cards(msgs.existing_with_history,'existingYes')}</div></div></div>`;
}

function refreshCMSeq(){const e=document.getElementById('cm-msgs');if(e)e.innerHTML=buildCMSeqHTML();}
function removeCMMsg(canvas,i){const key=CKEY[canvas];if(cmSettings?.messages?.[key]){cmSettings.messages[key].splice(i,1);refreshCMSeq();}}

function openCMMsg(canvas){
  msgEditCanvas=canvas;
  const titles={new:'New contacts',existingNo:'Existing \u2014 no history',existingYes:'Existing \u2014 with history'};
  document.getElementById('msg-dialog-title').textContent='Add message \u2014 '+titles[canvas];
  document.getElementById('msg-delay-val').value=3;
  document.getElementById('msg-delay-unit').value='days';
  dlgVariants=[{label:'A',text:''}];
  renderDlgVariants();
  document.getElementById('msg-dialog').style.display='flex';
}

function teConn(){if(!cmSettings.connection)cmSettings.connection={};cmSettings.connection.enabled=!(cmSettings.connection.enabled!==false);document.getElementById('ect')?.classList.toggle('on',!!cmSettings.connection.enabled);const o=document.getElementById('eco');if(o)o.style.display=cmSettings.connection.enabled?'':'none';}
function teWd(){if(!cmSettings.connection)cmSettings.connection={};const curr=!!cmSettings.connection.withdraw_after_days;cmSettings.connection.withdraw_after_days=curr?0:(parseInt(document.getElementById('ewd')?.value)||14);document.getElementById('ewt')?.classList.toggle('on',!!cmSettings.connection.withdraw_after_days);const r=document.getElementById('ert');if(r)r.style.display=cmSettings.connection.withdraw_after_days?'':'none';}
function teRes(){if(!cmSettings.connection)cmSettings.connection={};cmSettings.connection.resend=!cmSettings.connection.resend;document.getElementById('ert-btn')?.classList.toggle('on',!!cmSettings.connection.resend);}
function teEng(key){if(!cmSettings.engagement)cmSettings.engagement={};cmSettings.engagement[key]=!cmSettings.engagement[key];document.getElementById('ee-'+key)?.classList.toggle('on',!!cmSettings.engagement[key]);}
function teDay(key){if(!cmSettings.hours)cmSettings.hours={};if(!cmSettings.hours[key])cmSettings.hours[key]={on:false,from:'09:00',to:'18:00'};cmSettings.hours[key].on=!cmSettings.hours[key].on;const on=cmSettings.hours[key].on;document.getElementById('edc-'+key)?.classList.toggle('off',!on);document.getElementById('edt-'+key)?.classList.toggle('on',on);const ts=document.getElementById('ets-'+key),of=document.getElementById('eoff-'+key);if(ts)ts.style.display=on?'':'none';if(of)of.style.display=on?'none':'';}
function uh(key,field,val){if(!cmSettings.hours)cmSettings.hours={};if(!cmSettings.hours[key])cmSettings.hours[key]={on:true,from:'09:00',to:'18:00'};cmSettings.hours[key][field]=val;}

async function toggleCMStatus(){
  if(!cmData)return;
  const ns=cmData.status==='active'?'paused':'active';
  try{const r=await fetch(`/api/campaigns/${cmId}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,status:ns})});if(!r.ok)throw new Error((await r.json()).error);cmData.status=ns;const btn=document.getElementById('cm-st-btn');btn.textContent=ns==='active'?'\u23f8 Pause':'\u25b6 Resume';btn.style.color=ns==='active'?'#DC2626':'#1D9E75';load();}
  catch(e){alert('Failed: '+e.message);}
}

async function saveCMSettings(){
  const btn=document.getElementById('cm-save-btn');
  btn.disabled=true;btn.textContent='Saving...';
  try{const r=await fetch(`/api/campaigns/${cmId}/settings`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,settings:cmSettings})});if(!r.ok)throw new Error((await r.json()).error);if(cmData)cmData.settings=JSON.parse(JSON.stringify(cmSettings));btn.textContent='\u2713 Saved!';setTimeout(()=>{btn.disabled=false;btn.textContent='Save settings';},2000);load();}
  catch(e){alert('Failed: '+e.message);btn.disabled=false;btn.textContent='Save settings';}
}

function safeUrl(u){u=(u||'').trim();return /^https?:\/\//i.test(u)?u:'https://'+u;}
