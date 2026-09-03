/**
 * Journal de Lecture — Backend
 * Projet Apps Script lié à la feuille « Journal de Lecture — Base de données ».
 *
 * Rôle : la feuille = base de données pure (onglets `sessions`, `livres`, `reglages`).
 *        L'interface est la PWA (repo journal-lecture, GitHub Pages) qui appelle doPost().
 *        doGet() sert aussi l'app en direct (mode dégradé / secours).
 *
 * Points d'entrée principaux :
 *   - doPost()             : API JSON de la PWA (auth Google + actions)
 *   - doGet()              : sert l'application web en direct
 *   - setupBase()          : (1 fois) crée les onglets + en-têtes + réglages par défaut
 *   - importerHistorique() : migre l'ancienne feuille vers la BDD
 *
 * Perf (rév. 2026-09) : cache de lecture par requête (_CACHE / _MEMO) + écritures
 *   groupées (un seul setValues au lieu d'une boucle de setValue). Le contrat JSON
 *   est INCHANGÉ — la PWA n'a pas besoin d'être modifiée.
 */

const CFG = {
  TZ: 'Europe/Paris',
  ANCIENNE_FEUILLE_ID: '1o5M0fQrdrFsQX72sOT-rwbV60AC-rYxjbbGogV3BBWk',
  ANCIEN_ONGLET: 'Journal de bord',
  T_SESSIONS: 'sessions',
  T_LIVRES: 'livres',
  T_REGLAGES: 'reglages',
  // Auth PWA — client OAuth partagé avec les autres PWA (même origine github.io)
  CLIENT_ID: '291608936405-ddbgkq5hchqu42n3k92ajo95guokt6vn.apps.googleusercontent.com',
  EMAIL_AUTORISE: 'anthony.careddu23@gmail.com',
  SESSION_JOURS: 30,
};

const H_SESSIONS = ['id', 'date', 'livre', 'minutes', 'source', 'note', 'horodatage'];
const H_LIVRES = ['titre', 'format', 'nature', 'statut', 'serie', 'favori', 'note', 'commentaire', 'date_debut', 'date_fin', 'alias', 'horodatage'];

const FORMATS = ['Roman', 'Manga', 'Manhwa', 'Comics', 'BD', 'Light Novel', 'Essai', 'Autre'];
const NATURES = ['Fond', 'Parallèle', 'Feuilleton'];
const STATUTS = ['À lire', 'En cours', 'En pause', 'Terminé', 'Abandonné'];

const REGLAGES_DEFAUT = {
  objectif_annuel_min: '6000',
  objectif_quotidien_min: '20',
  seuil_violet: '50',
  seuil_vert: '20',
  seuil_jaune: '5',
  pause_auto_jours: '21',
  session_en_cours: '',
};

/* ------------------------------------------------------------------ */
/*  Cache par exécution                                                 */
/* ------------------------------------------------------------------ */
/* Chaque appel à lire_() relit tout l'onglet (getDataRange). getBootstrap()
   en enchaînait ~5 sur `sessions` et ~3 sur `livres`, à chaque écriture.
   Ici on mémorise le résultat le temps d'une requête. Remis à zéro en tête
   de doPost/doGet (au cas où Apps Script recycle l'instance) et après chaque
   écriture, pour ne jamais servir de données périmées. */

var _CACHE = {};   // nom d'onglet -> liste d'objets (voir lire_)
var _MEMO = {};    // agrégats dérivés (indexSessions_, livresEnrichis_)

function _resetCaches_() { _CACHE = {}; _MEMO = {}; }

function safeParse_(s) {
  try { return s ? JSON.parse(s) : null; } catch (_) { return null; }
}

/* ------------------------------------------------------------------ */
/*  Application web                                                     */
/* ------------------------------------------------------------------ */

var APP_URL = 'https://anthonycareddu.github.io/journal-lecture/';

function doGet() {
  // L'interface est la PWA. Ici on ne sert qu'une page d'aiguillage
  // (le déploiement est « accessible à tous » pour que le fetch de la PWA fonctionne ;
  //  toutes les actions passent par doPost() qui exige un jeton Google valide).
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Journal de Lecture</title>'
    + '<div style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;text-align:center">'
    + '<h1 style="font-weight:600">Journal de Lecture</h1>'
    + '<p>L\'application est ici :</p>'
    + '<p><a href="' + APP_URL + '" style="display:inline-block;background:#8a3a42;color:#fff;padding:.7rem 1.4rem;border-radius:10px;text-decoration:none">Ouvrir l\'application</a></p>'
    + '<p style="color:#888;font-size:.85rem;margin-top:2rem">Cette adresse est l\'API de l\'application.</p></div>'
  ).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ */
/*  API JSON (PWA)                                                      */
/* ------------------------------------------------------------------ */

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  _resetCaches_();

  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (_) { return jsonOut_({ ok: false, error: 'bad_request' }); }

  try {
    if (body.action === 'login') {
      return jsonOut_({ ok: true, data: login_(body.googleToken) });
    }
    var email = verifierSession_(body.token);          // lève 'unauthorized'
    var data = dispatch_(body.action, body.payload || {}, email);
    return jsonOut_({ ok: true, data: data });
  } catch (err) {
    return jsonOut_({ ok: false, error: String((err && err.message) || err) });
  }
}

function dispatch_(action, p, email) {
  switch (action) {
    case 'bootstrap':      return getBootstrap(email, { pauseAuto: true });
    case 'month':          return getMonthGrid(+p.year, +p.month);
    case 'stats':          return getStats(p.year ? +p.year : null);
    case 'sessions':       return getSessions(p);
    case 'addSession':     return addSession(p);
    case 'updateSession':  return updateSession(p.id, p);
    case 'deleteSession':  return deleteSession(p.id);
    case 'saveBook':       return saveBook(p);
    case 'createBook':     return creerLivre(p);
    case 'mergeBooks':     return mergeBooks(p.sources, p.cible);
    case 'setChrono':      return setLivreChrono(p.titre);
    case 'saveReglages':   return saveReglages(p);
    case 'setRunning':     return setRunning(p.state);
    default: throw new Error('unknown_action');
  }
}

/* --- Auth : vérifie le jeton Google, émet un jeton de session signé --- */

