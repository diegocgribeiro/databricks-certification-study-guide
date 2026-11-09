/* Site de estudos — Certificações Databricks (HTML + CSS + JS puro, sem build).
 *
 * Resiliência:
 *  - Cada certificação é carregada sob demanda (data/<cert>.js); falha de rede mostra "tentar de novo"
 *  - Progresso separado por certificação no localStorage; JSON corrompido é preservado em backup, não apagado
 *  - Questões malformadas são ignoradas sem quebrar a página
 *  - Toda tela roda dentro de um "error boundary": um erro mostra aviso e não derruba o site
 *  - Service worker guarda os arquivos para uso offline (quando servido por http/https)
 */
(function () {
  "use strict";

  // ======================================================================
  // Utilidades
  // ======================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = MD.esc;
  const pct = x => (x == null || isNaN(x)) ? "—" : Math.round(x * 100) + "%";
  const now = () => Date.now();
  const DAY = 86400000;
  const INTERVALS = [0, 1, 3, 7, 16, 35];
  const TARGET = 0.7;
  const DIFF_PT = { easy: "Fácil", medium: "Média", hard: "Difícil" };
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const REPO_BLOB = "https://github.com/diegocgribeiro/databricks-certification-study-guide/blob/main/";
  const todayKey = (t) => { const d = new Date(t || now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function fmtDate(t) { return new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }); }
  function fmtDateTime(t) { return new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function fmtDur(ms) { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0"); }
  function toast(msg) { const t = $("#toast"); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800); }
  function barClass(acc) { return acc == null ? "" : acc >= TARGET ? "ok" : acc >= 0.5 ? "warn" : "bad"; }
  function pillClass(acc) { return acc == null ? "" : acc >= TARGET ? "ok" : acc >= 0.5 ? "warn" : "bad"; }
  function cleanTitle(t) { return String(t || "").replace(/\s*\*?\(2026 blueprint\)\*?/i, "").trim(); }
  const isBlueprint = q => /2026 blueprint/i.test(q.title || "");
  const letterTag = (x) => `<span class="notranslate" translate="no">${x}</span>`;

  // ======================================================================
  // Armazenamento seguro
  // ======================================================================
  const store = {
    ok: (() => { try { const k = "__t"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; } catch (e) { return false; } })(),
    get(key, fallback) {
      if (!this.ok) return fallback;
      let raw = null;
      try { raw = localStorage.getItem(key); } catch (e) { return fallback; }
      if (raw == null) return fallback;
      try { return JSON.parse(raw); }
      catch (e) {
        // Não descarta: guarda o conteúdo corrompido para recuperação manual
        try { localStorage.setItem(key + ":corrompido-" + todayKey(), raw); } catch (e2) { }
        console.warn("Estado corrompido em", key, "— backup salvo");
        return fallback;
      }
    },
    set(key, val) {
      if (!this.ok) return false;
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch (e) { if (!store._warned) { store._warned = true; toast("Não foi possível salvar o progresso (armazenamento cheio ou bloqueado). Exporte um backup."); } return false; }
    },
    del(key) { try { localStorage.removeItem(key); } catch (e) { } },
  };
  const STATE_VERSION = 2;
  const stateKey = c => `studysite-v${STATE_VERSION}:${c}`;
  const sessionKey = c => `studysite-session:${c}`;
  function blankState() { return { v: STATE_VERSION, q: {}, read: {}, exams: [], days: {}, created: now() }; }
  function sanitizeState(st) {
    const b = blankState();
    if (!st || typeof st !== "object") return b;
    const out = Object.assign(b, st);
    if (typeof out.q !== "object" || Array.isArray(out.q)) out.q = {};
    for (const [id, x] of Object.entries(out.q)) {
      if (!x || !Array.isArray(x.att)) { delete out.q[id]; continue; }
      x.att = x.att.filter(a => a && typeof a.t === "number" && typeof a.c === "string");
      x.box = Math.max(0, Math.min(5, +x.box || 0)); x.due = +x.due || 0;
    }
    if (!Array.isArray(out.exams)) out.exams = [];
    if (typeof out.read !== "object") out.read = {};
    if (typeof out.days !== "object") out.days = {};
    return out;
  }

  // ======================================================================
  // Catálogo e certificação ativa
  // ======================================================================
  const CATALOG = (window.CATALOG && Array.isArray(window.CATALOG.certs)) ? window.CATALOG : { version: "0", certs: [] };
  const CERTS = Object.fromEntries(CATALOG.certs.map(c => [c.id, c]));
  let CERT = null, META = null, QUESTIONS = [], Q = {}, LESSONS = [], LESSON = {}, BANKS = {}, DOMAINS = [], DOMAIN = {};
  let S = blankState();
  let session = null;
  const persist = () => CERT && store.set(stateKey(CERT), S);
  const persistSession = () => CERT && (session ? store.set(sessionKey(CERT), session) : store.del(sessionKey(CERT)));

  const loading = {};
  function loadCertData(id) {
    if (window.CERTDATA && window.CERTDATA[id]) return Promise.resolve(window.CERTDATA[id]);
    if (loading[id]) return loading[id];
    loading[id] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `data/${id}.js?v=${encodeURIComponent(CATALOG.version)}`;
      const timer = setTimeout(() => { s.remove(); reject(new Error("tempo esgotado")); }, 30000);
      s.onload = () => { clearTimeout(timer); window.CERTDATA && window.CERTDATA[id] ? resolve(window.CERTDATA[id]) : reject(new Error("arquivo inválido")); };
      s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error("falha de rede")); };
      document.head.appendChild(s);
    }).catch(e => { delete loading[id]; throw e; });
    return loading[id];
  }

  function activateCert(id, data) {
    CERT = id; META = data.meta;
    QUESTIONS = (data.questions || []).filter(q => q && q.id && q.choices && q.choices[q.answer]);
    Q = Object.fromEntries(QUESTIONS.map(q => [q.id, q]));
    LESSONS = data.lessons || []; LESSON = Object.fromEntries(LESSONS.map(l => [l.id, l]));
    BANKS = Object.fromEntries((META.banks || []).map(b => [b.id, b]));
    DOMAINS = (META.domains || []).filter(d => QUESTIONS.some(q => q.domain === d.id));
    DOMAIN = Object.fromEntries(DOMAINS.map(d => [d.id, d]));
    S = sanitizeState(store.get(stateKey(id), null));
    migrateLegacy(id);
    session = store.get(sessionKey(id), null);
    if (session && (!Array.isArray(session.ids) || !session.ids.every(x => Q[x]))) { session = null; persistSession(); }
    store.set("studysite-last-cert", id);
    document.documentElement.style.setProperty("--accent", META.color || "");
    $("#cert-select").value = id;
    $("#topbar-title").textContent = META.title;
    document.title = META.title + " · Estudos PT-BR";
    buildNav();
  }

  /** Traz o progresso do site antigo do DE Associate (mesmo domínio github.io) */
  function migrateLegacy(id) {
    if (id !== "data-engineer-associate" || Object.keys(S.q).length || S.migrated) return;
    const old = store.get("dea-ptbr-v1", null);
    if (old && old.q && Object.keys(old.q).length) {
      S = sanitizeState(Object.assign({}, old, { v: STATE_VERSION, migrated: now() }));
      persist(); setTimeout(() => toast("Progresso do site antigo do DE Associate importado ✅"), 600);
    }
  }

  // ======================================================================
  // Ordem embaralhada das alternativas
  // ======================================================================
  let activeOrders = {};
  function orderOf(q) {
    const keys = Object.keys(q.choices); const o = activeOrders[q.id];
    return o && o.length === keys.length && o.every(k => keys.includes(k)) ? o : keys;
  }
  function L(q, key) { const i = orderOf(q).indexOf(key); return i < 0 ? key : LETTERS[i]; }
  function makeOrders(ids) { const o = {}; ids.forEach(id => { if (Q[id]) o[id] = shuffle(Object.keys(Q[id].choices)); }); return o; }
  function remapLetters(q, text) {
    const keys = Object.keys(q.choices);
    if (!text || orderOf(q).every((k, i) => k === keys[i])) return text;
    return text
      .replace(/\b(Options?|options?|Choices?|choices?|Answers?|answers?) \(?([A-H])\)?(?!\w)/g, (m, w, k) => keys.includes(k) ? `${w} ${L(q, k)}` : m)
      .replace(/(^|[\s(])([A-H])( is| and| or|\))(?=\s)/g, (m, pre, k, post) => keys.includes(k) ? pre + L(q, k) + post : m);
  }

  // ======================================================================
  // Motor de aprendizado
  // ======================================================================
  const attempts = id => (S.q[id] && S.q[id].att) || [];
  const lastAttempt = id => { const a = attempts(id); return a[a.length - 1]; };
  const wrongCount = id => attempts(id).filter(a => !a.ok).length;
  function status(id) {
    const st = S.q[id];
    if (!st || !st.att.length) return "nova";
    if (!st.att[st.att.length - 1].ok) return "errada";
    return st.box >= 3 ? "dominada" : "aprendendo";
  }
  function mastery(id) { const l = lastAttempt(id); if (!l) return null; if (!l.ok) return 0; return l.conf === "chute" ? 0.5 : 1; }
  const isDue = (id, t) => !!(S.q[id] && S.q[id].att.length && S.q[id].due <= (t || now()));
  function ensureQ(id) { return S.q[id] || (S.q[id] = { att: [], box: 0, due: 0, flag: false, note: "" }); }

  function recordAttempt(id, chosen, conf, mode) {
    const q = Q[id]; if (!q) return null;
    const ok = chosen === q.answer;
    const st = ensureQ(id);
    st.att.push({ t: now(), c: chosen, ok, conf: conf || "certeza", m: mode });
    if (st.att.length > 30) st.att = st.att.slice(-30);
    if (ok && conf !== "chute") { st.box = Math.min((st.box || 0) + 1, 5); st.due = now() + INTERVALS[st.box] * DAY; }
    else if (ok) { st.box = Math.min(st.box || 0, 1) || 1; st.due = now() + DAY; }
    else { st.box = 0; st.due = now() + 10 * 60000; }
    const k = todayKey(); S.days[k] = S.days[k] || { n: 0, ok: 0 }; S.days[k].n++; if (ok) S.days[k].ok++;
    persist();
    return ok;
  }
  function streak() { let n = 0, t = now(); if (!S.days[todayKey(t)]) t -= DAY; while (S.days[todayKey(t)]) { n++; t -= DAY; } return n; }

  function statsFor(ids) {
    let answered = 0, sum = 0;
    for (const id of ids) { const m = mastery(id); if (m != null) { answered++; sum += m; } }
    return { total: ids.length, answered, acc: answered ? sum / answered : null, coverage: ids.length ? answered / ids.length : 0 };
  }
  const idsByDomain = d => QUESTIONS.filter(q => q.domain === d).map(q => q.id);
  const idsByLesson = l => QUESTIONS.filter(q => q.lesson === l || q.related === l).map(q => q.id);
  const domainStats = () => DOMAINS.map(d => Object.assign({ domain: d }, statsFor(idsByDomain(d.id))));
  function readiness() {
    let w = 0, s = 0, conf = 0;
    for (const x of domainStats()) {
      if (x.acc == null) continue;
      w += x.domain.weight; s += x.domain.weight * x.acc; conf += x.domain.weight * Math.min(1, x.answered / 10);
    }
    const totalW = DOMAINS.reduce((a, d) => a + d.weight, 0) || 1;
    return { estimate: w ? s / w : null, confidence: conf / totalW };
  }
  function weakDomains() {
    return domainStats().filter(x => x.answered >= 3 && x.acc < TARGET)
      .map(x => Object.assign(x, { impact: x.domain.weight * (TARGET - x.acc) })).sort((a, b) => b.impact - a.impact);
  }
  function weakLessons() {
    const map = {};
    for (const q of QUESTIONS) {
      const s = status(q.id); if (s === "nova" || !q.lesson) continue;
      const m = map[q.lesson] || (map[q.lesson] = { lesson: q.lesson, wrong: 0, answered: 0, sum: 0 });
      m.answered++; m.sum += mastery(q.id) || 0; if (s === "errada") m.wrong++;
    }
    return Object.values(map).map(m => Object.assign(m, { acc: m.sum / m.answered }))
      .filter(m => m.wrong >= 1 && m.acc < 0.75 && LESSON[m.lesson]).sort((a, b) => (b.wrong - a.wrong) || (a.acc - b.acc));
  }
  const dueIds = () => { const t = now(); return QUESTIONS.filter(q => isDue(q.id, t)).map(q => q.id); };
  const pendingErrorIds = () => QUESTIONS.filter(q => status(q.id) === "errada").map(q => q.id);
  const recoveredIds = () => QUESTIONS.filter(q => wrongCount(q.id) > 0 && status(q.id) !== "errada").map(q => q.id);

  function smartReviewIds(limit) {
    const t = now();
    const due = QUESTIONS.filter(q => isDue(q.id, t));
    const weakSet = new Set(weakDomains().map(w => w.domain.id));
    due.sort((a, b) => {
      const sa = status(a.id) === "errada" ? 0 : 1, sb = status(b.id) === "errada" ? 0 : 1; if (sa !== sb) return sa - sb;
      const wa = weakSet.has(a.domain) ? 0 : 1, wb = weakSet.has(b.domain) ? 0 : 1; if (wa !== wb) return wa - wb;
      return (S.q[a.id].box - S.q[b.id].box) || (S.q[a.id].due - S.q[b.id].due);
    });
    let ids = due.map(q => q.id);
    if (ids.length < limit && weakSet.size) ids = ids.concat(shuffle(QUESTIONS.filter(q => weakSet.has(q.domain) && !ids.includes(q.id) && status(q.id) !== "dominada")).map(q => q.id));
    return ids.slice(0, limit);
  }

  function diagnosticIds(n) {
    const pool = QUESTIONS.filter(q => q.bank === "praticas");
    const base = pool.length ? pool : QUESTIONS;
    const out = [];
    const tw = DOMAINS.reduce((a, d) => a + d.weight, 0) || 1;
    for (const d of DOMAINS) {
      const k = Math.max(1, Math.round(n * d.weight / tw));
      out.push(...shuffle(base.filter(q => q.domain === d.id).map(q => q.id)).slice(0, k));
    }
    if (out.length < n) out.push(...shuffle(base.filter(q => !out.includes(q.id)).map(q => q.id)).slice(0, n - out.length));
    return shuffle(out).slice(0, n);
  }
  function pickIds(f) {
    let pool = QUESTIONS;
    if (f.banks && f.banks.length) pool = pool.filter(q => f.banks.includes(q.bank));
    if (f.domains && f.domains.length) pool = pool.filter(q => f.domains.includes(q.domain));
    if (f.difficulties && f.difficulties.length) pool = pool.filter(q => f.difficulties.includes(q.difficulty));
    if (f.statuses && f.statuses.length) pool = pool.filter(q => f.statuses.includes(status(q.id)) || (f.statuses.includes("marcada") && S.q[q.id] && S.q[q.id].flag));
    const ids = shuffle(pool.map(q => q.id));
    return f.count ? ids.slice(0, f.count) : ids;
  }
  function examIds(kind) {
    if (BANKS[kind] && BANKS[kind].kind === "mock") return QUESTIONS.filter(q => q.bank === kind).map(q => q.id);
    const size = Math.min(META.examSize || 45, QUESTIONS.length);
    const tw = DOMAINS.reduce((a, d) => a + d.weight, 0) || 1;
    const out = [];
    for (const d of DOMAINS) {
      const k = Math.round(size * d.weight / tw); if (!k) continue;
      const pool = idsByDomain(d.id);
      out.push(...shuffle(pool.filter(id => status(id) !== "dominada")).concat(shuffle(pool.filter(id => status(id) === "dominada"))).slice(0, k));
    }
    if (out.length < size) out.push(...shuffle(QUESTIONS.filter(q => !out.includes(q.id)).map(q => q.id)).slice(0, size - out.length));
    return shuffle(out).slice(0, size);
  }

  function nextStep() {
    const due = dueIds().length, pend = pendingErrorIds().length, weak = weakDomains();
    const answered = QUESTIONS.filter(q => status(q.id) !== "nova").length;
    if (!answered) return { title: "Comece pelo diagnóstico", text: "Faça 20 questões variadas para o painel descobrir seus pontos fortes e fracos.", action: "Fazer diagnóstico (20)", go: () => startPractice({ ids: diagnosticIds(20), label: "Diagnóstico inicial" }) };
    if (due >= 5 || (due && pend)) return { title: `Você tem ${due} revisões para hoje`, text: "A revisão espaçada traz de volta as questões no momento certo — principalmente as que você errou.", action: "Fazer revisão agora", go: () => startPractice({ ids: smartReviewIds(25), mode: "revisao", label: "Revisão inteligente" }) };
    if (weak.length) {
      const w = weak[0]; const ls = weakLessons().filter(l => idsByDomain(w.domain.id).some(id => Q[id].lesson === l.lesson));
      return { title: `Ponto fraco: ${w.domain.name} (${pct(w.acc)})`, text: ls.length ? `Releia a aula “${LESSON[ls[0].lesson].title}” e depois pratique este domínio.` : "Reestude as aulas deste domínio e pratique novamente.", action: "Praticar este domínio", go: () => startPractice({ ids: pickIds({ domains: [w.domain.id], statuses: ["nova", "errada", "aprendendo"], count: 15 }), label: "Foco: " + w.domain.name }), secondary: ls.length ? { label: "Abrir a aula", href: href("aula", ls[0].lesson) } : null };
    }
    const cov = domainStats().filter(x => x.coverage < 0.9).sort((a, b) => b.domain.weight * (1 - b.coverage) - a.domain.weight * (1 - a.coverage));
    if (cov.length) return { title: `Avance em ${cov[0].domain.name}`, text: `Você viu ${pct(cov[0].coverage)} das questões deste domínio.`, action: "Praticar questões novas", go: () => startPractice({ ids: pickIds({ domains: [cov[0].domain.id], statuses: ["nova"], count: 15 }), label: "Novas: " + cov[0].domain.name }) };
    return { title: "Hora do simulado", text: `Teste-se em condições reais: ${META.examSize} questões em ${META.examMinutes} minutos.`, action: "Ir para simulados", go: () => { location.hash = href("simulados"); } };
  }

  // ======================================================================
  // Sessões
  // ======================================================================
  function startPractice(opts) {
    if (!opts.ids || !opts.ids.length) { toast("Nenhuma questão encontrada com esses filtros."); return; }
    session = { kind: "practice", mode: opts.mode || "pratica", label: opts.label || "Prática", ids: opts.ids, idx: 0, answers: {}, orders: makeOrders(opts.ids), started: now() };
    persistSession(); go("sessao");
  }
  function startExam(kind) {
    const ids = examIds(kind);
    if (!ids.length) { toast("Sem questões para este simulado."); return; }
    const label = BANKS[kind] ? BANKS[kind].label : "Simulado aleatório ponderado";
    session = { kind: "exam", bank: kind, label, ids, idx: 0, answers: {}, flags: {}, orders: makeOrders(ids), started: now(), limit: (META.examMinutes || 90) * 60000 };
    persistSession(); go("sessao");
  }

  // ======================================================================
  // Roteamento
  // ======================================================================
  const href = (view, arg) => `#/${CERT}/${view}${arg != null ? "/" + encodeURIComponent(arg) : ""}`;
  function go(view, arg) { const h = href(view, arg); if (location.hash === h) route(); else location.hash = h; }
  const main = () => $("#main");
  let timerHandle = null;

  function buildNav() {
    const items = [["painel", "📊", "Painel"], ["estudar", "📚", "Estudar"], ["praticar", "🎯", "Praticar"], ["revisao", "🔁", "Revisão inteligente", "badge-due"], ["erros", "📕", "Caderno de erros", "badge-errors"], ["simulados", "⏱️", "Simulados"], ["estatisticas", "📈", "Estatísticas"], ["config", "⚙️", "Dados e ajustes"]];
    $("#nav").innerHTML = `<a href="#/" data-route="inicio"><span>🏠</span> Todas as certificações</a>` + (CERT ? items.map(([r, i, t, b]) => `<a href="${href(r)}" data-route="${r}"><span>${i}</span> ${t}${b ? ` <em class="badge${b === "badge-errors" ? " danger" : ""}" id="${b}" hidden></em>` : ""}</a>`).join("") : "");
  }

  async function route() {
    clearInterval(timerHandle); timerHandle = null; activeOrders = {};
    $("#topbar-timer").hidden = true;
    $("#sidebar").classList.remove("open"); $("#menu-toggle").setAttribute("aria-expanded", "false");
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    const certId = parts[0];
    if (!certId || !CERTS[certId]) {
      if (CERT === null) buildNav();
      $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === "inicio"));
      return safeRender(viewHome);
    }
    if (certId !== CERT) {
      main().innerHTML = `<div class="empty"><div class="big">⏳</div>Carregando ${esc(CERTS[certId].title)}…</div>`;
      try { activateCert(certId, await loadCertData(certId)); }
      catch (e) {
        main().innerHTML = `<div class="card empty"><div class="big">📡</div><p>Não foi possível carregar <strong>${esc(CERTS[certId].title)}</strong> (${esc(e.message)}).</p><p class="small muted">Verifique sua conexão. Seu progresso está salvo e não foi afetado.</p><div class="btn-row" style="justify-content:center"><button class="btn" id="retry">Tentar de novo</button><a class="btn ghost" href="#/">Voltar</a></div></div>`;
        $("#retry").onclick = route; return;
      }
    }
    const view = parts[1] || "painel";
    const arg = decodeURIComponent(parts.slice(2).join("/"));
    const navKey = view === "aula" ? "estudar" : view === "resultado" ? "simulados" : view === "sessao" && session ? (session.kind === "exam" ? "simulados" : session.mode === "revisao" ? "revisao" : session.mode === "erros" ? "erros" : "praticar") : view;
    $$("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === navKey));
    const views = { painel: viewDashboard, estudar: viewStudy, aula: () => viewLesson(arg), praticar: viewPracticeSetup, revisao: viewReview, erros: viewErrors, simulados: viewExams, sessao: viewSession, resultado: () => viewExamResult(arg), estatisticas: viewStats, config: viewConfig };
    safeRender(views[view] || viewDashboard);
    updateBadges();
    if (view !== "aula") window.scrollTo(0, 0);
    main().focus({ preventScroll: true });
  }

  function safeRender(fn) {
    try { fn(); }
    catch (e) {
      console.error(e);
      main().innerHTML = `<div class="card empty"><div class="big">🛠️</div><p>Algo deu errado ao montar esta tela.</p><p class="small muted">${esc(e && e.message || e)}</p><p class="small muted">Seu progresso continua salvo.</p><div class="btn-row" style="justify-content:center"><a class="btn" href="${CERT ? href("painel") : "#/"}">Ir para o painel</a><button class="btn ghost" onclick="location.reload()">Recarregar</button></div></div>`;
    }
  }

  function updateBadges() {
    if (!CERT) return;
    const bd = $("#badge-due"), be = $("#badge-errors");
    const due = dueIds().length, err = pendingErrorIds().length;
    if (bd) { bd.hidden = !due; bd.textContent = due; }
    if (be) { be.hidden = !err; be.textContent = err; }
  }

  // ======================================================================
  // Telas
  // ======================================================================
  const kpi = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  const weightLabel = d => d.official ? `${d.weight}% da prova` : `${d.count} questões`;

  function viewHome() {
    const cards = CATALOG.certs.map(c => {
      const st = sanitizeState(store.get(stateKey(c.id), null));
      const seen = Object.values(st.q).filter(x => x.att.length).length;
      return `<a class="cert-card" href="#/${c.id}/painel" style="--c:${c.color}">
        <div class="cert-top"><span class="pill">${esc(c.level)}</span>${c.lang === "pt" ? `<span class="pill ok">🇧🇷 Conteúdo em PT-BR</span>` : `<span class="pill">Conteúdo em inglês</span>`}</div>
        <h2>${esc(c.title)}</h2>
        <div class="cert-stats"><span><strong>${c.questionCount}</strong> questões</span><span><strong>${c.lessonCount}</strong> aulas</span><span><strong>${c.banks.filter(b => b.kind === "mock").length}</strong> simulados</span></div>
        <div class="bar" title="Questões vistas"><i style="width:${Math.round(100 * seen / Math.max(1, c.questionCount))}%"></i></div>
        <small class="muted">${seen ? `${seen} de ${c.questionCount} questões vistas` : "Ainda não começou"}</small>
      </a>`;
    }).join("");
    main().innerHTML = `
      <div class="page-head"><div><h1>Certificações Databricks</h1><p>Escolha a certificação. Conteúdo em português quando disponível, questões em inglês (como na prova), com caderno de erros, pontos fracos, revisão espaçada e simulados.</p></div></div>
      ${CATALOG.certs.length ? `<div class="cert-grid">${cards}</div>` : `<div class="card empty">Nenhuma certificação encontrada. Rode <code>python study-site/build.py</code>.</div>`}
      <p class="small muted section">Seu progresso fica salvo no seu navegador, separado por certificação. Nada é enviado para servidores.</p>`;
  }

  function domainRows(ds) {
    return ds.map(x => `
      <div class="domain-row">
        <div class="name">${esc(x.domain.name)}<small>${weightLabel(x.domain)} · ${x.answered}/${x.total} vistas</small></div>
        <div class="bars">
          <div class="bar" title="Acerto: ${pct(x.acc)}"><i class="${barClass(x.acc)}" style="width:${Math.round((x.acc || 0) * 100)}%"></i><span class="target"></span></div>
          <div class="bar" style="height:5px;margin-top:5px" title="Cobertura: ${pct(x.coverage)}"><i style="width:${Math.round(x.coverage * 100)}%;opacity:.45"></i></div>
        </div>
        <div class="pct">${pct(x.acc)}</div>
      </div>`).join("") + `<p class="small muted" style="margin-bottom:0">Barra grossa = acerto (a linha marca a meta de 70%). Barra fina = quanto do banco você já viu.</p>`;
  }

  function examListItem(e) {
    const p = e.correct / e.total;
    return `<a class="list-item" href="${href("resultado", e.id)}"><div class="grow"><div class="title">${esc(e.label)}</div><small>${fmtDateTime(e.end)} · ${fmtDur(e.end - e.start)}</small></div><span class="pill ${p >= 0.8 ? "ok" : p >= TARGET ? "info" : "bad"}">${e.correct}/${e.total} · ${pct(p)}</span></a>`;
  }

  function viewDashboard() {
    const answered = QUESTIONS.filter(q => status(q.id) !== "nova").length;
    const mastered = QUESTIONS.filter(q => status(q.id) === "dominada").length;
    const r = readiness(), ns = nextStep(), weak = weakDomains(), wl = weakLessons().slice(0, 5);
    const modLessons = LESSONS.filter(l => l.group === "modulo" && !l.isIndex);
    const readCount = modLessons.filter(l => S.read[l.id]).length;
    main().innerHTML = `
      <div class="page-head"><div><h1>${esc(META.title)}</h1><p>Painel · ${META.questionCount} questões · ${META.lang === "pt" ? "conteúdo em PT-BR" : "conteúdo em inglês (use a tradução do navegador se quiser)"}</p></div></div>
      <div class="card next-step">
        <div class="small muted">Próximo passo recomendado</div>
        <div class="title">${esc(ns.title)}</div><p>${esc(ns.text)}</p>
        <div class="btn-row"><button class="btn" id="ns-go">${esc(ns.action)}</button>${ns.secondary ? `<a class="btn secondary" href="${ns.secondary.href}">${esc(ns.secondary.label)}</a>` : ""}</div>
      </div>
      <div class="grid kpis section">
        ${kpi("Estimativa de acerto", pct(r.estimate), r.estimate == null ? "responda questões para calcular" : r.confidence < 0.6 ? "baixa confiança: pratique mais domínios" : META.officialWeights ? "ponderada pelos pesos oficiais" : "ponderada pelos domínios")}
        ${kpi("Questões vistas", `${answered}<span class="muted" style="font-size:16px">/${QUESTIONS.length}</span>`, `${mastered} dominadas`)}
        ${kpi("Revisões para hoje", dueIds().length, "repetição espaçada")}
        ${kpi("Caderno de erros", pendingErrorIds().length, `${recoveredIds().length} já recuperadas`)}
        ${kpi("Aulas lidas", `${readCount}<span class="muted" style="font-size:16px">/${modLessons.length}</span>`, META.lang === "pt" ? "conteúdo em PT-BR" : "conteúdo em inglês")}
        ${kpi("Sequência", `${streak()} 🔥`, "dias seguidos estudando")}
      </div>
      <div class="grid cols-2 section">
        <div class="card"><h2>Desempenho por domínio</h2>${domainRows(domainStats())}</div>
        <div class="card"><h2>Pontos fracos</h2>
          ${weak.length ? `<div class="list">${weak.map(w => `<div class="list-item"><div class="grow"><div class="title">${esc(w.domain.name)}</div><small>Acerto ${pct(w.acc)} · ${weightLabel(w.domain)}</small></div><button class="btn small" data-pd="${esc(w.domain.id)}">Praticar</button></div>`).join("")}</div>`
            : `<div class="empty"><div class="big">🎯</div>${answered < 10 ? "Responda pelo menos 3 questões por domínio para identificar pontos fracos." : "Nenhum domínio abaixo de 70%. Continue revisando!"}</div>`}
          ${wl.length ? `<h3 style="margin-top:18px">Aulas para reestudar</h3><div class="list">${wl.map(l => `<a class="list-item" href="${href("aula", l.lesson)}"><div class="grow"><div class="title">${esc(LESSON[l.lesson].title)}</div><small>${l.wrong} erro(s) pendente(s) · acerto ${pct(l.acc)}</small></div><span>📖</span></a>`).join("")}</div>` : ""}
        </div>
      </div>
      <div class="section card"><h2>Últimos simulados</h2>${S.exams.length ? `<div class="list">${S.exams.slice(-3).reverse().map(examListItem).join("")}</div>` : `<div class="empty">Nenhum simulado ainda. <a href="${href("simulados")}">Fazer o primeiro</a>.</div>`}</div>`;
    $("#ns-go").onclick = ns.go;
    $$("[data-pd]").forEach(b => b.onclick = () => startPractice({ ids: pickIds({ domains: [b.dataset.pd], statuses: ["errada", "nova", "aprendendo"], count: 15 }), label: "Foco: " + DOMAIN[b.dataset.pd].name }));
  }

  // ---------- Estudar ----------
  function viewStudy() {
    const extras = LESSONS.filter(l => l.group === "geral" || l.group === "recursos");
    const folders = [...new Set(LESSONS.filter(l => l.group === "modulo").map(l => l.folder))].sort();
    main().innerHTML = `
      <div class="page-head"><div><h1>Estudar</h1><p>${META.lang === "pt" ? "Conteúdo completo em português." : "Conteúdo em inglês — use a tradução automática do navegador se preferir."} Leia na ordem e marque as aulas lidas.</p></div></div>
      <div class="grid cols-3">${extras.map(l => `<a class="list-item" href="${href("aula", l.id)}"><div class="grow"><div class="title">${esc(l.title)}</div><small>${l.id === "README" ? "Visão geral da prova" : "Recurso"}</small></div><span>${l.id === "README" ? "🧭" : "📎"}</span></a>`).join("")}</div>
      ${folders.map(f => {
        const ls = LESSONS.filter(l => l.folder === f && l.group === "modulo").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        const idx = ls.find(l => l.isIndex);
        const qids = [...new Set(ls.flatMap(l => idsByLesson(l.id)))]; const st = statsFor(qids);
        return `<div class="section card">
          <div class="page-head" style="margin-bottom:8px"><div><h2 style="margin:0">${esc(idx ? idx.title : f)}</h2><p>${qids.length} questões ligadas</p></div>
          <div class="inline-flex"><span class="pill ${pillClass(st.acc)}">Acerto ${pct(st.acc)}</span>${qids.length ? `<button class="btn small secondary" data-pf="${esc(f)}">Praticar módulo</button>` : ""}</div></div>
          <div class="list">${ls.map(l => { const q = idsByLesson(l.id), s = statsFor(q); return `<a class="list-item" href="${href("aula", l.id)}"><span>${S.read[l.id] ? "✅" : l.isIndex ? "🧭" : "📄"}</span><div class="grow"><div class="title">${esc(l.title)}</div><small>${l.isIndex ? "Visão geral do módulo" : `${q.length} questões relacionadas${s.answered ? " · acerto " + pct(s.acc) : ""}`}</small></div></a>`; }).join("")}</div></div>`;
      }).join("")}`;
    $$("[data-pf]").forEach(b => b.onclick = () => { const ids = [...new Set(LESSONS.filter(l => l.folder === b.dataset.pf).flatMap(l => idsByLesson(l.id)))]; startPractice({ ids: shuffle(ids).slice(0, 20), label: "Módulo: " + b.dataset.pf }); });
  }

  function resolveLessonLink(fromId, url) {
    if (/^(https?:|mailto:)/i.test(url)) return null;
    const [pathPart, anchor] = url.split("#");
    if (!pathPart) return null;
    const root = META.lessonRoot.split("/");
    const parts = root.concat(fromId.split("/").slice(0, -1));
    for (const seg of pathPart.split("/")) { if (seg === "." || seg === "") continue; if (seg === "..") parts.pop(); else parts.push(seg); }
    const full = parts.join("/");
    const rootStr = META.lessonRoot + "/";
    if (full.startsWith(rootStr)) {
      const id = full.slice(rootStr.length).replace(/\.md$/, "");
      if (LESSON[id]) return href("aula", id) + (anchor ? "?a=" + anchor : "");
      if (/(practice-questions|mock-exam)/.test(id)) return href("praticar");
    }
    if (/study-site\/index\.html$/.test(full)) return href("painel");
    return REPO_BLOB + full + (anchor ? "#" + anchor : "");
  }

  let mermaidLoading = null;
  function renderMermaid(root) {
    const blocks = $$("pre.mermaid", root); if (!blocks.length) return;
    const run = () => { try { const dark = getComputedStyle(document.documentElement).colorScheme === "dark"; window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" }); window.mermaid.run({ nodes: blocks }).catch(() => { }); } catch (e) { } };
    if (window.mermaid) return run();
    if (!navigator.onLine) return;
    mermaidLoading = mermaidLoading || new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    mermaidLoading.then(run).catch(() => { mermaidLoading = null; });
  }

  function viewLesson(argRaw) {
    const [id, anchorQ] = argRaw.split("?a=");
    const l = LESSON[id];
    if (!l) { main().innerHTML = `<div class="empty card"><div class="big">🤷</div>Aula não encontrada. <a href="${href("estudar")}">Voltar</a></div>`; return; }
    const html = MD.render(l.md, { resolveLink: u => resolveLessonLink(id, u) });
    const qids = idsByLesson(id); const st = statsFor(qids);
    const same = LESSONS.filter(x => x.folder === l.folder && l.group === "modulo" && x.group === "modulo").sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const pos = same.findIndex(x => x.id === id);
    const prev = pos > 0 ? same[pos - 1] : null, next = pos >= 0 && pos < same.length - 1 ? same[pos + 1] : null;
    const tmp = document.createElement("div"); tmp.innerHTML = html;
    main().innerHTML = `
      <div class="lesson-actions">
        <a class="btn ghost small" href="${href("estudar")}">← Estudar</a>
        ${META.lang === "pt" ? `<span class="pill ok">🇧🇷 PT-BR</span>` : `<span class="pill">EN</span>`}
        <span style="flex:1"></span>
        ${l.group === "modulo" ? `<button class="btn small ${S.read[id] ? "secondary" : ""}" id="mark-read">${S.read[id] ? "✅ Lida" : "Marcar como lida"}</button>` : ""}
        ${qids.length ? `<button class="btn small secondary" id="practice-lesson">🎯 Praticar ${qids.length} questões${st.answered ? " · " + pct(st.acc) : ""}</button>` : ""}
      </div>
      <div class="lesson-layout">
        <article class="prose" id="lesson-body">${html}</article>
        <nav class="toc" aria-label="Nesta página"><div class="small muted" style="margin-bottom:6px;font-weight:600">Nesta página</div>${$$("h2, h3", tmp).map(h => `<a class="${h.tagName === "H3" ? "lvl3" : ""}" href="javascript:void(0)" data-anchor="${h.id}">${esc(h.textContent)}</a>`).join("")}</nav>
      </div>
      <div class="lesson-foot">${prev ? `<a class="btn ghost" href="${href("aula", prev.id)}">← ${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a class="btn ghost" href="${href("aula", next.id)}">${esc(next.title)} →</a>` : ""}</div>`;
    renderMermaid($("#lesson-body"));
    $$("[data-anchor]").forEach(a => a.onclick = ev => { ev.preventDefault(); const t = document.getElementById(a.dataset.anchor); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); });
    const mr = $("#mark-read"); if (mr) mr.onclick = () => { if (S.read[id]) delete S.read[id]; else S.read[id] = now(); persist(); viewLesson(argRaw); toast(S.read[id] ? "Aula marcada como lida" : "Marcação removida"); };
    const pl = $("#practice-lesson"); if (pl) pl.onclick = () => startPractice({ ids: shuffle(qids), label: "Aula: " + l.title });
    if (anchorQ) { const t = document.getElementById(anchorQ); if (t) setTimeout(() => t.scrollIntoView({ block: "start" }), 50); } else window.scrollTo(0, 0);
  }

  // ---------- Praticar ----------
  const chip = (name, value, label, checked, type) => `<label class="chip"><input type="${type || "checkbox"}" name="${name}" value="${esc(value)}" ${checked ? "checked" : ""}><span>${label}</span></label>`;
  function viewPracticeSetup() {
    const fk = "studysite-filters:" + CERT; const last = store.get(fk, {});
    const has = (k, v, def) => last[k] ? last[k].includes(v) : def;
    main().innerHTML = `
      <div class="page-head"><div><h1>Praticar</h1><p>Sessão com correção imediata e explicação. Questões em inglês, como na prova; as alternativas são embaralhadas a cada vez.</p></div></div>
      <div class="grid cols-3">
        <button class="card list-item" id="quick-diag" style="cursor:pointer;text-align:left"><div class="grow"><div class="title">🧪 Diagnóstico (20)</div><small>Mistura proporcional aos domínios</small></div></button>
        <button class="card list-item" id="quick-new" style="cursor:pointer;text-align:left"><div class="grow"><div class="title">✨ 15 questões novas</div><small>Só questões que você nunca viu</small></div></button>
        <button class="card list-item" id="quick-weak" style="cursor:pointer;text-align:left"><div class="grow"><div class="title">🎯 Foco nos pontos fracos</div><small>Domínios abaixo de 70%</small></div></button>
      </div>
      <form class="card section" id="practice-form">
        <h2>Sessão personalizada</h2>
        <fieldset><legend>Banco</legend><div class="chips">${META.banks.map(b => chip("bank", b.id, `${esc(b.label)} <span class="muted">(${b.count})</span>`, has("bank", b.id, b.kind === "practice"))).join("")}</div></fieldset>
        <fieldset><legend>Domínios</legend><div class="chips">${DOMAINS.map(d => chip("domain", d.id, `${esc(d.name)} <span class="muted">${d.official ? d.weight + "%" : d.count}</span>`, has("domain", d.id, true))).join("")}</div></fieldset>
        <fieldset><legend>Situação</legend><div class="chips">${[["nova", "Nunca vistas"], ["errada", "Errei por último"], ["aprendendo", "Aprendendo"], ["dominada", "Dominadas"], ["marcada", "⭐ Marcadas"]].map(([v, t]) => chip("status", v, t, has("status", v, v !== "dominada" && v !== "marcada"))).join("")}</div></fieldset>
        <fieldset><legend>Dificuldade</legend><div class="chips">${["easy", "medium", "hard"].map(v => chip("diff", v, DIFF_PT[v], has("diff", v, true))).join("")}</div></fieldset>
        <div class="btn-row"><label>Quantidade <select name="count">${[10, 15, 20, 30, 45, 0].map(n => `<option value="${n}" ${String(last.count || 15) === String(n) ? "selected" : ""}>${n || "Todas"}</option>`).join("")}</select></label><span class="muted small" id="pool-count"></span><span style="flex:1"></span><button class="btn" type="submit">Começar</button></div>
      </form>`;
    const form = $("#practice-form");
    const read = () => ({ banks: $$('input[name="bank"]:checked', form).map(i => i.value), domains: $$('input[name="domain"]:checked', form).map(i => i.value), statuses: $$('input[name="status"]:checked', form).map(i => i.value), difficulties: $$('input[name="diff"]:checked', form).map(i => i.value), count: +form.count.value });
    const upd = () => { $("#pool-count").textContent = `${pickIds(Object.assign({}, read(), { count: 0 })).length} questões disponíveis`; };
    form.addEventListener("change", upd); upd();
    form.onsubmit = e => { e.preventDefault(); const f = read(); store.set(fk, { bank: f.banks, domain: f.domains, status: f.statuses, diff: f.difficulties, count: f.count }); startPractice({ ids: pickIds(f), label: "Prática personalizada" }); };
    $("#quick-diag").onclick = () => startPractice({ ids: diagnosticIds(20), label: "Diagnóstico" });
    $("#quick-new").onclick = () => startPractice({ ids: pickIds({ statuses: ["nova"], count: 15 }), label: "Questões novas" });
    $("#quick-weak").onclick = () => { const w = weakDomains().map(x => x.domain.id); if (!w.length) { toast("Ainda não há pontos fracos identificados — faça o diagnóstico."); return; } startPractice({ ids: pickIds({ domains: w, statuses: ["nova", "errada", "aprendendo"], count: 20 }), label: "Pontos fracos" }); };
  }

  // ---------- Revisão ----------
  function viewReview() {
    const due = dueIds(), errs = due.filter(id => status(id) === "errada").length;
    const upcoming = QUESTIONS.filter(q => S.q[q.id] && S.q[q.id].att.length && !isDue(q.id)).map(q => S.q[q.id].due).sort((a, b) => a - b);
    const boxes = [0, 1, 2, 3, 4, 5].map(b => QUESTIONS.filter(q => S.q[q.id] && S.q[q.id].att.length && S.q[q.id].box === b).length);
    main().innerHTML = `
      <div class="page-head"><div><h1>Revisão inteligente</h1><p>Repetição espaçada: cada acerto com certeza empurra a questão para mais longe (1, 3, 7, 16, 35 dias). Errou? Ela volta hoje. Acertou no chute? Volta amanhã.</p></div></div>
      <div class="grid kpis">${kpi("Para revisar agora", due.length, errs ? `${errs} erradas` : "")}${kpi("Próxima revisão", upcoming.length ? fmtDateTime(upcoming[0]) : "—", "")}${kpi("Dominadas (caixa 3+)", boxes[3] + boxes[4] + boxes[5], "")}</div>
      <div class="card section"><h2>Fila de revisão</h2>${due.length ? `<p>Prioridade: questões erradas → domínios fracos → caixas mais baixas.</p><div class="btn-row"><button class="btn" id="rev-go">Revisar ${Math.min(due.length, 25)} agora</button>${due.length > 25 ? `<button class="btn secondary" id="rev-all">Revisar todas (${due.length})</button>` : ""}</div>` : `<div class="empty"><div class="big">🌿</div>Nada para revisar agora.${weakDomains().length ? `<br><button class="btn secondary" id="rev-weak" style="margin-top:12px">Praticar pontos fracos mesmo assim</button>` : ""}</div>`}</div>
      <div class="card section"><h2>Caixas da repetição espaçada</h2>${boxes.map((n, b) => `<div class="domain-row"><div class="name">Caixa ${b}<small>${b === 0 ? "errada / reaprender" : `revisa em ${INTERVALS[b]} dia(s)`}</small></div><div class="bars"><div class="bar"><i class="${b === 0 ? "bad" : b >= 3 ? "ok" : "warn"}" style="width:${Math.round(100 * n / Math.max(1, ...boxes))}%"></i></div></div><div class="pct">${n}</div></div>`).join("")}</div>`;
    const a = $("#rev-go"); if (a) a.onclick = () => startPractice({ ids: smartReviewIds(25), mode: "revisao", label: "Revisão inteligente" });
    const b = $("#rev-all"); if (b) b.onclick = () => startPractice({ ids: smartReviewIds(9999), mode: "revisao", label: "Revisão completa" });
    const c = $("#rev-weak"); if (c) c.onclick = () => startPractice({ ids: smartReviewIds(20), mode: "revisao", label: "Revisão: pontos fracos" });
  }

  // ---------- Caderno de erros ----------
  let errorsTab = "pendentes";
  function viewErrors() {
    const pend = pendingErrorIds().sort((a, b) => wrongCount(b) - wrongCount(a));
    const rec = recoveredIds().sort((a, b) => wrongCount(b) - wrongCount(a));
    const list = errorsTab === "pendentes" ? pend : rec;
    const byD = {}; for (const id of pend) byD[Q[id].domain] = (byD[Q[id].domain] || 0) + 1;
    main().innerHTML = `
      <div class="page-head"><div><h1>Caderno de erros</h1><p>Toda questão errada fica aqui com a explicação até você acertar.</p></div><div class="btn-row">${pend.length ? `<button class="btn" id="err-retry">Refazer pendentes (${pend.length})</button>` : ""}</div></div>
      ${pend.length ? `<div class="card"><h3>Erros pendentes por domínio</h3><div class="chips">${Object.entries(byD).sort((a, b) => b[1] - a[1]).map(([d, n]) => `<button class="btn small ghost" data-ed="${esc(d)}">${esc(DOMAIN[d] ? DOMAIN[d].name : d)} · ${n}</button>`).join("")}</div></div>` : ""}
      <div class="section"><div class="tabs"><button data-tab="pendentes" class="${errorsTab === "pendentes" ? "active" : ""}">Pendentes (${pend.length})</button><button data-tab="recuperadas" class="${errorsTab === "recuperadas" ? "active" : ""}">Recuperadas (${rec.length})</button></div>
      ${list.length ? list.slice(0, 200).map(id => reviewItem(id, null, true)).join("") : `<div class="empty card"><div class="big">${errorsTab === "pendentes" ? "🎉" : "📭"}</div>${errorsTab === "pendentes" ? "Nenhum erro pendente." : "Nenhuma questão recuperada ainda."}</div>`}</div>`;
    $$("[data-tab]").forEach(b => b.onclick = () => { errorsTab = b.dataset.tab; viewErrors(); });
    const rt = $("#err-retry"); if (rt) rt.onclick = () => startPractice({ ids: shuffle(pend), mode: "erros", label: "Caderno de erros" });
    $$("[data-ed]").forEach(b => b.onclick = () => startPractice({ ids: shuffle(pend.filter(id => Q[id].domain === b.dataset.ed)), mode: "erros", label: "Erros: " + (DOMAIN[b.dataset.ed] || {}).name }));
    bindReviewItems();
  }

  function domainShort(id) { return DOMAIN[id] ? DOMAIN[id].name : id; }
  function reviewItem(id, chosen, showHistory) {
    const q = Q[id]; if (!q) return "";
    const att = attempts(id), wc = wrongCount(id);
    const lastWrong = [...att].reverse().find(a => !a.ok);
    const ch = chosen != null ? chosen : (lastWrong ? lastWrong.c : null);
    const ok = chosen != null ? chosen === q.answer : status(id) !== "errada";
    return `<details class="review" data-qid="${esc(id)}"><summary><span class="pill ${ok ? "ok" : "bad"}">${ok ? "✔" : "✘"}</span><span class="grow" style="flex:1;min-width:0"><strong>${esc(cleanTitle(q.title))}</strong><br><small class="muted">${esc(domainShort(q.domain))}${showHistory && wc ? ` · errou ${wc}x` : ""}</small></span>${S.q[id] && S.q[id].flag ? "⭐" : ""}</summary><div class="body" data-lazy="${esc(id)}" data-ch="${esc(ch || "")}"></div></details>`;
  }
  function questionReviewBody(q, chosen) {
    return `<div class="q-text">${MD.render(q.question)}</div><div class="choices">${orderOf(q).map((k, i) => `<div class="choice ${k === q.answer ? "correct" : k === chosen ? "wrong" : ""}" style="cursor:default"><span class="letter notranslate" translate="no">${LETTERS[i]}</span><span class="ctext">${MD.inline(q.choices[k])}</span></div>`).join("")}</div>${explainBlock(q, chosen)}`;
  }
  function translateUrl(q) {
    const text = [q.question, ...orderOf(q).map((k, i) => `${LETTERS[i]}) ${q.choices[k]}`), "", "Answer: " + L(q, q.answer), remapLetters(q, q.short), remapLetters(q, q.explanation)].join("\n");
    return "https://translate.google.com/?sl=en&tl=pt&op=translate&text=" + encodeURIComponent(text.slice(0, 4800));
  }
  function explainBlock(q, chosen) {
    const lesson = q.lesson && LESSON[q.lesson], related = q.related && LESSON[q.related];
    const att = attempts(q.id), wc = att.filter(a => !a.ok).length;
    const picks = att.filter(a => !a.ok).map(a => a.c);
    const common = picks.length ? Object.entries(picks.reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0] : null;
    const note = (S.q[q.id] && S.q[q.id].note) || "";
    return `<div class="feedback ${chosen == null || chosen === "" ? "" : chosen === q.answer ? "ok" : "bad"}">
      <div class="verdict">Resposta correta: ${letterTag(L(q, q.answer))}</div>
      <div class="explain">${MD.render(remapLetters(q, q.short || ""))}${q.explanation ? MD.render(remapLetters(q, q.explanation)) : ""}</div>
      ${att.length ? `<div class="history-line">Histórico: ${att.length} tentativa(s), ${wc} erro(s)${common && q.choices[common[0]] ? ` · alternativa errada que você mais escolhe: <strong>“${MD.inline(q.choices[common[0]])}”</strong>` : ""}.</div>` : ""}
      <div class="btn-row" style="margin-top:12px">
        ${lesson ? `<a class="btn small secondary" href="${href("aula", lesson.id)}">📖 Estudar: ${esc(lesson.title)}</a>` : ""}
        ${related ? `<a class="btn small ghost" href="${href("aula", related.id)}">📖 Ver também: ${esc(related.title)}</a>` : ""}
        <a class="btn small ghost" href="${translateUrl(q)}" target="_blank" rel="noopener">🌐 Traduzir no Google</a>
        <button class="btn small ghost" type="button" data-flag="${esc(q.id)}">${S.q[q.id] && S.q[q.id].flag ? "⭐ Marcada" : "☆ Marcar"}</button>
      </div>
      <div class="note-box"><label class="small muted" for="note-${esc(q.id)}">Minha anotação (fica salva):</label><textarea id="note-${esc(q.id)}" data-note="${esc(q.id)}" placeholder="Ex.: o que me confundiu nesta questão…">${esc(note)}</textarea></div>
    </div>`;
  }
  function bindReviewItems(root) {
    // Corpo das questões só é montado quando o item é aberto (listas grandes ficam leves)
    $$("details.review", root).forEach(d => d.addEventListener("toggle", () => {
      const body = $(".body[data-lazy]", d); if (!d.open || !body || body.dataset.done) return;
      const q = Q[body.dataset.lazy]; if (!q) return;
      try { body.innerHTML = questionReviewBody(q, body.dataset.ch || null); body.dataset.done = "1"; bindActions(body); }
      catch (e) { body.innerHTML = `<p class="muted">Não foi possível exibir esta questão.</p>`; }
    }));
    bindActions(root);
  }
  function bindActions(root) {
    $$("[data-flag]", root).forEach(b => b.onclick = () => { const st = ensureQ(b.dataset.flag); st.flag = !st.flag; persist(); b.textContent = st.flag ? "⭐ Marcada" : "☆ Marcar"; toast(st.flag ? "Questão marcada para revisar" : "Marcação removida"); });
    $$("[data-note]", root).forEach(t => t.oninput = () => { ensureQ(t.dataset.note).note = t.value; persist(); });
  }

  // ---------- Sessão ----------
  let pendingChoice = null, pendingConf = "certeza";
  function viewSession() {
    if (!session) { main().innerHTML = `<div class="empty card"><div class="big">🎯</div>Nenhuma sessão em andamento. <a href="${href("praticar")}">Começar uma prática</a> ou <a href="${href("simulados")}">um simulado</a>.</div>`; return; }
    if (!session.orders) { session.orders = makeOrders(session.ids); persistSession(); }
    activeOrders = session.orders;
    if (session.kind === "exam") return renderExamQuestion();
    if (session.idx >= session.ids.length) return renderPracticeSummary();
    renderPracticeQuestion();
  }
  function sessionHeader(extra) {
    return `<div class="quiz-head"><div><div class="small muted">${esc(session.label)}</div><strong>Questão ${session.idx + 1} de ${session.ids.length}</strong> <span class="muted small">· ${Object.keys(session.answers).length} respondidas</span></div><div class="btn-row">${extra || ""}<button class="btn ghost small" id="quit">Encerrar</button></div></div>`;
  }
  function dots(kind) {
    return `<div class="progress-dots">${session.ids.map((id, i) => { const a = session.answers[id]; let c = ""; if (a) c = kind === "exam" ? "answered" : (a.ok ? "ok" : "bad"); if (kind === "exam" && session.flags[id]) c += " flagged"; if (i === session.idx) c += " current"; return `<button type="button" class="${c}" data-go="${i}" aria-label="Questão ${i + 1}">${i + 1}</button>`; }).join("")}</div>`;
  }
  function choicesHtml(q, chosen, revealed) {
    return `<div class="choices" role="radiogroup">${orderOf(q).map((k, i) => { let c = ""; if (revealed) { if (k === q.answer) c = "correct"; else if (k === chosen) c = "wrong"; } else if (k === chosen) c = "selected"; return `<button type="button" class="choice ${c}" data-choice="${esc(k)}" role="radio" aria-checked="${k === chosen}" ${revealed ? "disabled" : ""}><span class="letter notranslate" translate="no">${LETTERS[i]}</span><span class="ctext">${MD.inline(q.choices[k])}</span></button>`; }).join("")}</div>`;
  }
  function qMeta(q) {
    const st = status(q.id), wc = wrongCount(q.id);
    return `<div class="q-meta"><span class="pill accent">${esc(domainShort(q.domain))}</span><span class="pill">${DIFF_PT[q.difficulty] || q.difficulty}</span><span class="pill">${esc(BANKS[q.bank] ? BANKS[q.bank].label : q.bank)} #${q.n}</span>${isBlueprint(q) ? `<span class="pill accent">Blueprint 2026</span>` : ""}${st === "nova" ? `<span class="pill info">Nova</span>` : st === "errada" ? `<span class="pill bad">Você errou da última vez${wc > 1 ? ` (${wc}x)` : ""}</span>` : st === "dominada" ? `<span class="pill ok">Dominada</span>` : `<span class="pill warn">Aprendendo</span>`}</div>`;
  }
  function renderPracticeQuestion() {
    const id = session.ids[session.idx], q = Q[id], ans = session.answers[id];
    if (!ans) { pendingChoice = null; pendingConf = "certeza"; }
    main().innerHTML = `${sessionHeader()}${dots("practice")}
      <div class="card question-card">${qMeta(q)}
        <h2 style="margin:4px 0 12px;font-size:1.05rem">${esc(cleanTitle(q.title))}</h2>
        <div class="q-text">${MD.render(q.question)}</div>
        ${choicesHtml(q, ans ? ans.c : pendingChoice, !!ans)}
        ${ans ? "" : `<div class="confidence"><span class="small muted">Sua confiança:</span>${chip("conf", "certeza", "😎 Tenho certeza", true, "radio")}${chip("conf", "chute", "🤔 Estou chutando", false, "radio")}<span class="small muted">— acertos no chute voltam para revisão</span></div>`}
        <div id="fb">${ans ? feedbackHtml(q, ans) : ""}</div>
        <div class="quiz-actions"><div class="btn-row">${session.idx > 0 ? `<button class="btn ghost" id="prev">← Anterior</button>` : ""}<a class="btn ghost small" href="${translateUrl(q)}" target="_blank" rel="noopener">🌐 Traduzir</a></div>
          <div class="btn-row"><span class="small muted"><span class="kbd">1-${Object.keys(q.choices).length}</span> escolher · <span class="kbd">Enter</span> ${ans ? "próxima" : "responder"}</span>${ans ? `<button class="btn" id="next">${session.idx + 1 < session.ids.length ? "Próxima →" : "Ver resultado"}</button>` : `<button class="btn" id="submit" disabled>Responder</button>`}</div></div>
      </div>`;
    $("#quit").onclick = () => { if (Object.keys(session.answers).length) { session.idx = session.ids.length; persistSession(); viewSession(); } else { session = null; persistSession(); go("praticar"); } };
    $$("[data-go]").forEach(b => b.onclick = () => { session.idx = +b.dataset.go; persistSession(); viewSession(); });
    $$("[data-choice]").forEach(b => b.onclick = () => { pendingChoice = b.dataset.choice; $$("[data-choice]").forEach(x => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", x === b); }); const s = $("#submit"); if (s) s.disabled = false; });
    $$('input[name="conf"]').forEach(i => i.onchange = () => { pendingConf = i.value; });
    const sub = $("#submit"); if (sub) sub.onclick = () => {
      if (!pendingChoice || session.answers[id]) return;
      const ok = recordAttempt(id, pendingChoice, pendingConf, session.mode);
      session.answers[id] = { c: pendingChoice, ok, conf: pendingConf }; persistSession(); updateBadges();
      renderPracticeQuestion(); const fb = $("#fb"); if (fb) fb.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    const nx = $("#next"); if (nx) nx.onclick = () => { session.idx++; persistSession(); viewSession(); };
    const pv = $("#prev"); if (pv) pv.onclick = () => { session.idx--; persistSession(); viewSession(); };
    bindActions(main());
  }
  function feedbackHtml(q, ans) {
    return `<div class="feedback ${ans.ok ? "ok" : "bad"}"><div class="verdict">${ans.ok ? (ans.conf === "chute" ? "✔ Acertou — mas foi no chute, vai voltar amanhã" : "✔ Correto!") : `✘ Incorreto — você marcou ${letterTag(L(q, ans.c))}, a correta é ${letterTag(L(q, q.answer))}`}</div></div><div style="margin-top:10px">${explainBlock(q, null)}</div>`;
  }
  function byDomainRows(byD) {
    return Object.entries(byD).map(([d, v]) => { const a = v.ok / v.n; return `<div class="domain-row"><div class="name">${esc(domainShort(d))}<small>${v.ok}/${v.n}</small></div><div class="bars"><div class="bar"><i class="${barClass(a)}" style="width:${Math.round(a * 100)}%"></i><span class="target"></span></div></div><div class="pct">${pct(a)}</div></div>`; }).join("");
  }
  function studyPlan(wrong) {
    const ls = {}; for (const id of wrong) { const l = Q[id].lesson; if (l && LESSON[l]) ls[l] = (ls[l] || 0) + 1; }
    const e = Object.entries(ls).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return e.length ? `<div class="list">${e.map(([l, n]) => `<a class="list-item" href="${href("aula", l)}"><div class="grow"><div class="title">${esc(LESSON[l].title)}</div><small>${n} erro(s)</small></div><span>📖</span></a>`).join("")}</div>` : `<div class="empty"><div class="big">🏆</div>Sem erros!</div>`;
  }
  function renderPracticeSummary() {
    const ids = session.ids.filter(id => session.answers[id]);
    const ok = ids.filter(id => session.answers[id].ok).length;
    const guesses = ids.filter(id => session.answers[id].ok && session.answers[id].conf === "chute").length;
    const wrong = ids.filter(id => !session.answers[id].ok);
    const byD = {}; for (const id of ids) { const d = Q[id].domain; byD[d] = byD[d] || { ok: 0, n: 0 }; byD[d].n++; if (session.answers[id].ok) byD[d].ok++; }
    main().innerHTML = `
      <div class="page-head"><div><h1>Resultado da sessão</h1><p>${esc(session.label)}</p></div><div class="btn-row"><a class="btn ghost" href="${href("painel")}">Painel</a></div></div>
      <div class="grid kpis">${kpi("Acerto", pct(ids.length ? ok / ids.length : 0), `${ok} de ${ids.length}`)}${kpi("Erros", wrong.length, "foram para o caderno de erros")}${kpi("Acertos no chute", guesses, "voltam amanhã")}</div>
      <div class="grid cols-2 section"><div class="card"><h2>Por domínio</h2>${byDomainRows(byD) || "<p class='muted'>Nenhuma resposta.</p>"}</div><div class="card"><h2>O que estudar agora</h2>${studyPlan(wrong)}</div></div>
      <div class="btn-row section">${wrong.length ? `<button class="btn" id="retry-wrong">🔁 Tentar de novo as ${wrong.length} erradas</button>` : ""}<a class="btn secondary" href="${href("praticar")}">Nova sessão</a><a class="btn ghost" href="${href("revisao")}">Revisão inteligente</a></div>
      ${wrong.length ? `<div class="section"><h2>Revise seus erros</h2>${wrong.map(id => reviewItem(id, session.answers[id].c)).join("")}</div>` : ""}`;
    const rw = $("#retry-wrong"); if (rw) rw.onclick = () => startPractice({ ids: shuffle(wrong), mode: "erros", label: "Refazendo erros da sessão" });
    bindReviewItems();
  }

  // ---------- Simulado ----------
  function renderExamQuestion() {
    const remaining = session.started + session.limit - now();
    if (remaining <= 0) return finishExam(true);
    const id = session.ids[session.idx], q = Q[id], a = session.answers[id];
    main().innerHTML = `${sessionHeader(`<span class="timer" id="timer">${fmtDur(remaining)}</span><button class="btn small" id="finish">Entregar</button>`)}${dots("exam")}
      <div class="card question-card"><div class="q-meta"><span class="pill">${DIFF_PT[q.difficulty] || ""}</span>${session.flags[id] ? `<span class="pill warn">⚑ Marcada para revisar</span>` : ""}</div>
        <div class="q-text">${MD.render(q.question)}</div>${choicesHtml(q, a ? a.c : null, false)}
        <div class="quiz-actions"><div class="btn-row"><button class="btn ghost" id="prev" ${session.idx ? "" : "disabled"}>← Anterior</button><button class="btn ghost" id="flag">${session.flags[id] ? "⚑ Desmarcar" : "⚐ Marcar para revisar"}</button></div>
          <div class="btn-row"><span class="small muted"><span class="kbd">1-${Object.keys(q.choices).length}</span> escolher · <span class="kbd">Enter</span> próxima · <span class="kbd">F</span> marcar</span><button class="btn" id="next">${session.idx + 1 < session.ids.length ? "Próxima →" : "Revisar e entregar"}</button></div></div>
      </div><p class="small muted">Sem correção imediata — igual à prova. O resultado aparece quando você entregar (ou quando o tempo acabar).</p>`;
    const tick = () => { const r = session.started + session.limit - now(); const t = $("#timer"), tt = $("#topbar-timer"); if (r <= 0) { clearInterval(timerHandle); finishExam(true); return; } if (t) { t.textContent = fmtDur(r); t.classList.toggle("low", r < 10 * 60000); } tt.hidden = false; tt.textContent = "⏱ " + fmtDur(r); };
    tick(); timerHandle = setInterval(tick, 1000);
    $("#quit").onclick = () => { if (confirm("Abandonar o simulado? As respostas não serão contabilizadas.")) { session = null; persistSession(); go("simulados"); } };
    $("#finish").onclick = confirmFinish;
    $$("[data-go]").forEach(b => b.onclick = () => { session.idx = +b.dataset.go; persistSession(); renderExamQuestion(); });
    $$("[data-choice]").forEach(b => b.onclick = () => { session.answers[id] = { c: b.dataset.choice }; persistSession(); $$("[data-choice]").forEach(x => { x.classList.toggle("selected", x === b); x.setAttribute("aria-checked", x === b); }); const dot = $(`[data-go="${session.idx}"]`); if (dot) dot.classList.add("answered"); });
    $("#prev").onclick = () => { if (session.idx) { session.idx--; persistSession(); renderExamQuestion(); } };
    $("#next").onclick = () => { if (session.idx + 1 < session.ids.length) { session.idx++; persistSession(); renderExamQuestion(); } else confirmFinish(); };
    $("#flag").onclick = () => { session.flags[id] = !session.flags[id]; persistSession(); renderExamQuestion(); };
  }
  function confirmFinish() {
    const blank = session.ids.filter(id => !session.answers[id]).length, flagged = Object.values(session.flags).filter(Boolean).length;
    if (confirm(`Entregar o simulado?\n\n${blank ? `⚠ ${blank} em branco.\n` : ""}${flagged ? `⚑ ${flagged} marcada(s).\n` : ""}`)) finishExam(false);
  }
  function finishExam(timeout) {
    clearInterval(timerHandle);
    const end = Math.min(now(), session.started + session.limit);
    const byDomain = {}, answers = {}; let correct = 0;
    for (const id of session.ids) {
      const a = session.answers[id], q = Q[id], ok = !!a && a.c === q.answer;
      if (a) recordAttempt(id, a.c, session.flags[id] ? "chute" : "certeza", "simulado");
      if (ok) correct++; answers[id] = a ? a.c : null;
      byDomain[q.domain] = byDomain[q.domain] || { ok: 0, n: 0 }; byDomain[q.domain].n++; if (ok) byDomain[q.domain].ok++;
    }
    const rec = { id: "e" + now().toString(36), bank: session.bank, label: session.label, start: session.started, end, total: session.ids.length, correct, byDomain, answers, flags: session.flags, orders: session.orders, timeout };
    S.exams.push(rec); if (S.exams.length > 60) S.exams = S.exams.slice(-60); persist();
    session = null; persistSession();
    if (timeout) toast("Tempo esgotado! Simulado entregue automaticamente.");
    go("resultado", rec.id);
  }
  function viewExamResult(id) {
    const e = S.exams.find(x => x.id === id);
    if (!e) { main().innerHTML = `<div class="empty card">Simulado não encontrado. <a href="${href("simulados")}">Voltar</a></div>`; return; }
    activeOrders = e.orders || {};
    const p = e.correct / e.total, ids = Object.keys(e.answers).filter(x => Q[x]);
    const wrong = ids.filter(x => e.answers[x] !== Q[x].answer), blanks = ids.filter(x => e.answers[x] == null).length;
    const verdict = p >= 0.8 ? ["ok", "Excelente — pronto para a prova"] : p >= TARGET ? ["info", "Passando — revise os pontos fracos"] : p >= 0.62 ? ["warn", "Perto — estudo focado necessário"] : ["bad", "Ainda não — revisão geral recomendada"];
    let filter = "erradas";
    main().innerHTML = `
      <div class="page-head"><div><h1>${esc(e.label)}</h1><p>${fmtDateTime(e.end)} · duração ${fmtDur(e.end - e.start)}${e.timeout ? " · tempo esgotado" : ""}</p></div><div class="btn-row"><a class="btn ghost" href="${href("simulados")}">← Simulados</a></div></div>
      <div class="grid kpis">${kpi("Nota", `${e.correct}/${e.total}`, pct(p))}<div class="kpi"><div class="label">Avaliação</div><div style="margin-top:8px"><span class="pill ${verdict[0]}">${verdict[1]}</span></div><div class="sub" style="margin-top:6px">Meta sugerida: ≥ 70%</div></div>${kpi("Erradas", wrong.length - blanks, blanks ? `+ ${blanks} em branco` : "")}</div>
      <div class="grid cols-2 section"><div class="card"><h2>Por domínio</h2>${byDomainRows(e.byDomain)}</div><div class="card"><h2>Plano de estudo</h2>${studyPlan(wrong.filter(x => e.answers[x] != null))}${wrong.length ? `<div class="btn-row" style="margin-top:14px"><button class="btn" id="retry-wrong">🔁 Refazer as ${wrong.length} erradas/em branco</button></div>` : ""}</div></div>
      <div class="section"><div class="tabs"><button data-f="erradas" class="active">Erradas/em branco (${wrong.length})</button><button data-f="todas">Todas (${ids.length})</button></div><div id="review-list"></div></div>`;
    const renderList = () => { const list = filter === "erradas" ? wrong : ids; $("#review-list").innerHTML = list.map(x => reviewItem(x, e.answers[x] == null ? "" : e.answers[x])).join("") || `<div class="empty card">Nada aqui.</div>`; bindReviewItems($("#review-list")); };
    renderList();
    $$("[data-f]").forEach(b => b.onclick = () => { filter = b.dataset.f; $$("[data-f]").forEach(x => x.classList.toggle("active", x === b)); renderList(); });
    const rw = $("#retry-wrong"); if (rw) rw.onclick = () => startPractice({ ids: shuffle(wrong), mode: "erros", label: "Erros do " + e.label });
  }
  function viewExams() {
    const hist = S.exams.slice().reverse();
    const best = k => { const xs = S.exams.filter(e => e.bank === k); return xs.length ? Math.max(...xs.map(e => e.correct / e.total)) : null; };
    const mocks = META.banks.filter(b => b.kind === "mock");
    const card = (k, title, desc, n) => `<div class="card"><h3>${esc(title)}</h3><p class="muted small">${desc}</p><p class="small">Melhor nota: <strong>${pct(best(k))}</strong> · Tentativas: ${S.exams.filter(e => e.bank === k).length}</p><button class="btn" data-exam="${esc(k)}">Começar (${n} questões · ${META.examMinutes} min)</button></div>`;
    main().innerHTML = `
      <div class="page-head"><div><h1>Simulados</h1><p>Sem correção imediata — igual à prova. Ao final: nota por domínio, plano de estudo e revisão com explicações.</p></div></div>
      ${session && session.kind === "exam" ? `<div class="card next-step"><div class="title">Simulado em andamento: ${esc(session.label)}</div><a class="btn" href="${href("sessao")}">Continuar</a></div>` : ""}
      <div class="grid cols-3 section">${mocks.map(b => card(b.id, b.label, "Prova completa fixa.", b.count)).join("")}${card("aleatorio", "Aleatório ponderado", `Sorteado de todo o banco (${QUESTIONS.length}), proporcional aos domínios e priorizando o que você ainda não domina.`, Math.min(META.examSize, QUESTIONS.length))}</div>
      <div class="card section"><h2>Histórico</h2>${hist.length ? `<div class="list">${hist.map(examListItem).join("")}</div>${hist.length > 1 ? examChart() : ""}` : `<div class="empty">Nenhum simulado ainda.</div>`}</div>`;
    $$("[data-exam]").forEach(b => b.onclick = () => { if (session && session.kind === "exam" && !confirm("Já existe um simulado em andamento. Descartar e começar outro?")) return; startExam(b.dataset.exam); });
  }
  function examChart() {
    const xs = S.exams.slice(-12), W = 600, H = 180, P = 30;
    const x = i => P + (xs.length === 1 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (xs.length - 1)), y = v => H - P - v * (H - 2 * P);
    return `<div class="chart section"><h3>Evolução das notas</h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Notas dos simulados"><line class="axis" x1="${P}" y1="${y(0)}" x2="${W - P}" y2="${y(0)}"/><line class="axis" x1="${P}" y1="${y(1)}" x2="${W - P}" y2="${y(1)}"/><line x1="${P}" y1="${y(TARGET)}" x2="${W - P}" y2="${y(TARGET)}" stroke="var(--ok)" stroke-dasharray="4 4"/><text x="${W - P}" y="${y(TARGET) - 4}" text-anchor="end">meta 70%</text><polyline points="${xs.map((e, i) => `${x(i)},${y(e.correct / e.total)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>${xs.map((e, i) => `<circle cx="${x(i)}" cy="${y(e.correct / e.total)}" r="4" fill="var(--accent)"><title>${esc(e.label)}: ${e.correct}/${e.total}</title></circle><text x="${x(i)}" y="${y(e.correct / e.total) - 9}" text-anchor="middle">${Math.round(100 * e.correct / e.total)}</text>`).join("")}</svg></div>`;
  }

  // ---------- Estatísticas ----------
  function viewStats() {
    const diff = ["easy", "medium", "hard"].map(d => Object.assign({ d }, statsFor(QUESTIONS.filter(q => q.difficulty === d).map(q => q.id)))).filter(x => x.total);
    const days = Object.entries(S.days).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-30);
    const rows = LESSONS.filter(l => l.group === "modulo" && !l.isIndex).map(l => Object.assign({ l }, statsFor(idsByLesson(l.id)))).filter(r => r.total);
    const totalAtt = QUESTIONS.reduce((s, q) => s + attempts(q.id).length, 0);
    const W = 600, H = 160, P = 24, maxN = Math.max(1, ...days.map(([, v]) => v.n)), bw = days.length ? (W - 2 * P) / days.length : 0;
    main().innerHTML = `
      <div class="page-head"><div><h1>Estatísticas</h1><p>${totalAtt} respostas registradas desde ${fmtDate(S.created)}.</p></div></div>
      <div class="card"><h2>Domínios</h2>${domainRows(domainStats())}</div>
      <div class="grid cols-2 section">
        <div class="card"><h2>Por dificuldade</h2>${diff.map(x => `<div class="domain-row"><div class="name">${DIFF_PT[x.d]}<small>${x.answered}/${x.total} vistas</small></div><div class="bars"><div class="bar"><i class="${barClass(x.acc)}" style="width:${Math.round((x.acc || 0) * 100)}%"></i><span class="target"></span></div></div><div class="pct">${pct(x.acc)}</div></div>`).join("")}</div>
        <div class="card chart"><h2>Atividade (30 dias)</h2>${days.length ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Respostas por dia"><line class="axis" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}"/>${days.map(([k, v], i) => { const h = (H - 2 * P) * v.n / maxN, ho = (H - 2 * P) * v.ok / maxN, xx = P + i * bw + 2; return `<rect x="${xx}" y="${H - P - h}" width="${Math.max(2, bw - 4)}" height="${h}" fill="var(--bad)" opacity=".55" rx="2"><title>${k}: ${v.n} respostas, ${v.ok} certas</title></rect><rect x="${xx}" y="${H - P - ho}" width="${Math.max(2, bw - 4)}" height="${ho}" fill="var(--ok)" rx="2"/>`; }).join("")}<text x="${P}" y="${H - 6}">${days[0][0].slice(5)}</text><text x="${W - P}" y="${H - 6}" text-anchor="end">${days[days.length - 1][0].slice(5)}</text></svg><p class="small muted">Verde = acertos · vermelho = erros</p>` : `<div class="empty">Sem atividade ainda.</div>`}</div>
      </div>
      <div class="card section"><h2>Por aula</h2><div class="table-wrap"><table><thead><tr><th>Aula</th><th style="text-align:right">Vistas</th><th style="text-align:right">Acerto</th><th></th></tr></thead><tbody>${rows.sort((a, b) => (a.acc == null) - (b.acc == null) || (a.acc - b.acc)).map(r => `<tr><td><a href="${href("aula", r.l.id)}">${esc(r.l.title)}</a></td><td style="text-align:right">${r.answered}/${r.total}</td><td style="text-align:right"><span class="pill ${pillClass(r.acc)}">${pct(r.acc)}</span></td><td><button class="btn small ghost" data-pl="${esc(r.l.id)}">Praticar</button></td></tr>`).join("")}</tbody></table></div></div>`;
    $$("[data-pl]").forEach(b => b.onclick = () => startPractice({ ids: shuffle(idsByLesson(b.dataset.pl)), label: "Aula: " + LESSON[b.dataset.pl].title }));
  }

  // ---------- Dados e ajustes ----------
  function viewConfig() {
    main().innerHTML = `
      <div class="page-head"><div><h1>Dados e ajustes</h1><p>O progresso de <strong>${esc(META.title)}</strong> fica salvo só neste navegador. Exporte para backup ou para levar a outro computador.</p></div></div>
      ${store.ok ? "" : `<div class="callout callout-warning"><div class="callout-title">⚠️ Armazenamento indisponível</div><div class="callout-body"><p>Seu navegador está bloqueando o armazenamento local (modo privado?). O site funciona, mas o progresso não será salvo.</p></div></div>`}
      <div class="grid cols-2">
        <div class="card"><h2>Backup</h2><p class="small muted">Arquivo .json com respostas, anotações, simulados e aulas lidas.</p><div class="btn-row"><button class="btn" id="exp">⬇ Exportar esta certificação</button><button class="btn secondary" id="exp-all">⬇ Exportar todas</button><label class="btn ghost" style="cursor:pointer">⬆ Importar<input type="file" id="imp" accept="application/json" hidden></label></div></div>
        <div class="card"><h2>Zerar</h2><p class="small muted">Apaga o progresso desta certificação neste navegador (as outras não são afetadas). Exporte antes.</p><button class="btn danger" id="reset">Apagar progresso de ${esc(META.title)}</button></div>
        <div class="card"><h2>Como o site decide o que estudar</h2><ul class="small">
          <li><strong>Repetição espaçada</strong>: acerto com certeza sobe a questão de caixa (1, 3, 7, 16 e 35 dias). Erro volta para a caixa 0. Acerto no chute revisa amanhã.</li>
          <li><strong>Pontos fracos</strong> = domínios com ≥ 3 questões vistas e acerto abaixo de 70%, ordenados pelo impacto.</li>
          <li><strong>Estimativa de acerto</strong> = acerto atual por domínio, ponderado ${META.officialWeights ? "pelos pesos oficiais" : "pela quantidade de questões de cada domínio"}.</li>
          <li>Cada questão é ligada à aula mais relacionada para você reestudar o ponto exato que errou.</li></ul></div>
        <div class="card"><h2>Créditos</h2><p class="small">Questões e conteúdo em inglês: <a href="https://github.com/kengio/databricks-certification-study-guide" target="_blank" rel="noopener">Databricks Certification Study Guide</a> (kengio, MIT). Tradução do GenAI Engineer Associate: <a href="https://github.com/DaviEmmerick/databricks-certification-study-guide" target="_blank" rel="noopener">Davi Emmerick</a>. Tradução do Data Engineer Associate e este site: <a href="https://github.com/diegocgribeiro" target="_blank" rel="noopener">Diego Ribeiro</a>. Material independente, não oficial da Databricks.</p></div>
      </div>`;
    const download = (obj, name) => { const blob = new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    $("#exp").onclick = () => download({ app: "studysite", version: STATE_VERSION, exported: new Date().toISOString(), certs: { [CERT]: S } }, `progresso-${CERT}-${todayKey()}.json`);
    $("#exp-all").onclick = () => { const certs = {}; CATALOG.certs.forEach(c => { const st = store.get(stateKey(c.id), null); if (st) certs[c.id] = st; }); download({ app: "studysite", version: STATE_VERSION, exported: new Date().toISOString(), certs }, `progresso-todas-${todayKey()}.json`); };
    $("#imp").onchange = ev => {
      const f = ev.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          let certs = data.certs;
          if (!certs && data.state && data.app === "dea-ptbr") certs = { "data-engineer-associate": data.state }; // backup do site antigo
          if (!certs || typeof certs !== "object") throw new Error("formato");
          const names = Object.keys(certs).filter(c => CERTS[c]);
          if (!names.length) throw new Error("nenhuma certificação reconhecida");
          if (!confirm(`Substituir o progresso de: ${names.map(c => CERTS[c].title).join(", ")}?`)) return;
          names.forEach(c => store.set(stateKey(c), sanitizeState(certs[c])));
          S = sanitizeState(store.get(stateKey(CERT), null)); toast("Progresso importado!"); route();
        } catch (e) { toast("Arquivo inválido: " + e.message); }
      };
      r.readAsText(f);
    };
    $("#reset").onclick = () => { if (!confirm(`Apagar TODO o progresso de ${META.title}? Não dá para desfazer.`)) return; S = blankState(); persist(); session = null; persistSession(); toast("Progresso apagado."); route(); };
  }

  // ======================================================================
  // Inicialização, teclado, tema, offline
  // ======================================================================
  const sel = $("#cert-select");
  sel.innerHTML = `<option value="">— escolha —</option>` + CATALOG.certs.map(c => `<option value="${esc(c.id)}">${esc(c.title)}${c.lang === "pt" ? " 🇧🇷" : ""}</option>`).join("");
  sel.onchange = () => { if (sel.value) location.hash = `#/${sel.value}/painel`; else location.hash = "#/"; };

  document.addEventListener("keydown", e => {
    if (!session || !/\/sessao$/.test(location.hash)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const btns = $$("[data-choice]");
    let pos = -1;
    if (/^[1-9]$/.test(k)) pos = +k - 1;
    else if (k.length === 1 && "abcdefgh".includes(k) && !(k === "f" && session.kind === "exam")) pos = "abcdefgh".indexOf(k);
    if (pos >= 0 && btns[pos]) { if (!btns[pos].disabled) { btns[pos].click(); e.preventDefault(); } return; }
    if (k === "enter") { const b = $("#submit:not(:disabled)") || $("#next"); if (b) { b.click(); e.preventDefault(); } }
    else if (k === "f" && session.kind === "exam") { const b = $("#flag"); if (b) b.click(); }
    else if (k === "arrowright" && session.kind === "exam") { const b = $("#next"); if (b) b.click(); }
    else if (k === "arrowleft") { const b = $("#prev"); if (b && !b.disabled) b.click(); }
  });

  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
  let theme = store.get("studysite-theme", null); applyTheme(theme);
  $("#theme-toggle").onclick = () => { const dark = getComputedStyle(document.documentElement).colorScheme === "dark"; theme = dark ? "light" : "dark"; applyTheme(theme); store.set("studysite-theme", theme); if (/\/aula\//.test(location.hash)) route(); };
  $("#menu-toggle").onclick = () => { const sb = $("#sidebar"); sb.classList.toggle("open"); $("#menu-toggle").setAttribute("aria-expanded", sb.classList.contains("open")); };

  const offline = () => { $("#offline-badge").hidden = navigator.onLine; };
  window.addEventListener("online", offline); window.addEventListener("offline", offline); offline();
  window.addEventListener("error", ev => { console.error(ev.error || ev.message); });
  window.addEventListener("unhandledrejection", ev => { console.error(ev.reason); });

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && location.hostname !== "localhost") {
    navigator.serviceWorker.register("sw.js").catch(() => { });
  }

  window.addEventListener("hashchange", route);
  if (!location.hash || location.hash === "#/" || location.hash === "#") {
    const last = store.get("studysite-last-cert", null);
    if (last && CERTS[last]) { location.replace(`#/${last}/painel`); }
  }
  route();
})();
