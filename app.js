'use strict';
/* Journal de Lecture — PWA
 * Coquille statique (GitHub Pages) -> API Apps Script (doPost) -> Google Sheet.
 * CONFIG par défaut ci-dessous ; surchargeable via ⚙️ Réglages avancés.
 */
const DEFAULTS = {
  API_URL: 'https://script.google.com/macros/s/AKfycbz9FB3JSNRygCu4ZC8uYkvNO7W4nzqPlzCS-hEaHMa5faSARLhzvKD7_0QORUVY_PDh3Q/exec',
  GOOGLE_CLIENT_ID: '291608936405-ddbgkq5hchqu42n3k92ajo95guokt6vn.apps.googleusercontent.com',
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/1uCvIGRItUcnlIsNZSl7UXlFm2N-h5_V3lt9u3O2cgyo/edit',
};

/* ------------------------------------------------------------------ store -- */
const store = {
  get apiUrl(){ return localStorage.getItem('jdl.apiUrl') || DEFAULTS.API_URL; },
  set apiUrl(v){ v ? localStorage.setItem('jdl.apiUrl', v) : localStorage.removeItem('jdl.apiUrl'); },
  get clientId(){ return localStorage.getItem('jdl.clientId') || DEFAULTS.GOOGLE_CLIENT_ID; },
  set clientId(v){ v ? localStorage.setItem('jdl.clientId', v) : localStorage.removeItem('jdl.clientId'); },
  get session(){ try{ return JSON.parse(localStorage.getItem('jdl.session') || 'null'); }catch(e){ return null; } },
  set session(v){ v ? localStorage.setItem('jdl.session', JSON.stringify(v)) : localStorage.removeItem('jdl.session'); },
  get queue(){ try{ return JSON.parse(localStorage.getItem('jdl.queue') || '[]'); }catch(e){ return []; } },
  set queue(v){ localStorage.setItem('jdl.queue', JSON.stringify(v)); },
  get bootCache(){ try{ return JSON.parse(localStorage.getItem('jdl.boot') || 'null'); }catch(e){ return null; } },
  set bootCache(v){ try{ localStorage.setItem('jdl.boot', JSON.stringify(v)); }catch(e){} },
  get running(){ try{ return JSON.parse(localStorage.getItem('jdl.running') || 'null'); }catch(e){ return null; } },
  set running(v){ v ? localStorage.setItem('jdl.running', JSON.stringify(v)) : localStorage.removeItem('jdl.running'); },
};

/* -------------------------------------------------------------------- API -- */
class ApiError extends Error {}