function secret_() {
  var pr = PropertiesService.getScriptProperties();
  var s = pr.getProperty('SESSION_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); pr.setProperty('SESSION_SECRET', s); }
  return s;
}

function b64_(bytes) { return Utilities.base64EncodeWebSafe(bytes); }

function login_(googleToken) {
  if (!googleToken) throw new Error('google_token_invalid');
  var resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(googleToken),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('google_token_invalid');
  var info = JSON.parse(resp.getContentText());
  if (info.aud !== CFG.CLIENT_ID) throw new Error('google_token_invalid');
  if (String(info.email_verified) !== 'true') throw new Error('google_token_invalid');
  var email = String(info.email || '').toLowerCase();
  if (email !== CFG.EMAIL_AUTORISE.toLowerCase()) throw new Error('email_not_allowed');

  var exp = Date.now() + CFG.SESSION_JOURS * 86400000;
  var payload = email + '|' + exp;
  var sig = b64_(Utilities.computeHmacSha256Signature(payload, secret_()));
  return { token: b64_(Utilities.newBlob(payload).getBytes()) + '.' + sig, exp: exp, email: email };
}

function verifierSession_(token) {
  if (!token || token.indexOf('.') < 0) throw new Error('unauthorized');
  var parts = token.split('.');
  var payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); }
  catch (_) { throw new Error('unauthorized'); }
  var expected = b64_(Utilities.computeHmacSha256Signature(payload, secret_()));
  if (parts[1] !== expected) throw new Error('unauthorized');
  var bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) throw new Error('unauthorized');
  if (bits[0] !== CFG.EMAIL_AUTORISE.toLowerCase()) throw new Error('unauthorized');
  return bits[0];
}

/* ------------------------------------------------------------------ */
/*  Helpers feuille                                                     */
/* ------------------------------------------------------------------ */

function ss_() { return SpreadsheetApp.getActive(); }
function sh_(nom) { return ss_().getSheetByName(nom); }

function today_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }
function nowIso_() { return Utilities.formatDate(new Date(), CFG.TZ, "yyyy-MM-dd'T'HH:mm:ss"); }

/** Toute valeur de date -> 'yyyy-MM-dd'. Gère Date, ISO et JJ/MM/AAAA. */
function d2s_(v) {
  const p = parseDate_(v);
  if (p) return p;
  return String(v == null ? '' : v).trim().slice(0, 10);
}
function toInt_(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
function toNum_(v) { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; }

/** Convertit une valeur en 'yyyy-MM-dd'. Gère Date, ISO, et JJ/MM/AAAA. Renvoie '' si illisible. */
function parseDate_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz || CFG.TZ, 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function normTitre_(t) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
}

/** Lit un onglet comme liste d'objets (clés = en-têtes ligne 1). Mémorisé par requête. */
function lire_(nom) {
  if (_CACHE[nom]) return _CACHE[nom];
  const sh = sh_(nom);
  if (!sh) return (_CACHE[nom] = []);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return (_CACHE[nom] = []);
  const hs = vals[0].map(String);
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const r = vals[i];
    if (r.join('') === '') continue;
    const o = {};
    for (let j = 0; j < hs.length; j++) o[hs[j]] = r[j];
    o._row = i + 1;
    out.push(o);
  }
  return (_CACHE[nom] = out);
}

function reglages_() {
  const map = {};
  Object.keys(REGLAGES_DEFAUT).forEach(k => (map[k] = REGLAGES_DEFAUT[k]));
  lire_(CFG.T_REGLAGES).forEach(r => { if (r.cle !== '' && r.cle != null) map[r.cle] = String(r.valeur); });
  return map;
}

function ecrireReglage_(cle, valeur) {
  const sh = sh_(CFG.T_REGLAGES);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === cle) {
      sh.getRange(i + 1, 2).setValue(valeur);
      _resetCaches_();
      return;
    }
  }
  sh.appendRow([cle, valeur]);
  _resetCaches_();
}

/* ------------------------------------------------------------------ */
/*  Installation de la base                                             */
/* ------------------------------------------------------------------ */

function setupBase() {
  _resetCaches_();
  const ss = ss_();
  ss.setSpreadsheetTimeZone(CFG.TZ);

  const mk = (nom, headers) => {
    let sh = ss.getSheetByName(nom);
    if (!sh) sh = ss.insertSheet(nom);
    if (headers) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    return sh;
  };

  const shS = mk(CFG.T_SESSIONS, H_SESSIONS);
  shS.getRange('B:B').setNumberFormat('@'); // date en texte
  shS.getRange('D:D').setNumberFormat('0');
  shS.setColumnWidths(1, H_SESSIONS.length, 130);

  const shL = mk(CFG.T_LIVRES, H_LIVRES);
  shL.setColumnWidth(1, 260);
  shL.getRange('I:J').setNumberFormat('@'); // date_debut / date_fin en texte
  const dv = (col, list) => shL.getRange(2, col, shL.getMaxRows() - 1, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build());
  dv(2, FORMATS); dv(3, NATURES); dv(4, STATUTS);

  const shR = mk(CFG.T_REGLAGES, ['cle', 'valeur']);
  const clesExistantes = {};
  shR.getDataRange().getValues().slice(1).forEach(r => { clesExistantes[String(r[0])] = true; });
  const ajouts = [];
  Object.keys(REGLAGES_DEFAUT).forEach(k => {
    if (!clesExistantes[k]) ajouts.push([k, REGLAGES_DEFAUT[k]]);
  });
  if (ajouts.length) shR.getRange(shR.getLastRow() + 1, 1, ajouts.length, 2).setValues(ajouts);

  // Retire la feuille par défaut « Feuille 1 » si vide
  const f1 = ss.getSheetByName('Feuille 1') || ss.getSheetByName('Sheet1');
  if (f1 && ss.getSheets().length > 1 && f1.getLastRow() === 0) ss.deleteSheet(f1);

  _resetCaches_();
  return 'Base prête : ' + ss.getSheets().map(s => s.getName()).join(', ');
}

/* ------------------------------------------------------------------ */
/*  Migration de l'ancienne feuille                                     */
/* ------------------------------------------------------------------ */

// Regroupe des orthographes différentes d'un même titre.
const ALIAS_MANUELS = {
  'Solo Levelling': 'Solo Leveling',
  'Solo Levelling T11': 'Solo Leveling T11',
  'Solo Levelling T13': 'Solo Leveling T13',
  'Solo Levelling T14': 'Solo Leveling T14',
  'Solo Levelling T15': 'Solo Leveling T15',
  'Solo Levelling T16': 'Solo Leveling T16',
  'Solo Levelling T17': 'Solo Leveling T17',
  'Lecteur omniscient': 'Lecteur Omniscient',
  'Omniscient Reader': 'Lecteur Omniscient',
  'Druid of seoul station': 'Druid of Seoul Station',
  'Druid of seoul station ': 'Druid of Seoul Station',
  'DCEASED  T2': 'DCEASED T2',
  'DCEASED  T3': 'DCEASED T3',
  'From Fps TO RPG T04': 'From FPS to RPG T04',
  'From Fps To RPG T02': 'From FPS to RPG T02',
  'From Frps To RPG T03': 'From FPS to RPG T03',
  'Brigthest Day - T1': 'Brightest Day T1',
  'Brigthest Day - T2': 'Brightest Day T2',
  'Brigthest Day - T3': 'Brightest Day T3',
};

