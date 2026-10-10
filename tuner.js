/**
 * Autoajuste del agente web (window.__ai) por experimentos A/B intercalados.
 *
 * Toma la config actual (A) y una variante con UN parámetro cambiado (B), las
 * alterna en ventanas de WINDOW_MS (A,B,A,B…) y compara exp/min. Intercalar
 * hace justa la comparación aunque el nivel suba (ventanas vecinas = niveles
 * parecidos). Si B gana por > MIN_GAIN tras PAIRS pares, se adopta. Historial
 * en __ai.tuner.history y en localStorage (`mubot-tuner:<pj>`).
 *
 * Se instala después de browser-agent.js, pegándolo en la consola.
 */
(() => {
  const setInterval = (fn, ms) => { const id = window.setInterval(fn, ms); (window.__mubotTimers ??= []).push(id); return id; };
  const ai = window.__ai, S = __store;
  if (!ai) return 'primero instalá browser-agent.js';
  if (ai.tuner?.timer) clearInterval(ai.tuner.timer);
  const KEY = `mubot-tuner:${S.playerData?.name ?? 'pj'}`;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  // Parámetros y rango razonable. step = cuánto se mueve en cada propuesta.
  const SPACE = {
    campRadius: { min: 5, max: 18, step: 3 },
    campEmptyMs: { min: 5000, max: 30000, step: 5000 },
    competitionPenalty: { min: 0.2, max: 0.9, step: 0.15 },
    maxKillSec: { min: 3, max: 14, step: 2 },
    secPerTile: { min: 0.15, max: 1.0, step: 0.15 },
    castRange: { min: 2, max: 5, step: 1 },
    skillMinMp: { min: 0, max: 0.4, step: 0.1 },
    campDistDecay: { min: 5, max: 30, step: 6 },
    // 0 = acampar, 1 = recorrer pegando (decisión del autoajuste, no mía)
    roam: { min: 0, max: 1, step: 1 },
  };
  const WINDOW_MS = 180000, PAIRS = 2, MIN_GAIN = 0.05;
  // Aplicar lo aprendido en sesiones anteriores.
  if (saved.best) Object.assign(ai.cfg, saved.best);
  const t = (ai.tuner = { history: saved.history ?? [], exp: null, timer: null });
  const expSince = (a, b) => ai.expLog.filter((x) => x.t >= a && x.t < b).reduce((s, x) => s + x.added, 0);
  const pick = (o) => Object.fromEntries(Object.keys(SPACE).map((k) => [k, o[k]]));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ best: pick(ai.cfg), history: t.history.slice(-200) })); } catch {} };
  const propose = () => {
    // La primera prueba: acampar vs recorrer (la duda del usuario).
    if (!t.history.some((h) => h.key === 'roam')) return { key: 'roam', from: ai.cfg.roam ?? 0, to: (ai.cfg.roam ?? 0) ? 0 : 1 };
    const keys = Object.keys(SPACE);
    for (let tries = 0; tries < 20; tries++) {
      const k = keys[Math.floor(Math.random() * keys.length)], sp = SPACE[k];
      const cur = ai.cfg[k] ?? (sp.min + sp.max) / 2;
      const v = +Math.min(sp.max, Math.max(sp.min, cur + (Math.random() < 0.5 ? -1 : 1) * sp.step)).toFixed(3);
      // no repetir algo que ya perdió desde un valor parecido
      if (v === cur || t.history.some((h) => h.key === k && h.to === v && Math.abs(h.from - cur) < sp.step / 2 && !h.adopted)) continue;
      return { key: k, from: cur, to: v };
    }
    return null;
  };
  const start = () => {
    const p = propose(); if (!p) return;
    t.exp = { ...p, windows: [], arm: 'A', winStart: Date.now() };
    ai.L(`tuner: pruebo ${p.key} ${p.from} → ${p.to}`);
  };
  const tick = () => {
    if (!ai.on || ai.busy || S.uiState !== 5) { if (t.exp) t.exp.winStart = Date.now(); return; }
    // Un experimento a la vez: esperar a que termine el de skills (skill-ab.js).
    if (ai.skillAB && !ai.skillAB.done) { if (t.exp) { ai.cfg[t.exp.key] = t.exp.from; t.exp = null; } return; }
    // Solo en la fase larga (>=200): ahí se juega el ciclo; antes los mapas cambian demasiado.
    if ((S.playerData.level ?? 0) < 200) { if (t.exp) { ai.cfg[t.exp.key] = t.exp.from; t.exp = null; } return; }
    if (!t.exp) return start();
    const e = t.exp, now = Date.now();
    if (now - e.winStart < WINDOW_MS) return;
    // Cerrar ventana: exp/min del brazo activo (si hubo warp/muerte, igual cuenta: es parte del costo).
    e.windows.push({ arm: e.arm, rate: (expSince(e.winStart, now) / (now - e.winStart)) * 60000 });
    e.arm = e.arm === 'A' ? 'B' : 'A';
    ai.cfg[e.key] = e.arm === 'A' ? e.from : e.to;
    e.winStart = now;
    const A = e.windows.filter((w) => w.arm === 'A'), B = e.windows.filter((w) => w.arm === 'B');
    if (A.length >= PAIRS && B.length >= PAIRS) {
      const mean = (xs) => xs.reduce((s, w) => s + w.rate, 0) / xs.length;
      const a = mean(A), b = mean(B), adopted = b > a * (1 + MIN_GAIN);
      ai.cfg[e.key] = adopted ? e.to : e.from;
      t.history.push({ at: now, key: e.key, from: e.from, to: e.to, a: Math.round(a), b: Math.round(b), adopted, level: S.playerData.level });
      ai.L(`tuner: ${e.key} ${e.from}→${e.to}: ${Math.round(a / 1e6)}M vs ${Math.round(b / 1e6)}M exp/min → ${adopted ? 'ADOPTADO' : 'descartado'}`);
      t.exp = null; save();
    }
  };
  t.timer = setInterval(tick, 5000);
  t.report = () => ({ current: pick(ai.cfg), running: t.exp && { key: t.exp.key, from: t.exp.from, to: t.exp.to, arm: t.exp.arm, windows: t.exp.windows.length }, adopted: t.history.filter((h) => h.adopted), tried: t.history.length });
  return 'tuner instalado';
})();