async function rawPost(payload){
  let resp;
  try{
    resp = await fetch(store.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request => pas de préflight CORS
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  }catch(e){ throw new ApiError('network'); }
  let json;
  try{ json = await resp.json(); }catch(e){ throw new ApiError('bad_response'); }
  if(!json.ok) throw new ApiError(json.error || 'error');
  return json.data;
}

async function api(action, payload){
  const s = store.session;
  if(!s || s.exp < Date.now()) throw new ApiError('unauthorized');
  return rawPost({ action: action, token: s.token, payload: payload || {} });
}
async function apiLogin(googleToken){ return rawPost({ action: 'login', googleToken: googleToken }); }

/* écriture avec file d'attente hors ligne */
async function mut(action, payload){
  try{
    const r = await api(action, payload);
    if(r && r.bootstrap) setBoot(r.bootstrap);
    return r || {};
  }catch(e){
    if(e.message === 'network' || e.message === 'unauthorized'){
      const q = store.queue; q.push({ action: action, payload: payload }); store.queue = q;
      updateOfflineUi();
      if(e.message === 'unauthorized') scheduleReauth();
      return { offline: true };
    }
    throw e;
  }
}

/* ------------------------------------------------ écriture optimiste --- */
/* Applique la modif localement tout de suite (rendu instantané), puis
   synchronise en arrière-plan. La réponse serveur recale l'état exact.   */
function rechargerBoot(){ return api('bootstrap').then(b => { setBoot(b); renderActif(); }).catch(function(){}); }

function livreLocal(titre){ return ((BOOT && BOOT.livres) || []).filter(x => x.titre === titre)[0] || null; }
function patchLivre(titre, patch){ const l = livreLocal(titre); if(l) Object.assign(l, patch); return l; }
function setFavoriLocal(titre){
  ((BOOT && BOOT.livres) || []).forEach(l => { l.favori = (l.titre === titre); });
  if(BOOT) BOOT.livreChrono = titre;
}
function addSessionLocal(p){
  const min = Math.max(0, Math.round(+p.minutes || 0));
  const s = { id:'opt-'+Date.now(), date:p.date, livre:p.livre, minutes:min, source:p.source||'manuel', note:p.note||'' };
  BOOT.sessionsRecent = [s].concat(BOOT.sessionsRecent || []);
  let l = livreLocal(p.livre);
  if(!l){
    l = { titre:p.livre, format:'Autre', nature:'Parallèle', statut:'En cours', serie:'', favori:false,
      note:0, commentaire:'', alias:'', totalMinutes:0, sessionsCount:0, joursActifs:0,
      premiere:p.date, derniere:p.date, debut:p.date, fin:'', dureeCal:1, moyJourActif:0, joursDepuis:0 };
    BOOT.livres.push(l);
  }
  l.totalMinutes = (l.totalMinutes||0) + min;
  l.sessionsCount = (l.sessionsCount||0) + 1;
  if(!l.premiere || p.date < l.premiere){ l.premiere = p.date; if(!l.debut) l.debut = p.date; }
  if(!l.derniere || p.date > l.derniere) l.derniere = p.date;
  l.joursDepuis = 0;
  if(p.termine){ l.statut = 'Terminé'; l.fin = p.date; }
  else if(['En pause','À lire','Abandonné'].indexOf(l.statut) >= 0) l.statut = 'En cours';
}
function deleteSessionLocal(id){
  const list = BOOT.sessionsRecent || [];
  const s = list.filter(x => x.id === id)[0];
  BOOT.sessionsRecent = list.filter(x => x.id !== id);
  if(s){ const l = livreLocal(s.livre); if(l){ l.totalMinutes = Math.max(0,(l.totalMinutes||0) - s.minutes); l.sessionsCount = Math.max(0,(l.sessionsCount||0) - 1); } }
}
function updateSessionLocal(p){
  const s = (BOOT.sessionsRecent || []).filter(x => x.id === p.id)[0];
  if(!s) return;
  const oldMin = s.minutes, oldLivre = s.livre;
  if(p.date != null) s.date = p.date;
  if(p.livre != null) s.livre = p.livre;
  if(p.minutes != null) s.minutes = Math.max(0, Math.round(+p.minutes || 0));
  if(p.note != null) s.note = p.note;
  const adj = (t, d) => { const l = livreLocal(t); if(l) l.totalMinutes = Math.max(0,(l.totalMinutes||0) + d); };
  if(oldLivre === s.livre) adj(s.livre, s.minutes - oldMin);
  else { adj(oldLivre, -oldMin); adj(s.livre, s.minutes); }
}

function mutOpt(action, payload, patchLocal){
  try{ patchLocal(); }catch(e){}
  setBoot(BOOT);                 // persiste le patch + vide les caches dérivés
  renderActif();
  return api(action, payload).then(r => {
    if(r && r.bootstrap){ setBoot(r.bootstrap); renderActif(); }
    return r || {};
  }).catch(e => {
    if(e.message === 'network' || e.message === 'unauthorized'){
      const q = store.queue; q.push({ action: action, payload: payload }); store.queue = q;
      updateOfflineUi();
      if(e.message === 'unauthorized') scheduleReauth();
      return { offline: true };
    }
    toast('Erreur : ' + (e.message || e), true);
    rechargerBoot();
    return { error: true };
  });
}

/* ------------------------------------------------------------------- AUTH -- */
const $ = (s, r=document) => r.querySelector(s);

function showAuth(msg){
  $('#app').hidden = true;
  $('#auth').hidden = false;
  if(msg){ const el = $('#auth-error'); el.textContent = msg; el.hidden = false; }
  initGoogle();
}
function authMessage(e){
  return ({
    email_not_allowed: "Ce compte Google n'est pas autorisé.",
    google_token_invalid: 'Jeton Google invalide, réessaie.',
    network: 'Pas de connexion au serveur.',
    bad_response: "Réponse inattendue du serveur (vérifie l'URL de l'API dans les réglages).",
  })[e && e.message] || 'Connexion impossible : ' + ((e && e.message) || 'erreur');
}

let gisReady = false;
function initGoogle(){
  if(!(window.google && google.accounts && google.accounts.id)){ return void setTimeout(initGoogle, 250); }
  if(gisReady){ try{ google.accounts.id.prompt(); }catch(e){} return; }
  gisReady = true;
  google.accounts.id.initialize({
    client_id: store.clientId,
    callback: handleCredential,
    auto_select: true,
    cancel_on_tap_outside: false,
  });
  try{
    google.accounts.id.renderButton($('#gbtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', locale: 'fr' });
  }catch(e){ $('#gbtn-fallback').hidden = false; }
  try{ google.accounts.id.prompt(); }catch(e){}
  setTimeout(() => { if(!$('#gbtn').childElementCount) $('#gbtn-fallback').hidden = false; }, 1500);
}
async function handleCredential(response){
  if(!response || !response.credential) return;
  $('#auth-error').hidden = true;
  try{
    const data = await apiLogin(response.credential);
    store.session = { token: data.token, exp: data.exp, email: data.email };
    await bootApp();
  }catch(e){
    const el = $('#auth-error'); el.textContent = authMessage(e); el.hidden = false;
  }
}
function logout(){
  store.session = null;
  try{ google.accounts.id.disableAutoSelect(); }catch(e){}
  location.reload();
}
let reauthTimer = 0;
function scheduleReauth(){
  clearTimeout(reauthTimer);
  reauthTimer = setTimeout(() => { store.session = null; showAuth('Session expirée — reconnecte-toi.'); }, 400);
}

/* ------------------------------------------------------------------- BOOT -- */
var BOOT=null, MOIS={y:0,m:0}, STA={y:0};
var TRI='recent', FILTRE='En cours';
var FLT={format:'',nature:'',note:0}, FILTRES_OUV=false, GROUPE=true, SERIES_OUV={};
var CH={running:false,paused:false,started:0,acc:0,resume:0,livre:''};
var moisReq=0, staReq=0, journalRows=[];
var moisCache={}, staCache={};

function setBoot(b){
  BOOT = b; store.bootCache = b;
  moisCache = {}; staCache = {};       // caches dérivés -> recalculés à la prochaine visite
}

async function bootApp(){
  $('#auth').hidden = true;
  $('#app').hidden = false;

  const cached = store.bootCache;
  if(cached){ BOOT = cached; initFromBoot(); }
  else { $('#loading').classList.remove('hide'); }

  registerSW();
  updateOfflineUi();

  try{
    const b = await api('bootstrap');
    setBoot(b);
    initFromBoot();
    flushQueue();
  }catch(e){
    if(e.message === 'unauthorized'){ store.session = null; return showAuth(); }
    if(!cached){ $('#loading').innerHTML = '<p class="muted" style="text-align:center">Hors ligne et aucune donnée en cache.<br>Reconnecte-toi une fois en ligne.</p>'; return; }
    toast('Hors ligne — données en cache', true);
    updateOfflineUi();
  }
}
function initFromBoot(){
  $('#loading').classList.add('hide');
  const now = new Date(BOOT.today);
  if(!MOIS.y){ MOIS = { y: now.getFullYear(), m: now.getMonth()+1 }; }
  if(!STA.y){ STA = { y: new Date().getFullYear() }; }
  if(!CH.livre) CH.livre = BOOT.livreChrono || '';
  recupererSession();
  const cur = document.querySelector('nav.bottom button.on');
  go(cur ? cur.dataset.v : 'chrono');
  if(!window._ticking){ window._ticking = true; tick(); setInterval(tick, 1000); }
}
function refresh(b){ if(b) setBoot(b); renderActif(); }
function renderActif(){ const v = document.querySelector('nav.bottom button.on'); if(v) go(v.dataset.v); }

/* -------------------------------------------------------- OFFLINE / QUEUE -- */
function updateOfflineUi(){
  const n = store.queue.length;
  const bar = $('#offline-bar');
  if(!navigator.onLine){
    bar.hidden = false;
    bar.textContent = 'Hors ligne — tes séances seront synchronisées au retour du réseau';
  } else if(n){
    bar.hidden = false;
    bar.textContent = n + ' séance(s) en attente de synchronisation…';
  } else {
    bar.hidden = true;
  }
}
async function flushQueue(){
  const q = store.queue;
  if(!q.length || !store.session) { updateOfflineUi(); return; }
  const keep = [];
  for(let i=0; i<q.length; i++){
    try{ await api(q[i].action, q[i].payload); }
    catch(e){
      if(e.message === 'network' || e.message === 'unauthorized'){ for(let j=i;j<q.length;j++) keep.push(q[j]); break; }
      // erreur métier -> on jette l'élément et on continue
      toast('Élément en attente ignoré (' + e.message + ')', true);
    }
  }
  store.queue = keep;
  updateOfflineUi();
  if(q.length && !keep.length){
    toast(q.length + ' séance(s) synchronisée(s) ✓');
    try{ setBoot(await api('bootstrap')); renderActif(); }catch(e){}
  }
}
function pendingFor(date){
  return store.queue
    .filter(x => x.action === 'addSession' && (!date || x.payload.date === date))
    .map((x, i) => ({ id: 'attente-' + i, date: x.payload.date, livre: x.payload.livre,
                      minutes: +x.payload.minutes || 0, source: 'attente', note: x.payload.note || '' }));
}

/* ---------------------------------------------------------------- NAV --- */
function go(v){
  ['chrono','mois','stats','livres','journal'].forEach(x =>
    document.getElementById('v-'+x).classList.toggle('hide', x !== v));
  document.querySelectorAll('nav.bottom button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.getElementById('title').textContent =
    {chrono:'Chrono',mois:'Vue mensuelle',stats:'Statistiques',livres:'Mes livres',journal:'Journal'}[v];
  if(v==='chrono')renderChrono();
  if(v==='mois')renderMois();
  if(v==='stats')renderStats();
  if(v==='livres')renderLivresView();
  if(v==='journal')renderJournal();
}

/* ================= CHRONO ================= */
function fmt2(n){ return String(n).padStart(2,'0'); }
function elapsedMs(){ return CH.acc + (CH.running && !CH.paused ? Date.now()-CH.resume : 0); }
function tick(){
  const s = Math.floor(elapsedMs()/1000), h = Math.floor(s/3600), m = Math.floor(s%3600/60), ss = s%60;
  const d1 = document.getElementById('dial'), d2 = document.getElementById('dial2');
  if(!d1) return;
  if(h>0){ d1.textContent = h+'h'+fmt2(m); d2.textContent = fmt2(ss); }
  else { d1.textContent = fmt2(m); d2.textContent = fmt2(ss); }
}
function persist(){
  store.running = CH.running ? CH : null;
  api('setRunning', { state: CH.running ? CH : null }).catch(function(){});
}
function recupererSession(){
  const st = store.running || BOOT.running;
  if(st && st.running){
    CH = st;
    const when = new Date(st.started);
    document.getElementById('chrono-banner').innerHTML =
      '<div class="banner">⏱️ Session en cours sur <b>'+esc(st.livre)+'</b> (démarrée à '+fmt2(when.getHours())+':'+fmt2(when.getMinutes())+'). '+
      '<button class="btn ghost sm" onclick="terminer()">Terminer</button> · <button class="btn ghost sm" onclick="annuler()">Ignorer</button></div>';
  }
}
function renderChrono(){
  document.getElementById('chrono-livre').textContent = CH.livre || BOOT.livreChrono || 'À choisir';
  const box = document.getElementById('chrono-actions'), st = document.getElementById('chrono-state');
  box.innerHTML = ''; st.innerHTML = '';
  if(!CH.running){
    box.innerHTML = '<button class="btn wide" onclick="demarrer()">▶︎ Démarrer</button>';
  }else if(CH.paused){
    st.innerHTML = '<span class="muted">En pause</span>';
    box.innerHTML = '<button class="btn" onclick="reprendre()">▶︎ Reprendre</button><button class="btn sec" onclick="terminer()">Terminer</button>'+
      '<button class="btn ghost wide" onclick="annulerChrono()">Annuler la séance</button>';
  }else{
    st.innerHTML = '<span class="pulse"></span>&nbsp;<span class="muted">Lecture…</span>';
    box.innerHTML = '<button class="btn sec" onclick="pause()">❚❚ Pause</button><button class="btn" onclick="terminer()">■ Terminer</button>'+
      '<button class="btn ghost wide" onclick="annulerChrono()">Annuler la séance</button>';
  }
  renderChronoJour();
}
/* abandonne la séance en cours sans rien enregistrer */
function annulerChrono(){
  const min = Math.round(elapsedMs()/60000);
  if(min >= 2){
    modal('Annuler la séance ?',
      '<p class="muted">Le temps écoulé ('+min+' min) sera perdu. Aucune séance ne sera enregistrée.</p>',
      [{t:'Continuer la lecture',c:closeModal},
       {t:'Annuler la séance',p:1,c:function(){ closeModal(); annuler(); toast('Séance annulée'); }}]);
  }else{
    annuler(); toast('Séance annulée');
  }
}
function demarrer(){
  if(!CH.livre){ choisirLivre(true); return; }
  CH = { running:true, paused:false, started:Date.now(), acc:0, resume:Date.now(), livre:CH.livre };
  persist(); renderChrono();
}
function pause(){ CH.acc = elapsedMs(); CH.paused = true; persist(); renderChrono(); }
function reprendre(){ CH.resume = Date.now(); CH.paused = false; persist(); renderChrono(); }
function annuler(){
  CH = { running:false, paused:false, started:0, acc:0, resume:0, livre:CH.livre };
  store.running = null; api('setRunning', { state: null }).catch(function(){});
  document.getElementById('chrono-banner').innerHTML = ''; renderChrono();
}
function terminer(){
  const min = Math.max(1, Math.round(elapsedMs()/60000));
  const l = CH.livre || BOOT.livreChrono;
  modal('Fin de session',
    '<div class="field"><label>Livre</label><input id="f-livre" value="'+escAttr(l)+'" readonly></div>'+
    '<div class="field"><label>Durée (minutes)</label><input id="f-min" type="number" inputmode="numeric" value="'+min+'"></div>'+
    '<div class="field"><label>Note de séance (facultatif)</label><textarea id="f-note" rows="2"></textarea></div>'+
    '<label class="row" style="gap:8px"><input type="checkbox" id="f-fin" style="width:auto"> J\'ai terminé ce livre</label>',
    [{t:'Annuler',c:closeModal},{t:'Enregistrer',p:1,c:function(){
      const payload = { date: BOOT.today, livre: l, minutes: +document.getElementById('f-min').value,
        note: document.getElementById('f-note').value, source: 'chrono', termine: document.getElementById('f-fin').checked };
      if(!(payload.minutes > 0)){ toast('Durée invalide', true); return; }
      closeModal(); annuler();
      mutOpt('addSession', payload, () => addSessionLocal(payload)).then(r => {
        if(!r.error) toast(r.offline ? 'Séance enregistrée hors ligne' : (r.message || 'Séance enregistrée'));
      });
    }}]);
}
function renderChronoJour(){ renderDayList(document.getElementById('chrono-jour'), BOOT.today, "Aujourd'hui"); }

/* choisir / changer le livre du chrono */
function choisirLivre(demarrerApres){
  const l = BOOT.livres.slice();
  window._grp = [
    ['★ Chrono', l.filter(x => x.favori)],
    ['En cours', l.filter(x => x.statut === 'En cours' && !x.favori).sort(byRecent)],
    ['En pause', l.filter(x => x.statut === 'En pause').sort(byRecent)],
    ['À lire',   l.filter(x => x.statut === 'À lire')],
  ];
  window._demApres = !!demarrerApres;
  modal('Choisir le livre',
    '<input id="lq" placeholder="Filtrer / nouveau titre…" oninput="filtLivreListe()">'+
    '<div id="ll" style="margin-top:10px"></div>'+
    '<button class="btn sec" style="margin-top:8px" onclick="nouveauDepuisChrono()">＋ Créer « <span id="lqx">…</span> »</button>',
    [{t:'Fermer',c:closeModal}]);
  filtLivreListe();
}
function filtLivreListe(){
  const q = (document.getElementById('lq').value || '').toLowerCase();
  document.getElementById('lqx').textContent = document.getElementById('lq').value || '…';
  let out = '';
  window._grp.forEach(g => {
    const items = g[1].filter(x => x.titre.toLowerCase().indexOf(q) >= 0);
    if(!items.length) return;
    out += '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">'+g[0]+'</div>';
    items.forEach(x => {
      out += '<button class="li" onclick="pickLivre(this.dataset.t)" data-t="'+escAttr(x.titre)+'">'+
        '<span class="badge">'+Math.round(x.totalMinutes/60)+'<small>h</small></span>'+
        '<span class="grow"><span class="t">'+esc(x.titre)+'</span><span class="sub">'+x.format+' · '+x.statut+
        (x.joursDepuis!=null ? ' · il y a '+x.joursDepuis+' j' : '')+'</span></span></button>';
    });
  });
  document.getElementById('ll').innerHTML = out || '<p class="muted">Aucun livre — crée-le ci-dessous.</p>';
}
function pickLivre(t){
  CH.livre = t; closeModal();
  document.getElementById('chrono-livre').textContent = t;
  if(livreLocal(t)) mutOpt('setChrono', { titre: t }, () => setFavoriLocal(t));
  else mut('setChrono', { titre: t }).then(() => renderActif());   // livre pas encore en mémoire
  if(window._demApres) demarrer();
}
function nouveauDepuisChrono(){
  const t = (document.getElementById('lq').value || '').trim(); if(!t) return;
  editLivre({ titre:t, format:'', nature:'', statut:'En cours' }, () => pickLivre(t));
}

/* ================= MOIS ================= */
const MOIS_NOMS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
function moisNav(d){
  const t = MOIS.y*12 + (MOIS.m-1) + d;
  MOIS.y = Math.floor(t/12); MOIS.m = (t%12)+1;
  renderMois();
}
function moisAujourdhui(){
  const n = new Date((BOOT && BOOT.today) || Date.now());
  MOIS = { y:n.getFullYear(), m:n.getMonth()+1 };
  renderMois();
}
function renderMois(){
  const my = ++moisReq;                       // ignore les réponses d'une nav dépassée
  const y = MOIS.y, m = MOIS.m;
  const key = y + '-' + String(m).padStart(2,'0');
  document.getElementById('mois-titre').textContent = MOIS_NOMS[m-1] + ' ' + y;
  const n = new Date((BOOT && BOOT.today) || Date.now());
  document.getElementById('mois-auj').hidden = (y === n.getFullYear() && m === n.getMonth()+1);

  if(moisCache[key]){ drawMois(moisCache[key]); return; }
  if(moisCouvertLocalement(y, m)){ const g = moisGridLocal(y, m); moisCache[key] = g; drawMois(g); return; }

  document.getElementById('cal').innerHTML = '<div class="spin"></div>';
  api('month', { year: y, month: m }).then(g => {
    if(my !== moisReq || g.year !== MOIS.y || g.month !== MOIS.m) return;
    moisCache[key] = g;
    drawMois(g);
  }).catch(e => {
    if(my !== moisReq) return;
    document.getElementById('cal').innerHTML = '<p class="muted">'+(e.message==='network'?'Hors ligne':'Erreur')+'</p>';
  });
}
/* le mois est-il entièrement couvert par les séances déjà en mémoire ? */
function moisCouvertLocalement(y, m){
  const rec = (BOOT && BOOT.sessionsRecent) || [];
  if(!rec.length || !BOOT.livres) return false;
  let oldest = rec[0].date;
  for(let i=1;i<rec.length;i++) if(rec[i].date < oldest) oldest = rec[i].date;
  return (y + '-' + String(m).padStart(2,'0')) > String(oldest).slice(0,7);
}
/* grille du mois calculée en local (mêmes règles que getMonthGrid côté serveur) */
function moisGridLocal(y, m){
  const mkey = y + '-' + String(m).padStart(2,'0');
  const r = (BOOT && BOOT.reglages) || {};
  const seuils = { v:+r.seuil_violet||50, g:+r.seuil_vert||20, j:+r.seuil_jaune||5 };
  const jours = {};
  (BOOT.sessionsRecent || []).forEach(s => {
    if(String(s.date).slice(0,7) !== mkey) return;
    const j = jours[s.date] || (jours[s.date] = { minutes:0, livres:{} });
    j.minutes += s.minutes;
    j.livres[s.livre] = (j.livres[s.livre]||0) + s.minutes;
  });
  const finis = {};
  (BOOT.livres || []).forEach(l => {
    const jf = l.fin || l.derniere;
    if(l.statut === 'Terminé' && jf && String(jf).slice(0,7) === mkey) (finis[jf] = finis[jf] || []).push(l.titre);
  });
  const first = new Date(Date.UTC(y, m-1, 1));
  const dec = (first.getUTCDay()+6)%7;
  const nb = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for(let i=0;i<dec;i++) cells.push(null);
  for(let d=1; d<=nb; d++){
    const iso = mkey + '-' + String(d).padStart(2,'0');
    const jd = jours[iso] || { minutes:0, livres:{} };
    let bucket = 'zero';
    if(jd.minutes >= seuils.v) bucket = 'violet';
    else if(jd.minutes >= seuils.g) bucket = 'vert';
    else if(jd.minutes >= seuils.j) bucket = 'jaune';
    else if(jd.minutes >= 1) bucket = 'rouge';
    cells.push({ day:d, date:iso, minutes:jd.minutes, bucket:bucket,
      livres:Object.keys(jd.livres).map(t => ({ titre:t, minutes:jd.livres[t] })).sort((a,b) => b.minutes - a.minutes),
      finis: finis[iso] || [] });
  }
  while(cells.length % 7 !== 0) cells.push(null);
  const tot = Object.keys(jours).reduce((s,k) => s + jours[k].minutes, 0);
  return { year:y, month:m, cells:cells, totalMinutes:tot,
    joursLus:Object.keys(jours).filter(k => jours[k].minutes > 0).length,
    livresTermines:Object.keys(finis).reduce((s,k) => s + finis[k].length, 0), seuils:seuils };
}
function drawMois(g){
  const s = g.seuils, set = (cl,v) => document.querySelectorAll('.'+cl).forEach(e => e.textContent = v);
  set('s-v',s.v); set('s-g',s.g); set('s-g2',s.v-1); set('s-j',s.j); set('s-j2b',s.g-1); set('s-j2',s.j-1);
  let h = '';
  g.cells.forEach(c => {
    if(!c){ h += '<div class="cell empty"></div>'; return; }
    const bk = c.livres[0] ? c.livres[0].titre : '';
    h += '<div class="cell '+c.bucket+'" onclick="jourDetail(\''+c.date+'\')">'+
      (c.finis.length ? '<span class="fin">✓</span>' : '')+
      '<span class="d">'+c.day+'</span>'+
      (bk ? '<span class="bk">'+esc(bk)+'</span>' : '')+
      (c.minutes ? '<span class="m">'+c.minutes+'′</span>' : '')+'</div>';
  });
  document.getElementById('cal').innerHTML = h;
  const n = new Date((BOOT && BOOT.today) || Date.now());
  const estCourant = (g.year === n.getFullYear() && g.month === n.getMonth()+1);
  const nbJours = new Date(g.year, g.month, 0).getDate();
  const denom = estCourant ? n.getDate() : nbJours;
  const moyLu = g.joursLus ? Math.round(g.totalMinutes / g.joursLus) : 0;
  const moyTot = denom ? Math.round(g.totalMinutes / denom) : 0;
  const objQ = (BOOT && BOOT.reglages) ? +BOOT.reglages.objectif_quotidien_min : 0;
  document.getElementById('mois-resume').innerHTML =
    kpi(fmtMin(g.totalMinutes),'ce mois-ci') + kpi(g.joursLus,'jours lus') +
    kpi(g.livresTermines,'livres terminés') + kpi(moyLu+' min','moy. / jour lu') +
    '<div class="muted" style="grid-column:1/-1;text-align:center;font-size:12px;margin-top:2px">'+
      moyTot+' min/jour sur '+denom+' jour'+(denom>1?'s':'')+(objQ?' · objectif '+objQ+' min':'')+'</div>';
}
function jourDetail(date){
  const wrap = document.createElement('div');
  renderDayList(wrap, date, dateFr(date), true);
  modal(dateFr(date), wrap.innerHTML, [{t:'Fermer',c:closeModal}]);
}

/* ================= STATS ================= */
function statsNav(d){ STA.y += d; renderStats(); }
function renderStats(){
  const my = ++staReq;
  const an = STA.y;
  document.getElementById('stats-annee').textContent = an;
  const body = document.getElementById('stats-body');
  const anneeCourante = (BOOT && BOOT.anneeCourante) || new Date().getFullYear();
  const cache = (an === anneeCourante && BOOT && BOOT.stats) ? BOOT.stats : staCache[an];
  if(cache && cache.year === an) drawStats(cache);       // instantané, jamais la mauvaise année
  else body.innerHTML = '<div class="spin"></div>';
  api('stats', { year: an }).then(s => {
    if(my !== staReq || s.year !== an) return;            // réponse d'une nav dépassée -> ignorée
    staCache[an] = s;
    if(an === anneeCourante && BOOT) BOOT.stats = s;
    drawStats(s);
  }).catch(e => { if(my === staReq && !body.querySelector('.kpis')) body.innerHTML = '<p class="muted">'+(e.message==='network'?'Hors ligne — reviens plus tard.':'Erreur : '+e.message)+'</p>'; });
}
function drawStats(s){
  const body = document.getElementById('stats-body');
  {
    const goalPct = s.goalYear ? Math.min(100, Math.round(s.totalYear/s.goalYear*100)) : 0;
    const mx = a => Math.max.apply(null, a.concat([1]));
    const maxM = mx(s.perMonth), maxW = mx(s.perWeekday);
    const maxF = mx(s.perFormat.map(x=>x.minutes)), maxY = mx(s.perYear.map(x=>x.minutes)), maxB = mx(s.topBooks.map(x=>x.minutes));
    const JJ = ['L','M','M','J','V','S','D'];
    body.innerHTML =
      '<div class="kpis">'+
        kpi(fmtMin(s.totalYear),'lus en '+s.year) + kpi(s.booksFinishedYear,'livres terminés') +
        kpi('🔥 '+s.streakCurrent+' j','série en cours') + kpi(s.streakRecord+' j','record')+
      '</div>'+
      '<div class="card pad" style="margin-top:12px">'+
        '<div class="row" style="justify-content:space-between"><b>Objectif annuel</b>'+
        '<span class="muted">'+fmtMin(s.totalYear)+' / '+fmtMin(s.goalYear)+'</span></div>'+
        '<div class="progress"><i style="width:'+goalPct+'%"></i></div>'+
        '<div class="muted" style="font-size:12px;margin-top:6px">'+s.avgPerDayYear+' min/jour · projection '+fmtMin(s.projectionYear)+'</div>'+
      '</div>'+
      '<div class="card pad" style="margin-top:12px"><b>Par mois</b>'+
        '<div class="mbars">'+s.perMonth.map((v,i) => '<div class="mb" style="height:'+(v/maxM*100)+'%" title="'+MOIS_NOMS[i]+' : '+fmtMin(v)+'"></div>').join('')+'</div>'+
        '<div class="mbars-x">'+MOIS_NOMS.map(n => '<div>'+n[0]+'</div>').join('')+'</div>'+
      '</div>'+
      '<div class="card pad" style="margin-top:12px"><b>Par jour de semaine</b><div class="bars">'+
        s.perWeekday.map((v,i) => barRow(JJ[i],v,maxW)).join('')+'</div></div>'+
      '<div class="card pad" style="margin-top:12px"><b>Par format</b><div class="bars2">'+
        s.perFormat.filter(x=>x.minutes>0).map(x => barRow2(x.format,x.minutes,maxF)).join('')+'</div></div>'+
      '<div class="card pad" style="margin-top:12px"><b>Top livres (temps)</b><div class="bars2">'+
        s.topBooks.map(x => barRow2(x.titre,x.minutes,maxB)).join('')+'</div></div>'+
      '<div class="card pad" style="margin-top:12px"><b>Par année</b><div class="bars2">'+
        s.perYear.map(x => barRow2(x.year,x.minutes,maxY,x.books+' livre'+(x.books>1?'s':''))).join('')+'</div></div>'+
      '<p class="muted" style="text-align:center;margin-top:14px;font-size:12px">Total historique : '+fmtMin(s.totalAll)+' · '+s.booksFinishedAll+' livres terminés</p>';
  }
}
function kpi(v,k){ return '<div class="kpi"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>'; }
function barRow(label,val,max){
  return '<div class="bar-row"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(label)+'</span>'+
    '<span class="bar-track"><span class="bar-fill" style="width:'+(val/max*100)+'%"></span></span>'+
    '<span class="muted" style="text-align:right">'+fmtMinShort(val)+'</span></div>';
}
/* variante libellé complet au-dessus de la barre (titres longs) */
function barRow2(label,val,max,sub){
  return '<div class="bar-row2"><div class="bar-lbl">'+esc(label)+(sub?' <span class="muted">· '+esc(sub)+'</span>':'')+'</div>'+
    '<div class="bar-line"><span class="bar-track"><span class="bar-fill" style="width:'+(max?val/max*100:0)+'%"></span></span>'+
    '<span class="muted bar-val">'+fmtMinShort(val)+'</span></div></div>';
}

/* ================= LIVRES ================= */
function renderLivresView(){
  document.getElementById('livres-filtres').innerHTML =
    ['Tous','En cours','En pause','Terminé','À lire','Abandonné']
      .map(o => '<button class="'+(o===FILTRE?'on':'')+'" onclick="setFiltre(\''+o+'\')">'+o+'</button>').join('');
  const nb = fltActifs();
  document.getElementById('livres-plus').textContent = 'Filtres ' + (FILTRES_OUV?'▴':'▾') + (nb?' ('+nb+')':'');
  const panel = document.getElementById('livres-filtres-plus');
  panel.hidden = !FILTRES_OUV;
  if(FILTRES_OUV) panel.innerHTML = filtresPlusHtml();
  renderLivres();
}
function fltActifs(){ return (FLT.format?1:0)+(FLT.nature?1:0)+(FLT.note?1:0); }
function toggleFiltres(){ FILTRES_OUV = !FILTRES_OUV; renderLivresView(); }
function filtresPlusHtml(){
  const js = s => String(s).replace(/'/g,"\\'");
  const chip = (txt,on,call) => '<button class="'+(on?'on':'')+'" onclick="'+call+'">'+esc(txt)+'</button>';
  const seg = (lbl,inner) => '<div class="flt-lbl">'+lbl+'</div><div class="seg">'+inner+'</div>';
  const F = (BOOT.formats||[]).map(f => chip(f, FLT.format===f, "setFlt('format','"+js(f)+"')")).join('');
  const N = (BOOT.natures||[]).map(x => chip(x, FLT.nature===x, "setFlt('nature','"+js(x)+"')")).join('');
  const notes = [0,3,4,5].map(v => chip(v===0?'Toutes':v+'★+', FLT.note===v, 'setFltNote('+v+')')).join('');
  return seg('Format', chip('Tous', !FLT.format, "setFlt('format','')")+F)+
         seg('Nature', chip('Toutes', !FLT.nature, "setFlt('nature','')")+N)+
         seg('Note', notes)+
         '<label class="row" style="gap:8px;margin-top:10px;font-size:13px">'+
           '<input type="checkbox" style="width:auto"'+(GROUPE?' checked':'')+' onchange="setGroupe(this.checked)"> Grouper les séries</label>';
}
function setFiltre(o){ FILTRE = o; renderLivresView(); }
function setFlt(k,v){ FLT[k] = v; renderLivresView(); }
function setFltNote(v){ FLT.note = v; renderLivresView(); }
function setGroupe(b){ GROUPE = b; renderLivres(); }
function setTri(btn){
  TRI = btn.dataset.tri;
  document.querySelectorAll('#v-livres .seg button[data-tri]').forEach(b => b.classList.toggle('on', b === btn));
  renderLivres();
}
function byRecent(a,b){ return (b.derniere||'').localeCompare(a.derniere||''); }
function livresCmp(){
  if(TRI==='temps') return (a,b) => b.totalMinutes - a.totalMinutes;
  if(TRI==='titre') return (a,b) => a.titre.localeCompare(b.titre,'fr');
  return byRecent;
}
function livreMatch(x,q){
  return (FILTRE==='Tous' || x.statut===FILTRE)
    && (!FLT.format || x.format===FLT.format)
    && (!FLT.nature || x.nature===FLT.nature)
    && (!FLT.note || Math.round(x.note||0) >= FLT.note)
    && x.titre.toLowerCase().indexOf(q) >= 0;
}
function renderLivres(){
  const q = (document.getElementById('livres-q').value || '').toLowerCase();
  const cmp = livresCmp();
  const arr = BOOT.livres.filter(x => livreMatch(x,q)).sort(cmp);
  document.getElementById('livres-count').textContent =
    arr.length + (arr.length>1?' livres':' livre') + ' · ' + fmtMinShort(arr.reduce((s,x)=>s+x.totalMinutes,0));
  document.getElementById('livres-list').innerHTML =
    (GROUPE ? livresGroupesHtml(arr,cmp) : arr.map(livreRow).join('')) || '<p class="muted pad">Aucun livre.</p>';
}
function livreRow(x){
  return '<button class="li" onclick="openLivre(this.dataset.t)" data-t="'+escAttr(x.titre)+'">'+
    '<span class="badge">'+fmtMinShort(x.totalMinutes)+'</span>'+
    '<span class="grow"><span class="t">'+(x.favori?'★ ':'')+esc(x.titre)+'</span>'+
    '<span class="sub">'+x.joursActifs+' j actifs'+
      (x.joursDepuis!=null ? ' · '+(x.joursDepuis===0?"aujourd'hui":'il y a '+x.joursDepuis+' j') : '')+
      (x.note ? ' · '+'★'.repeat(Math.round(x.note)) : '')+'</span>'+
    '<span class="tags"><span class="chip">'+esc(x.format)+'</span><span class="chip">'+esc(x.nature)+'</span><span class="chip">'+esc(x.statut)+'</span></span>'+
  '</span></button>';
}
/* série = titre sans le marqueur de tome final (T11, - Tome 3, Volume 2, V1, Intégrale 1…) */
function serieStem(titre){
  return String(titre).replace(/[\s.\-–—]+(?:int[ée]grale|tome|volume|vol|v|t)\.?\s*\d+\s*$/i,'').trim();
}
function livresGroupesHtml(arr,cmp){
  const g = {}, order = [];
  arr.forEach(x => { const s = serieStem(x.titre); (g[s] || (order.push(s), g[s]=[])).push(x); });
  return order.map(stem => {
    const items = g[stem];
    if(items.length < 2) return livreRow(items[0]);
    items.sort(cmp);
    const tot = items.reduce((s,x)=>s+x.totalMinutes,0);
    const finis = items.filter(x=>x.statut==='Terminé').length;
    const open = !!SERIES_OUV[stem];
    return '<div class="serie">'+
      '<button class="li serie-h" onclick="toggleSerie(this.dataset.s)" data-s="'+escAttr(stem)+'">'+
        '<span class="badge">'+fmtMinShort(tot)+'</span>'+
        '<span class="grow"><span class="t">'+esc(stem)+' <span class="muted">· '+items.length+' tomes</span></span>'+
        '<span class="sub">'+finis+'/'+items.length+' terminés</span></span>'+
        '<span class="serie-chev">'+(open?'▴':'▾')+'</span>'+
      '</button>'+
      (open ? '<div class="serie-body">'+items.map(livreRow).join('')+'</div>' : '')+
    '</div>';
  }).join('');
}
function toggleSerie(s){ SERIES_OUV[s] = !SERIES_OUV[s]; renderLivres(); }
function openLivre(t){ editLivre(BOOT.livres.filter(l => l.titre === t)[0] || null); }
/* encart récap (lecture) dans la fiche d'un livre existant */
function livreStatsHtml(l){
  if(!l || !l.sessionsCount) return '';
  const d = x => x ? dateFr(x) : '—';
  const finLbl = l.statut==='Terminé' ? 'Terminé le' : (l.statut==='Abandonné' ? 'Arrêté le' : 'Dernière séance');
  const parSeance = Math.round(l.totalMinutes / l.sessionsCount);
  const classes = BOOT.livres.filter(x => x.totalMinutes > 0).sort((a,b) => b.totalMinutes - a.totalMinutes);
  const rank = classes.findIndex(x => x.titre === l.titre) + 1;
  const R = [
    ['Commencé', d(l.debut)],
    [finLbl, d(l.fin)],
  ];
  if(l.dureeCal) R.push(['Étalé sur', l.dureeCal+' j'+(l.joursActifs?' · '+l.joursActifs+' j lus':'')]);
  R.push(['Temps de lecture', fmtMin(l.totalMinutes)+' · '+l.sessionsCount+' séance'+(l.sessionsCount>1?'s':'')+(parSeance?' · ~'+parSeance+' min/séance':'')]);
  if(l.moyJourActif) R.push(['Rythme', l.moyJourActif+' min / jour lu']);
  if(rank && rank<=15 && l.totalMinutes>=60) R.push(['Classement', '#'+rank+' de tes lectures les plus longues']);
  return '<div class="card pad livre-stats">'+
    R.map(r => '<div class="ls-row"><span>'+esc(r[0])+'</span><b>'+esc(r[1])+'</b></div>').join('')+
  '</div>';
}
function editLivre(l, apres){
  l = l || { titre:'', format:'', nature:'', statut:'À lire', serie:'', note:0, commentaire:'', alias:'' };
  const neuf = !l.titre || !BOOT.livres.some(x => x.titre === l.titre);
  const F = BOOT.formats, N = BOOT.natures, S = BOOT.statuts;
  const html =
    '<div class="field"><label>Titre</label><input id="e-t" value="'+escAttr(l.titre)+'"></div>'+
    '<div class="field"><label>Format</label><div class="seg" id="e-f">'+F.map(x => segb(x, x===l.format)).join('')+'</div></div>'+
    '<div class="field"><label>Nature</label><div class="seg" id="e-n">'+N.map(x => segb(x, x===l.nature)).join('')+'</div></div>'+
    '<div class="field"><label>Statut</label><div class="seg" id="e-s">'+S.map(x => segb(x, x===l.statut)).join('')+'</div></div>'+
    '<div class="field"><label>Série (facultatif)</label><input id="e-serie" value="'+escAttr(l.serie||'')+'"></div>'+
    '<div class="field"><label>Note</label><div class="seg" id="e-note">'+[0,1,2,3,4,5].map(x => segb(x||'—', x===Math.round(l.note||0), x)).join('')+'</div></div>'+
    '<div class="field"><label>Commentaire</label><textarea id="e-c" rows="2">'+esc(l.commentaire||'')+'</textarea></div>'+
    '<label class="row" style="gap:8px;margin-bottom:12px"><input type="checkbox" id="e-chrono" style="width:auto"'+(l.favori?' checked':'')+'> Livre du chrono</label>'+
    (neuf ? '' : livreStatsHtml(l)+
      '<div id="e-sessions" style="margin-bottom:12px"></div>'+
      '<button class="btn ghost sm" onclick="fusionner(this.dataset.t)" data-t="'+escAttr(l.titre)+'">Fusionner avec un autre titre…</button>');
  modal(neuf ? 'Nouveau livre' : l.titre, html, [{t:'Fermer',c:closeModal},{t:'Enregistrer',p:1,c:function(){
    const p = { titreOriginal:l.titre, titre:document.getElementById('e-t').value.trim(),
      format:segVal('e-f'), nature:segVal('e-n'), statut:segVal('e-s'),
      serie:document.getElementById('e-serie').value.trim(),
      note:segVal('e-note',true), commentaire:document.getElementById('e-c').value.trim(),
      definirChrono:document.getElementById('e-chrono').checked };
    if(!p.titre){ toast('Titre requis', true); return; }
    closeModal();
    if(neuf){
      mut('saveBook', p).then(r => { toast(r.offline?'Enregistré hors ligne':'Enregistré'); renderActif(); if(apres)apres(); }).catch(err);
    }else{
      mutOpt('saveBook', p, () => {
        patchLivre(p.titreOriginal || p.titre, { titre:p.titre, format:p.format, nature:p.nature,
          statut:p.statut, serie:p.serie, note:p.note, commentaire:p.commentaire });
        if(p.definirChrono) setFavoriLocal(p.titre);
      }).then(r => { if(!r.error) toast(r.offline?'Enregistré hors ligne':'Enregistré'); if(apres)apres(); });
    }
  }}]);
  if(!neuf) renderDayList(document.getElementById('e-sessions'), null, 'Sessions', true, l.titre);
}
function fusionner(cible){
  const autres = BOOT.livres.filter(x => x.titre !== cible).map(x => x.titre).sort();
  modal('Fusionner vers « ' + cible + ' »',
    '<p class="muted">Les sessions des titres cochés seront rattachées à « '+esc(cible)+' » et leurs fiches supprimées.</p>'+
    autres.map(t => '<label class="row" style="gap:8px;padding:6px 0"><input type="checkbox" value="'+escAttr(t)+'" style="width:auto"> '+esc(t)+'</label>').join(''),
    [{t:'Annuler',c:closeModal},{t:'Fusionner',p:1,c:function(){
      const src = [].slice.call(document.querySelectorAll('.sheet input[type=checkbox]:checked')).map(c => c.value);
      if(!src.length){ closeModal(); return; }
      mut('mergeBooks', { sources: src, cible: cible }).then(r => { closeModal(); toast(r.offline?'Fusion en attente':'Fusionné'); renderActif(); }).catch(err);
    }}]);
}

/* ================= JOURNAL ================= */
function drawJournal(rows){
  const el = document.getElementById('journal-list');
  const fL = (document.getElementById('jr-livre').value || '').toLowerCase().trim();
  const fM = document.getElementById('jr-mois').value || '';              // 'yyyy-MM'
  let all = pendingFor(null).concat(rows);
  if(fL) all = all.filter(r => String(r.livre).toLowerCase().indexOf(fL) >= 0);
  if(fM) all = all.filter(r => String(r.date).slice(0,7) === fM);
  document.getElementById('jr-clear').hidden = !(fL || fM);
  const grp = {}, order = [];
  all.forEach(r => { if(!grp[r.date]){ grp[r.date] = []; order.push(r.date); } grp[r.date].push(r); });
  order.sort().reverse();
  if(!order.length){ el.innerHTML = '<p class="muted">Aucune session'+((fL||fM)?' pour ce filtre':'')+'.</p>'; return; }
  const totG = all.reduce((s,r) => s + r.minutes, 0);
  el.innerHTML =
    ((fL||fM) ? '<div class="row" style="justify-content:space-between;margin:2px 2px 4px"><span class="muted">'+all.length+' séance'+(all.length>1?'s':'')+'</span><span class="muted">'+fmtMinShort(totG)+'</span></div>' : '')+
    order.map(d => {
      const tot = grp[d].reduce((s,r) => s + r.minutes, 0);
      return '<div class="row" style="justify-content:space-between;margin:16px 2px 6px"><b>'+dateFr(d)+'</b><span class="muted">'+fmtMinShort(tot)+'</span></div>'+
        '<div class="card">'+grp[d].map(sessionRow).join('')+'</div>';
    }).join('');
}
function filtreJournal(){ drawJournal(journalRows); }
function journalClear(){
  document.getElementById('jr-livre').value = '';
  document.getElementById('jr-mois').value = '';
  drawJournal(journalRows);
}
function renderJournal(){
  const el = document.getElementById('journal-list');
  const dl = document.getElementById('jr-dl');
  if(dl && BOOT && BOOT.livres) dl.innerHTML = BOOT.livres.map(x => '<option value="'+escAttr(x.titre)+'">').join('');
  if(!journalRows.length){
    const seed = (BOOT && BOOT.sessionsRecent) || [];
    if(seed.length) journalRows = seed;
  }
  if(journalRows.length) drawJournal(journalRows); else el.innerHTML = '<div class="spin"></div>';
  api('sessions', { limit: 500 }).then(rows => {
    if(BOOT) BOOT.sessionsRecent = rows.slice(0, 150);
    journalRows = rows;
    drawJournal(journalRows);
  }).catch(e => { if(!el.querySelector('.card')) el.innerHTML = '<p class="muted">'+(e.message==='network'?'Hors ligne':'Erreur : '+e.message)+'</p>'; });
}
const SESS = {};
function sessionRow(r){
  SESS[r.id] = r;
  const attente = r.source === 'attente';
  return '<button class="li" onclick="openSession(this.dataset.id)" data-id="'+escAttr(r.id)+'"'+(attente?' disabled style="opacity:.6"':'')+'>'+
    '<span class="badge">'+r.minutes+'<small>min</small></span>'+
    '<span class="grow"><span class="t">'+esc(r.livre)+'</span>'+
    '<span class="sub"><span class="dot '+r.source+'"></span>'+(attente?'en attente de synchro':r.source)+(r.note?' · '+esc(r.note):'')+'</span></span></button>';
}
function openSession(id){ const r = SESS[id]; if(r && r.source !== 'attente') editSession(r); }
function editSession(r){
  modal('Session',
    '<div class="field"><label>Livre</label><input id="s-livre" value="'+escAttr(r.livre)+'"></div>'+
    '<div class="field"><label>Date</label><input id="s-date" type="date" value="'+r.date+'"></div>'+
    '<div class="field"><label>Minutes</label><input id="s-min" type="number" inputmode="numeric" value="'+r.minutes+'"></div>'+
    '<div class="field"><label>Note</label><textarea id="s-note" rows="2">'+esc(r.note||'')+'</textarea></div>',
    [{t:'Supprimer',c:function(){
      modal('Supprimer ?','<p class="muted">Supprimer définitivement cette session ('+r.minutes+' min · '+esc(r.livre)+' · '+dateFr(r.date)+') ?</p>',
        [{t:'Non',c:function(){ editSession(r); }},
         {t:'Oui, supprimer',p:1,c:function(){
           closeModal();
           mutOpt('deleteSession', {id:r.id}, () => deleteSessionLocal(r.id))
             .then(x => { if(!x.error) toast(x.offline?'Suppression en attente':'Session supprimée'); });
         }}]);
     }},
     {t:'Enregistrer',p:1,c:function(){
      const up = { id:r.id, livre:document.getElementById('s-livre').value,
        date:document.getElementById('s-date').value, minutes:+document.getElementById('s-min').value,
        note:document.getElementById('s-note').value };
      closeModal();
      mutOpt('updateSession', up, () => updateSessionLocal(up))
        .then(x => { if(!x.error) toast(x.offline?'Modif en attente':'Modifié'); });
    }}]);
}
function ajoutManuel(){
  const livres = BOOT.livres.slice().sort(byRecent);
  modal('Ajouter une session',
    '<div class="field"><label>Livre</label><input id="a-livre" list="a-dl" value="'+escAttr(CH.livre||BOOT.livreChrono||'')+'">'+
      '<datalist id="a-dl">'+livres.map(x => '<option value="'+escAttr(x.titre)+'">').join('')+'</datalist></div>'+
    '<div class="field"><label>Date</label><input id="a-date" type="date" value="'+BOOT.today+'"></div>'+
    '<div class="field"><label>Minutes</label><input id="a-min" type="number" inputmode="numeric" value="20"></div>'+
    '<div class="field"><label>Note (facultatif)</label><textarea id="a-note" rows="2"></textarea></div>'+
    '<label class="row" style="gap:8px"><input type="checkbox" id="a-fin" style="width:auto"> Livre terminé</label>',
    [{t:'Annuler',c:closeModal},{t:'Ajouter',p:1,c:function(){
      const p = { livre:document.getElementById('a-livre').value.trim(), date:document.getElementById('a-date').value,
        minutes:+document.getElementById('a-min').value, note:document.getElementById('a-note').value,
        source:'manuel', termine:document.getElementById('a-fin').checked };
      if(!p.livre){ toast('Livre requis', true); return; }
      if(!(p.minutes > 0)){ toast('Durée invalide', true); return; }
      closeModal();
      mutOpt('addSession', p, () => addSessionLocal(p))
        .then(r => { if(!r.error) toast(r.offline?'Séance hors ligne':(r.message||'Ajouté')); });
    }}]);
}

/* -------- liste de sessions (jour ou livre) -------- */
function renderDayList(el, date, titre, compact, livre){
  const done = rows => {
    if(date) rows = pendingFor(date).concat(rows.filter(r => r.date === date));
    else if(livre) rows = pendingFor(null).filter(r => r.livre === livre).concat(rows.filter(r => r.livre === livre));
    const tot = rows.reduce((s,r) => s + r.minutes, 0);
    el.innerHTML = (titre ? '<div class="row" style="justify-content:space-between;margin-bottom:6px"><b>'+esc(titre)+'</b><span class="muted">'+fmtMinShort(tot)+'</span></div>' : '')+
      (rows.length ? '<div class="card">'+rows.map(sessionRow).join('')+'</div>' : '<p class="muted" style="font-size:13px">Aucune session.</p>');
  };
  const seed = (BOOT && BOOT.sessionsRecent) || [];
  if(seed.length) done(seed); else el.innerHTML = '<div class="muted" style="font-size:12px">…</div>';
  api('sessions', livre ? { livre: livre, limit: 60 } : { limit: 500 }).then(rows => {
    if(!livre && BOOT) BOOT.sessionsRecent = rows.slice(0, 150);
    done(rows);
  }).catch(() => { if(!seed.length) done([]); });
}

/* ================= RÉGLAGES (appli) ================= */
function openReglages(){
  const r = BOOT ? BOOT.reglages : {};
  modal('Réglages',
    '<div class="field"><label>Objectif annuel (minutes)</label><input id="r-an" type="number" value="'+(r.objectif_annuel_min||6000)+'"></div>'+
    '<div class="field"><label>Objectif quotidien (minutes)</label><input id="r-jour" type="number" value="'+(r.objectif_quotidien_min||20)+'"></div>'+
    '<div class="row" style="gap:8px">'+
      '<div class="field grow"><label>Seuil violet</label><input id="r-v" type="number" value="'+(r.seuil_violet||50)+'"></div>'+
      '<div class="field grow"><label>Seuil vert</label><input id="r-g" type="number" value="'+(r.seuil_vert||20)+'"></div>'+
      '<div class="field grow"><label>Seuil jaune</label><input id="r-j" type="number" value="'+(r.seuil_jaune||5)+'"></div>'+
    '</div>'+
    '<div class="field"><label>Mise en pause auto après (jours sans session)</label><input id="r-p" type="number" value="'+(r.pause_auto_jours||21)+'"></div>'+
    '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">'+
    '<button class="btn sec sm" onclick="window.open(\''+DEFAULTS.SHEET_URL+'\',\'_blank\')">Ouvrir la feuille (BDD)</button> '+
    '<button class="btn ghost sm" onclick="closeModal();openSettings()">Réglages avancés</button>'+
    '<p class="muted" style="font-size:11px;margin-top:14px">Journal de Lecture · PWA v1' + (BOOT && BOOT.email ? ' · '+esc(BOOT.email) : '') + '</p>',
    [{t:'Fermer',c:closeModal},{t:'Enregistrer',p:1,c:function(){
      const rg = { objectif_annuel_min:val('r-an'), objectif_quotidien_min:val('r-jour'),
        seuil_violet:val('r-v'), seuil_vert:val('r-g'), seuil_jaune:val('r-j'), pause_auto_jours:val('r-p') };
      closeModal();
      mutOpt('saveReglages', rg, () => { if(BOOT && BOOT.reglages) Object.assign(BOOT.reglages, rg); })
        .then(x => { if(!x.error) toast(x.offline?'Réglages en attente':'Réglages enregistrés'); });
    }}]);
}

/* ================= RÉGLAGES avancés (dialog) ================= */
function openSettings(){
  const dlg = $('#settings');
  $('#s-api').value = localStorage.getItem('jdl.apiUrl') || '';
  $('#s-client').value = localStorage.getItem('jdl.clientId') || '';
  $('#s-status').textContent = store.session ? ('Connecté : ' + store.session.email) : 'Non connecté';
  dlg.showModal();
}
function wireSettings(){
  $('#s-save').onclick = () => {
    store.apiUrl = $('#s-api').value.trim();
    store.clientId = $('#s-client').value.trim();
    toast('Enregistré — rechargement…'); setTimeout(() => location.reload(), 600);
  };
  $('#s-logout').onclick = logout;
  $('#s-close').onclick = () => $('#settings').close();
  $('#auth-settings').onclick = openSettings;
  $('#gbtn-fallback').onclick = () => { try{ google.accounts.id.prompt(); }catch(e){} };
}

/* ================= utilitaires UI ================= */
function modal(titre, html, btns){
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="scrim">'+
    '<div class="sheet"><div class="grabber"></div><h2>'+esc(titre)+'</h2>'+html+
    '<div class="row" style="gap:8px;margin-top:14px">'+
    btns.map((b,i) => '<button class="btn '+(b.p?'':'sec')+'" data-i="'+i+'">'+b.t+'</button>').join('')+
    '</div></div></div>';
  root.querySelector('.scrim').addEventListener('click', e => { if(e.target === e.currentTarget) closeModal(); });
  btns.forEach((b,i) => { root.querySelector('[data-i="'+i+'"]').onclick = b.c; });
}
function closeModal(){ document.getElementById('modal-root').innerHTML = ''; }
function segb(label, on, val){ return '<button class="'+(on?'on':'')+'" data-val="'+escAttr(val!==undefined?val:label)+'" onclick="segPick(this)">'+esc(String(label))+'</button>'; }
function segPick(b){ [].slice.call(b.parentNode.children).forEach(x => x.classList.remove('on')); b.classList.add('on'); }
function segVal(id, num){ const b = document.querySelector('#'+id+' .on'); const v = b ? b.dataset.val : ''; return num ? (+v||0) : v; }
function val(id){ return document.getElementById(id).value; }
function toast(m, err){
  const t = document.getElementById('toast');
  t.textContent = m; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), err ? 3200 : 2200);
}
function err(e){ toast('Erreur : ' + ((e && e.message) || e), true); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escAttr(s){ return esc(s); }
function fmtMin(m){ const h = Math.floor(m/60), x = m%60; return h ? (h+' h'+(x?' '+x:'')) : (m+' min'); }
function fmtMinShort(m){ return m>=60 ? (Math.round(m/60*10)/10+'h') : (m+'′'); }
function dateFr(d){ const p = String(d).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }

/* ------------------------------------------------------------------ INIT -- */
function registerSW(){
  if(!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if(hadController) location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
}

window.addEventListener('online', () => { updateOfflineUi(); flushQueue(); });
window.addEventListener('offline', updateOfflineUi);

document.addEventListener('DOMContentLoaded', () => {
  wireSettings();
  const s = store.session;
  if(s && s.exp > Date.now()) bootApp();
  else showAuth();
});