function canon_(titre) {
  const t = normTitre_(titre);
  return ALIAS_MANUELS[t] || t;
}

// L'ancien journal ne marquait pas toujours un livre fini (dernière séance en «➡️»),
// ou mélangeait deux titres dans une même cellule (ex. « Chevalier errant ⏎ Walking Dead »).
// Ces listes forcent le bon statut à l'import. Titres = forme canonique (après canon_).
var TERMINES_MANUELS = {
  'Chroniques du chevalier errant': 1,
  'Feu et sang: Intégrale': 1,
  'Le Trône de fer Intégrale 1': 1,
  'Mashle - T17': 1
};
var ABANDONNES_MANUELS = {
  'Dune - La Communauté des sœurs': 1
};

// Devine le format d'un titre à partir de mots-clés.
function devineFormat_(titre) {
  const t = titre.toLowerCase();
  const has = (arr) => arr.some(w => t.indexOf(w) >= 0);
  if (has(['pour les nuls', "l'art de", 'l’art de', 'comment ', 'votre idée', 'on est foutu', 'le bonheur est caché',
           'gagner du temps', 'rester serein', 'pouvoir du moment', 'agir et penser', 'ce livre vous', 'mémoire',
           'culture general', 'culture générale', 'ralentir', 'tout apprendre', "arrêtez d'oublier", 'idée va'])) return 'Essai';
  if (has(['frieren', 'kaiju', 'mashle', 'one piece', 'solo leveling', 'tsugai', 'boruto', 'fairy tail', 'shinzero',
           'druid of seoul', 'chainsaw', 'jujutsu', 'nou3'])) return 'Manga';
  if (has(['overgeared', 'tbate', 'the world after the fall', 'wold after the fall', 'return survival', 'lecteur omniscient',
           'omniscient reader', 'harpe des quatre', 'the marshal king', 'from fps to rpg', 'druid of seoul station'])) return 'Manhwa';
  if (has(['batman', 'superman', 'justice league', 'injustice', 'joker', 'dceased', 'dc vampires', 'green lantern',
           'blackest night', 'brightest day', 'brigthest', 'crisis on infinite', 'transmetropolitan', 'y le dernier homme',
           'saga -', 'saga –', 'fables', 'planetary', 'transformers', 'void rival', 'gi joe', 'g.i. joe', 'cobra', 'duke',
           'destro', 'scarlet', 'walking dead', 'twd', 'clementine', 'civil war', 'house of m', 'siege', 'daredevil',
           'nightwing', 'robin infinite', 'harley quinn', 'wonder woman infinite', 'swamp thing', 'red hood', 'gotham central',
           'top 10', 'punk rock jesus', 'v pour vendetta', 'hellblazer', 'mister miracle', 'super sons', 'jurassic league',
           'dark knight of steel', 'dark knigth of steel', 'multivers noir', 'multiversity', 'death metal', 'metal ',
           'new justice', 'doom war', 'basketful of heads', 'zorro', 'daytripper', 'seigneurs de bagdad', 'all star superman',
           'sheriff of babylon', 'jaune t', 'rive gauche', 'supergirl', 'tortues ninja', 'tortues ninjas', 'frontier',
           'nou3', 'one operation joker', 'batman & les', 'batman &', 'chevalier errant', 'chroniques du chevalier'])) return 'Comics';
  if (has(['dune', 'trône de fer', 'trone de fer', 'metro 2033', 'world war z', 'harry potter', 'swan song',
           'maison des feuilles', 'fraternité de l', 'fraternite de l', 'deux tours', "l'assassin royal", 'assassin royal',
           'feu et sang', 'communauté des sœurs', 'communaute des soeurs', 'maison des mères', 'maison des meres',
           'seigneur des anneaux', 'ascension du gouverneur', 'route de woodbury', 'mystère du monde quantique',
           'monde quantique'])) return 'Roman';
  return 'Autre';
}

function devineNature_(titre, format) {
  const t = titre.toLowerCase();
  const feuilletons = ['overgeared', 'tbate', 'solo leveling', 'one piece', 'frieren', 'kaiju', 'walking dead',
    'lecteur omniscient', 'return survival', 'boruto', 'from fps to rpg', 'druid of seoul station', 'mashle',
    'fairy tail', 'tsugai'];
  if (feuilletons.some(w => t.indexOf(w) >= 0)) return 'Feuilleton';
  if (format === 'Roman' || format === 'Essai' || format === 'Light Novel') return 'Fond';
  return 'Parallèle';
}

/**
 * Migre l'ancienne feuille. Idempotent : refuse si `sessions` contient déjà des lignes,
 * sauf si force === true (efface d'abord).
 */
