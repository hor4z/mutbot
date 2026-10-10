/**
 * Experimento de skills del agente web: Twisting Slash (41) vs Rageful Blow (42) vs
 * alternados (41,42,41…), ventanas de 2 min, solo desde nivel 250 (el tramo que
 * decide el ciclo). Gana el de más exp/min y queda puesto. Alternar es lo que haría
 * una persona apretando dos teclas: el cliente sigue manejando animación y cooldown.
 * Se instala después de browser-agent.js. Estado: __ai.skillAB (windows, done).
 */
(() => {
  const ai = window.__ai, S = __store, W = () => __world;
  if (!ai) return 'primero instalá browser-agent.js';
  const prev = ai.skillAB;
  for (const k of ['timer']) if (prev?.[k]) clearInterval(prev[k]);
  const ab = (ai.skillAB = { arms: [41, 42, 'alt'], idx: prev?.idx ?? 0, winStart: Date.now(), windows: prev?.windows ?? [], WINDOW: 120000, done: prev?.done ?? null });
  ai.rot ??= { on: false, seq: [41, 42], i: 0 };
  const apply = (arm) => { if (arm === 'alt') ai.rot.on = true; else { ai.rot.on = false; ai.cfg.skill = arm; } };
  // El usuario descartó Rageful Blow (42): "es lento, perdemos tiempo". Queda Twisting Slash.
  ab.done ??= { best: 41, by: 'usuario: Rageful Blow es lento' };
  if (ab.done) { apply(ab.done.best); return `ya decidido: ${ab.done.best}`; }
  ai.rot = { on: false, seq: [41, 42], i: 0 };
  clearInterval(ai.caster);
  ai.caster = setInterval(() => {
    const w = W(), t = ai.target, pe = w?.playerEntity, pd = S.playerData;
    if (!ai.on || ai.busy || !t || !pe || w.castRequest || S.sceneLoading || pd.currentMP / pd.maxMP < ai.cfg.skillMinMp) return;
    const P = pe.transform.pos, tp = t.transform.pos;
    if (Math.max(Math.abs(P.x - tp.x), Math.abs(P.z - tp.z)) > ai.cfg.castRange) return;
    if (ai.rot.on) { const sk = ai.rot.seq[ai.rot.i++ % ai.rot.seq.length]; ai.cfg.skill = sk; if (S.currentSkill !== sk) S.selectSkill(sk); }
    w.castRequest = { target: t, point: { x: tp.x, y: tp.z }, forced: false };
  }, 50);

  ab.timer = setInterval(() => {
    const now = Date.now(), lvl = S.playerData.level ?? 0;
    if (S.uiState !== 5 || ai.busy || lvl < 250) { ab.winStart = now; ab.waitingResume = true; if (lvl < 250) { ai.rot.on = false; ai.cfg.skill = 41; } return; }
    if (ab.waitingResume) { apply(ab.arms[ab.idx % 3]); ab.waitingResume = false; ab.winStart = now; return; }
    if (now - ab.winStart < ab.WINDOW) return;
    const exp = ai.expLog.filter((x) => x.t >= ab.winStart && x.t < now).reduce((a, x) => a + x.added, 0);
    ab.windows.push({ skill: ab.arms[ab.idx % 3], rate: Math.round(((exp / (now - ab.winStart)) * 60000) / 1e6), level: lvl });
    ab.idx++; apply(ab.arms[ab.idx % 3]); ab.winStart = now;
    ai.L(`A/B skills: ventana ${ab.windows.length} → ahora ${ab.arms[ab.idx % 3]}`);
    if (ab.windows.length >= 6) {
      const avg = (k) => { const w = ab.windows.filter((x) => x.skill === k); return w.length ? w.reduce((a, x) => a + x.rate, 0) / w.length : 0; };
      const res = Object.fromEntries(ab.arms.map((k) => [k, Math.round(avg(k))]));
      const best = ab.arms.reduce((b, k) => (avg(k) > avg(b) ? k : b));
      apply(best); clearInterval(ab.timer); ab.done = { res, best };
      ai.L(`A/B skills: ${JSON.stringify(res)} M exp/min → me quedo con ${best}`);
    }
  }, 2000);
  return 'A/B de skills listo (mide desde nivel 250)';
})();