function importerHistorique(force) {
  _resetCaches_();
  const shS = sh_(CFG.T_SESSIONS), shL = sh_(CFG.T_LIVRES);
  if (!shS || !shL) return { ok: false, message: 'Lance d\'abord setupBase().' };

  if (shS.getLastRow() > 1) {
    if (!force) return { ok: false, message: 'L\'onglet sessions contient déjà ' + (shS.getLastRow() - 1) + ' lignes. Relance avec force=true pour tout remplacer.' };
    shS.getRange(2, 1, shS.getLastRow() - 1, H_SESSIONS.length).clearContent();
    if (shL.getLastRow() > 1) shL.getRange(2, 1, shL.getLastRow() - 1, H_LIVRES.length).clearContent();
  }

  const srcSS = SpreadsheetApp.openById(CFG.ANCIENNE_FEUILLE_ID);
  const srcTz = srcSS.getSpreadsheetTimeZone() || CFG.TZ;
  const src = srcSS.getSheetByName(CFG.ANCIEN_ONGLET);
  const rng = src.getDataRange();
  const vals = rng.getValues();
  const disp = rng.getDisplayValues(); // "100%"/"1%" sont stockés comme nombres -> on lit l'affichage
  const td = today_();

  const sessions = [];
  const livres = {}; // canon -> {aliases, premiere, derniere, minutes, fini, stop}
  const ignorees = [];
  let seq = Date.now();

  // Pré-passe : combien de fois chaque titre apparaît SEUL dans une cellule.
  // Sert à distinguer une vraie cellule à 2 titres (« A ⏎ B ») d'un titre coupé sur 2 lignes.
  const titresSeuls = {};
  for (let i = 1; i < vals.length; i++) {
    const raw = String(vals[i][1] == null ? '' : vals[i][1]);
    if (raw.indexOf('\n') >= 0) continue;
    const t = canon_(normTitre_(raw));
    if (t) titresSeuls[t] = (titresSeuls[t] || 0) + 1;
  }

  for (let i = 1; i < vals.length; i++) {
    const dRaw = vals[i][0];
    const raw = String(vals[i][1] == null ? '' : vals[i][1]);
    const brut = normTitre_(raw);
    if ((dRaw === '' || dRaw == null) && !brut) continue;

    const date = parseDate_(dRaw, srcTz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { ignorees.push('L' + (i + 1) + ' date=' + dRaw); continue; }
    if (!brut) { ignorees.push('L' + (i + 1) + ' sans titre (' + date + ')'); continue; }

    const minutes = toInt_(vals[i][2]);
    const prog = String(disp[i][3] || vals[i][3] || '').trim();
    const progNum = toNum_(vals[i][3]);
    const note = String(disp[i][4] || vals[i][4] || '').trim();
    const estFini = prog === '100%' || prog === '100 %' || prog.toUpperCase() === 'FULL'
      || prog === '✅' || progNum >= 1;
    const estStop = /^stop$/i.test(prog);   // marqueur d'abandon explicite

    // On n'importe que les vraies séances de lecture (durée > 0).
    // Les lignes à 0 min (jours suivis sans lecture, cases pré-remplies) sont ignorées.
    if (minutes <= 0) continue;

    // Cellule à 2 titres (« Chevalier errant ⏎ Walking Dead T13 ») -> une séance par titre,
    // uniquement si le 1er titre est un livre déjà vu seul ailleurs (>= 3 fois).
    const lignes = raw.split(/\r?\n/).map(s => normTitre_(s)).filter(Boolean);
    const multi = lignes.length >= 2 && titresSeuls[canon_(lignes[0])] >= 3;
    const titres = multi ? lignes.map(canon_) : [canon_(brut)];

    titres.forEach(titre => {
      sessions.push(['s' + (seq++), date, titre, minutes, 'import', note, nowIso_()]);
      const L = livres[titre] || (livres[titre] = { aliases: {}, premiere: date, derniere: date, minutes: 0, fini: false, stop: false });
      if (!multi && brut !== titre) L.aliases[brut] = true;
      if (date < L.premiere) L.premiere = date;
      if (date > L.derniere) L.derniere = date;
      L.minutes += minutes;
      if (estFini) { L.fini = true; L.finLe = date; }
      if (estStop) L.stop = true;
    });
  }

  if (sessions.length) shS.getRange(2, 1, sessions.length, H_SESSIONS.length).setValues(sessions);

  // Dernier livre lu = livre du chrono par défaut
  let dernierLivre = '';
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i][3] > 0) { dernierLivre = sessions[i][2]; break; }
  }

  const pauseJours = toInt_(reglages_().pause_auto_jours) || 21;
  const rows = Object.keys(livres).map(titre => {
    const L = livres[titre];
    const fmt = devineFormat_(titre);
    const nat = devineNature_(titre, fmt);
    const fini = L.fini || TERMINES_MANUELS[titre];
    let statut, dateFin = '';
    if (fini) { statut = 'Terminé'; dateFin = L.finLe || L.derniere; }
    else if (L.stop || ABANDONNES_MANUELS[titre]) { statut = 'Abandonné'; }
    else {
      const joursDepuis = Math.round((new Date(td) - new Date(L.derniere)) / 86400000);
      statut = joursDepuis > pauseJours ? 'En pause' : 'En cours';
    }
    return [titre, fmt, nat, statut, '', titre === dernierLivre, '', '',
            '', dateFin, Object.keys(L.aliases).join(' | '), nowIso_()];
  }).sort((a, b) => a[0].localeCompare(b[0], 'fr'));

  if (rows.length) shL.getRange(2, 1, rows.length, H_LIVRES.length).setValues(rows);

  _resetCaches_();

  const totMin = sessions.reduce((s, r) => s + r[3], 0);
  const parAn = {};
  sessions.forEach(r => { parAn[r[1].slice(0, 4)] = (parAn[r[1].slice(0, 4)] || 0) + r[3]; });
  return {
    ok: true,
    sessions: sessions.length,
    livres: rows.length,
    minutes: totMin,
    parAnnee: parAn,
    ignorees: ignorees.length,
    ignoreesDetail: ignorees.slice(0, 30),
    dernierLivre: dernierLivre,
    message: `Import OK : ${sessions.length} sessions · ${rows.length} livres · ${totMin} min (${Math.round(totMin / 60)} h)`
      + ` · ${ignorees.length} ligne(s) ignorée(s). Livre du chrono : ${dernierLivre || '—'}.`,
  };
}

/** Ré-importe en remplaçant tout (bouton Exécuter). */
function reimporter() {
  const r = importerHistorique(true);
  Logger.log(r.message);
  Logger.log('Par année : ' + JSON.stringify(r.parAnnee));
  if (r.ignoreesDetail && r.ignoreesDetail.length) Logger.log('Ignorées : ' + r.ignoreesDetail.join(' | '));
  return r;
}

/** À lancer une fois dans l'éditeur pour accorder les autorisations
 *  (accès au Sheet + requêtes externes pour vérifier le jeton Google). */
function autoriser() {
  var a = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true }).getResponseCode();
  var b = SpreadsheetApp.openById(CFG.ANCIENNE_FEUILLE_ID).getName();
  Logger.log('OK — external_request:' + a + ' · ancienne feuille:' + b);
  return 'OK';
}

/** Contrôle rapide : compteurs de la base (bouton Exécuter). */
function diagnostic() {
  _resetCaches_();
  const S = lire_(CFG.T_SESSIONS), L = lire_(CFG.T_LIVRES);
  const parAn = {}, parStatut = {}, parFormat = {};
  let tot = 0;
  S.forEach(s => { tot += toInt_(s.minutes); const a = d2s_(s.date).slice(0, 4); parAn[a] = (parAn[a] || 0) + toInt_(s.minutes); });
  L.forEach(l => { parStatut[l.statut] = (parStatut[l.statut] || 0) + 1; parFormat[l.format] = (parFormat[l.format] || 0) + 1; });
  const out = {
    sessions: S.length, livres: L.length, minutesTotal: tot, heures: Math.round(tot / 60),
    parAnnee: parAn, parStatut: parStatut, parFormat: parFormat,
    chrono: L.filter(l => String(l.favori).toUpperCase() === 'TRUE' || String(l.favori) === 'VRAI').map(l => l.titre),
  };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * À LANCER UNE FOIS depuis l'éditeur (bouton Exécuter). Idempotent (ré-exécutable sans dégât).
 * Corrige les livres mal classés par la migration :
 *   - la cellule à 2 titres « Chevalier errant ⏎ Walking Dead T13 » du 15/09/2025 :
 *     ce jour-là tu as FINI le Chevalier errant ET lu Walking Dead T13. La migration
 *     n'en avait fait qu'un livre bâtard. → on garde la séance sur « Chevalier errant »
 *     (fini) et on recrée « Walking Dead T13 » (fini) avec sa propre séance ce jour-là.
 *   - passe en « Terminé » des livres finis jamais marqués 100 %
 *   - passe en « Abandonné » le livre marqué STOP dans l'ancien journal
 * Non destructif : ne touche qu'au statut de ces livres (+ 1 fusion + 1 séance ajoutée).
 * Les cas ambigus sont seulement listés — à trancher dans l'app.
 */
function corrigerStatuts() {
  _resetCaches_();
  const sh = sh_(CFG.T_LIVRES);
  const log = [];
  const setStatut = (titre, statut) => {
    const r = _findLivreRow(titre);
    if (r > 0) { sh.getRange(r, 4).setValue(statut); _resetCaches_(); log.push(statut + ' : ' + titre); }
    else log.push('(introuvable) ' + titre);
  };

  // 1) cellule à 2 titres du 15/09/2025 — rattacher la séance « 100% » au Chevalier errant…
  const fantome = 'Chroniques du chevalier errant Walking Dead T13';
  if (_findLivreRow(fantome) > 0) {
    mergeBooks([fantome], 'Chroniques du chevalier errant');
    log.push('Fusionné : « ' + fantome + ' » → « Chroniques du chevalier errant »');
  }
  // …et matérialiser Walking Dead T13 (lu le même jour, avant la série T14→T33)
  if (_findLivreRow('Walking Dead T13') < 0) {
    addSession({ date: '2025-09-15', livre: 'Walking Dead T13', minutes: 20, source: 'import', termine: true });
    log.push('Créé : Walking Dead T13 (Terminé, 15/09/2025)');
  }

  // 2) finis mais jamais marqués 100 % dans l'ancien journal
  ['Feu et sang: Intégrale', 'Le Trône de fer Intégrale 1',
   'Chroniques du chevalier errant', 'Mashle - T17'].forEach(t => setStatut(t, 'Terminé'));

  // 3) abandon explicite (marqueur STOP)
  ['Dune - La Communauté des sœurs'].forEach(t => setStatut(t, 'Abandonné'));

  // 4) à trancher toi-même dans l'app (Abandonné ou vraie pause)
  log.push('--- à voir dans l\'app : TBATE · Batman Chronicles - 1988 V1 · Hellblazer · The wold after the fall');

  _resetCaches_();
  SpreadsheetApp.flush();
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Agrégats livres  (mémorisés par requête)                            */
/* ------------------------------------------------------------------ */

function indexSessions_() {
  if (_MEMO.idx) return _MEMO.idx;
  const parLivre = {};
  lire_(CFG.T_SESSIONS).forEach(s => {
    const t = normTitre_(s.livre);
    const m = toInt_(s.minutes);
    const d = d2s_(s.date);
    const L = parLivre[t] || (parLivre[t] = { minutes: 0, count: 0, jours: {}, premiere: d, derniere: d });
    L.minutes += m; L.count++; L.jours[d] = (L.jours[d] || 0) + m;
    if (d < L.premiere) L.premiere = d;
    if (d > L.derniere) L.derniere = d;
  });
  return (_MEMO.idx = parLivre);
}

function livresEnrichis_() {
  if (_MEMO.livres) return _MEMO.livres;
  const idx = indexSessions_();
  const tdMs = new Date(today_()).getTime();
  const out = lire_(CFG.T_LIVRES).map(l => {
    const titre = normTitre_(l.titre);
    const ag = idx[titre] || { minutes: 0, count: 0, jours: {}, premiere: '', derniere: '' };
    const joursActifs = Object.keys(ag.jours).length;
    const debut = d2s_(l.date_debut) || ag.premiere;
    const fin = d2s_(l.date_fin) || ag.derniere;
    const dureeCal = (debut && fin) ? Math.round((new Date(fin) - new Date(debut)) / 86400000) + 1 : 0;
    const depuis = ag.derniere ? Math.round((tdMs - new Date(ag.derniere).getTime()) / 86400000) : null;
    return {
      titre: titre,
      format: l.format || 'Autre',
      nature: l.nature || 'Parallèle',
      statut: l.statut || 'En cours',
      serie: l.serie || '',
      favori: l.favori === true || String(l.favori).toUpperCase() === 'TRUE' || String(l.favori) === 'VRAI',
      note: toNum_(l.note),
      commentaire: l.commentaire || '',
      alias: l.alias || '',
      totalMinutes: ag.minutes,
      sessionsCount: ag.count,
      joursActifs: joursActifs,
      premiere: ag.premiere,
      derniere: ag.derniere,
      debut: debut,
      fin: fin,
      dureeCal: dureeCal,
      moyJourActif: joursActifs ? Math.round(ag.minutes / joursActifs) : 0,
      joursDepuis: depuis,
    };
  });
  return (_MEMO.livres = out);
}

/* ------------------------------------------------------------------ */
/*  API — lecture                                                       */
/* ------------------------------------------------------------------ */

/** Passe « En cours » -> « En pause » les livres sans séance depuis > pause_auto_jours.
 *  Appelé au chargement de l'app (action `bootstrap`), pas à chaque écriture. */
function appliquerPauseAuto_() {
  const seuil = toInt_(reglages_().pause_auto_jours);
  if (!seuil || seuil < 1) return;
  const sh = sh_(CFG.T_LIVRES);
  const last = sh.getLastRow();
  if (last < 2) return;
  const idx = indexSessions_();
  const tdMs = new Date(today_()).getTime();
  const cible = [];
  lire_(CFG.T_LIVRES).forEach(l => {
    if (String(l.statut) !== 'En cours') return;
    const ag = idx[normTitre_(l.titre)];
    if (!ag || !ag.derniere) return;
    if (Math.round((tdMs - new Date(ag.derniere).getTime()) / 86400000) > seuil) cible.push(l._row);
  });
  if (!cible.length) return;
  const col = sh.getRange(2, 4, last - 1, 1).getValues();   // colonne statut
  cible.forEach(rn => { col[rn - 2][0] = 'En pause'; });
  sh.getRange(2, 4, last - 1, 1).setValues(col);
  _resetCaches_();
}

function getBootstrap(email, opts) {
  if (opts && opts.pauseAuto) appliquerPauseAuto_();
  const r = reglages_();
  const livres = livresEnrichis_();
  const favori = livres.filter(l => l.favori)[0];
  const enCours = livres.filter(l => l.statut === 'En cours')
    .sort((a, b) => (b.derniere || '').localeCompare(a.derniere || ''));
  const anneeCourante = +today_().slice(0, 4);
  return {
    today: today_(),
    tz: CFG.TZ,
    email: email || CFG.EMAIL_AUTORISE,
    reglages: r,
    formats: FORMATS, natures: NATURES, statuts: STATUTS,
    livres: livres,
    livreChrono: favori ? favori.titre : (enCours[0] ? enCours[0].titre : ''),
    running: safeParse_(r.session_en_cours),
    anneeCourante: anneeCourante,
    stats: getStats(anneeCourante),
    sessionsRecent: getSessions({ limit: 150 }),
  };
}

function getMonthGrid(year, month) { // month : 1-12
  const jours = {}; // 'yyyy-MM-dd' -> {minutes, livres:{}}
  lire_(CFG.T_SESSIONS).forEach(s => {
    const d = d2s_(s.date);
    if (d.slice(0, 7) !== year + '-' + String(month).padStart(2, '0')) return;
    const j = jours[d] || (jours[d] = { minutes: 0, livres: {} });
    const m = toInt_(s.minutes);
    j.minutes += m;
    j.livres[normTitre_(s.livre)] = (j.livres[normTitre_(s.livre)] || 0) + m;
  });

  // livres terminés ce mois-ci (date_fin dérivée = dernière session)
  const prefixe = year + '-' + String(month).padStart(2, '0');
  const finis = {};
  livresEnrichis_().forEach(l => {
    const jf = l.fin || l.derniere;
    if (l.statut === 'Terminé' && jf && jf.slice(0, 7) === prefixe) {
      (finis[jf] = finis[jf] || []).push(l.titre);
    }
  });

  const r = reglages_();
  const seuils = { v: toInt_(r.seuil_violet), g: toInt_(r.seuil_vert), j: toInt_(r.seuil_jaune) };
  const premier = new Date(Date.UTC(year, month - 1, 1));
  const decalage = (premier.getUTCDay() + 6) % 7; // Lundi = 0
  const nbJours = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < decalage; i++) cells.push(null);
  for (let d = 1; d <= nbJours; d++) {
    const iso = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const j = jours[iso] || { minutes: 0, livres: {} };
    let bucket = 'zero';
    if (j.minutes >= seuils.v) bucket = 'violet';
    else if (j.minutes >= seuils.g) bucket = 'vert';
    else if (j.minutes >= seuils.j) bucket = 'jaune';
    else if (j.minutes >= 1) bucket = 'rouge';
    cells.push({
      day: d, date: iso, minutes: j.minutes, bucket: bucket,
      livres: Object.keys(j.livres).map(t => ({ titre: t, minutes: j.livres[t] })).sort((a, b) => b.minutes - a.minutes),
      finis: finis[iso] || [],
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const totMois = Object.values(jours).reduce((s, j) => s + j.minutes, 0);
  return {
    year: year, month: month,
    cells: cells,
    totalMinutes: totMois,
    joursLus: Object.values(jours).filter(j => j.minutes > 0).length,
    livresTermines: Object.values(finis).reduce((s, a) => s + a.length, 0),
    seuils: seuils,
  };
}

function getStats(year) {
  const anneeAujourdhui = +today_().slice(0, 4);
  year = year || anneeAujourdhui;
  const sessions = lire_(CFG.T_SESSIONS).map(s => ({ date: d2s_(s.date), livre: normTitre_(s.livre), min: toInt_(s.minutes) }));
  const livres = livresEnrichis_();

  const parJour = {}, parMois = {}, parAn = {}, parAnLiv = {};
  sessions.forEach(s => {
    parJour[s.date] = (parJour[s.date] || 0) + s.min;
    const an = s.date.slice(0, 4);
    parAn[an] = (parAn[an] || 0) + s.min;
    if (s.date.slice(0, 4) === String(year)) {
      const mo = parseInt(s.date.slice(5, 7), 10);
      parMois[mo] = (parMois[mo] || 0) + s.min;
    }
  });
  livres.forEach(l => {
    if (l.statut === 'Terminé' && (l.fin || l.derniere)) {
      const an = (l.fin || l.derniere).slice(0, 4);
      parAnLiv[an] = (parAnLiv[an] || 0) + 1;
    }
  });

  // séries de jours consécutifs (>0 min)
  const joursLus = Object.keys(parJour).filter(d => parJour[d] > 0).sort();
  let record = 0, courante = 0;
  if (joursLus.length) {
    let run = 1;
    for (let i = 1; i < joursLus.length; i++) {
      const diff = (new Date(joursLus[i]) - new Date(joursLus[i - 1])) / 86400000;
      run = (diff === 1) ? run + 1 : 1;
      if (run > record) record = run;
    }
    record = Math.max(record, 1);
    const td = today_();
    let cur = new Date(td);
    const set = new Set(joursLus);
    if (!set.has(td)) cur.setDate(cur.getDate() - 1); // aujourd'hui pas encore lu = ok
    while (set.has(Utilities.formatDate(cur, CFG.TZ, 'yyyy-MM-dd'))) { courante++; cur.setDate(cur.getDate() - 1); }
  }

  const perFormat = {};
  livres.forEach(l => { perFormat[l.format] = (perFormat[l.format] || 0) + l.totalMinutes; });

  const perWeekday = [0, 0, 0, 0, 0, 0, 0];
  Object.keys(parJour).forEach(d => { perWeekday[(new Date(d).getDay() + 6) % 7] += parJour[d]; });

  const topBooks = livres.slice().sort((a, b) => b.totalMinutes - a.totalMinutes).slice(0, 8)
    .map(l => ({ titre: l.titre, minutes: l.totalMinutes, format: l.format }));

  const totalYear = Object.values(parMois).reduce((a, b) => a + b, 0);
  const debutAnnee = new Date(Date.UTC(year, 0, 1));
  const maintenant = new Date(today_());
  const joursEcoules = year === anneeAujourdhui
    ? Math.round((maintenant - debutAnnee) / 86400000) + 1
    : 366;
  const r = reglages_();

  return {
    year: year,
    totalYear: totalYear,
    totalAll: Object.values(parAn).reduce((a, b) => a + b, 0),
    perMonth: Array.from({ length: 12 }, (_, i) => parMois[i + 1] || 0),
    booksFinishedYear: parAnLiv[String(year)] || 0,
    booksFinishedAll: livres.filter(l => l.statut === 'Terminé').length,
    livresEnCours: livres.filter(l => l.statut === 'En cours').length,
    livresEnPause: livres.filter(l => l.statut === 'En pause').length,
    streakCurrent: (year === anneeAujourdhui) ? courante : 0,
    streakRecord: record,
    avgPerDayYear: joursEcoules ? +(totalYear / joursEcoules).toFixed(1) : 0,
    projectionYear: joursEcoules ? Math.round(totalYear / joursEcoules * 365) : 0,
    goalYear: toInt_(r.objectif_annuel_min),
    perFormat: Object.keys(perFormat).map(f => ({ format: f, minutes: perFormat[f] })).sort((a, b) => b.minutes - a.minutes),
    perWeekday: perWeekday,
    topBooks: topBooks,
    perYear: Object.keys(parAn).sort().map(a => ({ year: a, minutes: parAn[a], books: parAnLiv[a] || 0 })),
  };
}

function getSessions(opts) {
  opts = opts || {};
  let rows = lire_(CFG.T_SESSIONS).map(s => ({
    id: s.id, date: d2s_(s.date), livre: normTitre_(s.livre),
    minutes: toInt_(s.minutes), source: s.source || '', note: s.note || '',
  }));
  if (opts.livre) rows = rows.filter(r => r.livre === opts.livre);
  rows.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const limit = opts.limit || 400;
  return rows.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/*  API — écriture                                                      */
/* ------------------------------------------------------------------ */

function _findLivreRow(titre) {
  const t = normTitre_(titre);
  const rows = lire_(CFG.T_LIVRES);
  for (let i = 0; i < rows.length; i++) if (normTitre_(rows[i].titre) === t) return rows[i]._row;
  return -1;
}

/** Crée ou met à jour une fiche livre en UNE écriture de ligne (au lieu d'un setValue par champ). */
function _upsertLivre(titre, patch) {
  const sh = sh_(CFG.T_LIVRES);
  titre = normTitre_(titre);
  const rows = lire_(CFG.T_LIVRES);
  let existing = null;
  for (let i = 0; i < rows.length; i++) {
    if (normTitre_(rows[i].titre) === titre) { existing = rows[i]; break; }
  }
  if (existing && !patch) return existing._row;

  const o = {};
  H_LIVRES.forEach(h => { o[h] = (existing && existing[h] != null) ? existing[h] : ''; });
  if (!existing) {
    o.titre = titre;
    o.format = (patch && patch.format) || devineFormat_(titre);
    o.nature = (patch && patch.nature) || devineNature_(titre, o.format);
    o.statut = (patch && patch.statut) || 'En cours';
    o.favori = false;
  }
  if (patch) Object.keys(patch).forEach(k => {
    if (H_LIVRES.indexOf(k) >= 0 && patch[k] !== undefined) o[k] = patch[k];
  });
  o.horodatage = nowIso_();
  const rowValues = H_LIVRES.map(h => (o[h] == null ? '' : o[h]));

  if (!existing) {
    sh.appendRow(rowValues);
    _resetCaches_();
    return sh.getLastRow();
  }
  sh.getRange(existing._row, 1, 1, H_LIVRES.length).setValues([rowValues]);
  _resetCaches_();
  return existing._row;
}

/** Coche « livre du chrono » (colonne favori) sur un seul titre — UNE écriture de colonne. */
function _setFavori_(titre) {
  const sh = sh_(CFG.T_LIVRES);
  const last = sh.getLastRow();
  if (last < 2) return;
  const cible = normTitre_(titre);
  const flags = [];
  for (let i = 0; i < last - 1; i++) flags.push([false]);
  lire_(CFG.T_LIVRES).forEach(r => {
    const k = r._row - 2;
    if (k >= 0 && k < flags.length) flags[k][0] = (normTitre_(r.titre) === cible);
  });
  sh.getRange(2, 6, flags.length, 1).setValues(flags);
  _resetCaches_();
}

function addSession(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const date = d2s_(p.date) || today_();
    const livre = normTitre_(p.livre);
    const minutes = Math.max(0, Math.round(toNum_(p.minutes)));
    if (!livre) throw new Error('Livre manquant.');
    if (minutes <= 0) throw new Error('Durée nulle.');

    sh_(CFG.T_SESSIONS).appendRow(['s' + Date.now(), date, livre, minutes, p.source || 'chrono', p.note || '', nowIso_()]);
    _resetCaches_();

    const existing = lire_(CFG.T_LIVRES).filter(r => normTitre_(r.titre) === livre)[0];
    const patch = {};
    if (existing) {
      if (p.termine) patch.statut = 'Terminé';
      else if (['En pause', 'À lire', 'Abandonné'].indexOf(String(existing.statut)) >= 0) patch.statut = 'En cours';
    } else {
      patch.statut = p.termine ? 'Terminé' : 'En cours';
    }
    if (p.format) patch.format = p.format;
    if (p.nature) patch.nature = p.nature;
    _upsertLivre(livre, Object.keys(patch).length ? patch : null);

    if (p.definirChrono) _setFavori_(livre);

    _resetCaches_();
    return { ok: true, message: '+' + minutes + ' min · ' + livre, bootstrap: getBootstrap() };
  } finally {
    lock.releaseLock();
  }
}

function updateSession(id, patch) {
  const sh = sh_(CFG.T_SESSIONS);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) {
      const row = vals[i].slice();
      if (patch.date != null) row[1] = d2s_(patch.date);
      if (patch.livre != null) row[2] = normTitre_(patch.livre);
      if (patch.minutes != null) row[3] = Math.max(0, Math.round(toNum_(patch.minutes)));
      if (patch.note != null) row[5] = patch.note;
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      _resetCaches_();
      return { ok: true, bootstrap: getBootstrap() };
    }
  }
  throw new Error('Session introuvable.');
}

function deleteSession(id) {
  const sh = sh_(CFG.T_SESSIONS);
  const vals = sh.getDataRange().getValues();
  for (let i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][0]) === String(id)) {
      sh.deleteRow(i + 1);
      _resetCaches_();
      return { ok: true, bootstrap: getBootstrap() };
    }
  }
  throw new Error('Session introuvable.');
}

function saveBook(p) {
  const ancien = normTitre_(p.titreOriginal || p.titre);
  const nouveau = normTitre_(p.titre);
  if (!nouveau) throw new Error('Titre manquant.');

  if (ancien && ancien !== nouveau) {
    // renomme les sessions de l'ancien titre — UN seul setValues
    const shS = sh_(CFG.T_SESSIONS);
    const lastS = shS.getLastRow();
    if (lastS > 1) {
      const col = shS.getRange(2, 3, lastS - 1, 1).getValues();
      let touched = false;
      for (let i = 0; i < col.length; i++) {
        if (normTitre_(col[i][0]) === ancien) { col[i][0] = nouveau; touched = true; }
      }
      if (touched) shS.getRange(2, 3, lastS - 1, 1).setValues(col);
    }
    // fiche livre : renommage simple, ou suppression de l'ancienne si la cible existe déjà
    const rowAncien = _findLivreRow(ancien);
    const rowNouveau = _findLivreRow(nouveau);
    if (rowAncien > 0 && rowNouveau < 0) {
      sh_(CFG.T_LIVRES).getRange(rowAncien, 1).setValue(nouveau);
    } else if (rowAncien > 0 && rowNouveau > 0 && rowAncien !== rowNouveau) {
      sh_(CFG.T_LIVRES).deleteRow(rowAncien);
    }
    _resetCaches_();
  }

  _upsertLivre(nouveau, {
    format: p.format, nature: p.nature, statut: p.statut, serie: p.serie || '',
    note: p.note || '', commentaire: p.commentaire || '',
    date_debut: p.date_debut || '', date_fin: p.date_fin || '', alias: p.alias || '',
  });
  if (p.definirChrono) _setFavori_(nouveau);

  _resetCaches_();
  return { ok: true, bootstrap: getBootstrap() };
}

function mergeBooks(sources, cible) {
  cible = normTitre_(cible);
  const set = {};
  (sources || []).forEach(s => { const t = normTitre_(s); if (t && t !== cible) set[t] = true; });
  if (!Object.keys(set).length) return { ok: true, bootstrap: getBootstrap() };

  // déplace les sessions vers la cible — UN seul setValues
  const shS = sh_(CFG.T_SESSIONS);
  const lastS = shS.getLastRow();
  if (lastS > 1) {
    const col = shS.getRange(2, 3, lastS - 1, 1).getValues();
    let touched = false;
    for (let i = 0; i < col.length; i++) {
      if (set[normTitre_(col[i][0])]) { col[i][0] = cible; touched = true; }
    }
    if (touched) shS.getRange(2, 3, lastS - 1, 1).setValues(col);
  }

  // supprime les fiches sources, récupère leurs alias
  const shL = sh_(CFG.T_LIVRES);
  const aSupprimer = [];
  let aliasCollectes = [];
  lire_(CFG.T_LIVRES).forEach(r => {
    if (set[normTitre_(r.titre)]) {
      if (r.alias) aliasCollectes = aliasCollectes.concat(String(r.alias).split('|'));
      aliasCollectes.push(normTitre_(r.titre));
      aSupprimer.push(r._row);
    }
  });
  aSupprimer.sort((a, b) => b - a).forEach(rn => shL.deleteRow(rn));
  _resetCaches_();

  // fusionne les alias sur la fiche cible (dédupliqués, cible exclue)
  const rc = _findLivreRow(cible);
  if (rc > 0 && aliasCollectes.length) {
    const cur = lire_(CFG.T_LIVRES).filter(r => r._row === rc)[0];
    const tous = String((cur && cur.alias) || '').split('|').concat(aliasCollectes)
      .map(s => normTitre_(s)).filter(Boolean);
    const uniq = tous.filter((v, i) => tous.indexOf(v) === i && v !== cible);
    shL.getRange(rc, 11).setValue(uniq.join(' | '));
  }

  _resetCaches_();
  return { ok: true, bootstrap: getBootstrap() };
}

function setLivreChrono(titre) {
  _setFavori_(titre);
  _resetCaches_();
  return { ok: true, bootstrap: getBootstrap() };
}

function saveReglages(patch) {
  const sh = sh_(CFG.T_REGLAGES);
  const vals = sh.getDataRange().getValues();          // [['cle','valeur'], ...]
  const idx = {};
  for (let i = 1; i < vals.length; i++) idx[String(vals[i][0])] = i;
  const ajouts = [];
  Object.keys(patch || {}).forEach(k => {
    const v = String(patch[k]);
    if (idx[k] != null) vals[idx[k]][1] = v;
    else ajouts.push([k, v]);
  });
  if (vals.length > 1) {
    sh.getRange(2, 1, vals.length - 1, 2).setValues(vals.slice(1).map(r => [r[0], r[1]]));
  }
  if (ajouts.length) sh.getRange(vals.length + 1, 1, ajouts.length, 2).setValues(ajouts);
  _resetCaches_();
  return { ok: true, bootstrap: getBootstrap() };
}

function setRunning(state) {
  ecrireReglage_('session_en_cours', state ? JSON.stringify(state) : '');
  return { ok: true };
}
function getRunning() {
  return safeParse_(reglages_().session_en_cours);
}

function creerLivre(p) {
  _upsertLivre(p.titre, {
    format: p.format, nature: p.nature, statut: p.statut || 'À lire', serie: p.serie || '',
  });
  _resetCaches_();
  return { ok: true, bootstrap: getBootstrap() };
}

/* Menu pratique dans la feuille (secondaire — l'app reste l'interface) */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('📚 Lecture')
    .addItem('1. Installer la base', 'setupBase')
    .addItem('2. Importer l\'historique', 'menuImport')
    .addItem('2b. Ré-importer (remplace tout)', 'menuImportForce')
    .addSeparator()
    .addItem('URL de l\'application', 'menuUrl')
    .addToUi();
}
function menuImport() {
  SpreadsheetApp.getUi().alert(importerHistorique(false).message);
}
function menuImportForce() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Remplacer tout le contenu de sessions et livres ?', ui.ButtonSet.YES_NO) === ui.Button.YES) {
    ui.alert(importerHistorique(true).message);
  }
}
function menuUrl() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(url || 'Déploie d\'abord l\'application (Déployer › Nouveau déploiement › Application web).');
}
