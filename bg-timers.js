/**
 * Temporizadores que no se congelan en segundo plano.
 * Chrome limita los setInterval de una pestaña oculta a ~1 por minuto tras unos minutos
 * ("intensive throttling"): el agente de la pestaña que no se ve se detenía (Horaz con 9
 * monstruos al lado sin pegar mientras el usuario miraba la pestaña de Melu). Los Web
 * Workers no tienen ese límite: acá setInterval/clearInterval pasan a usar un worker.
 * Se carga ANTES que browser-agent.js / duo.js (que registran sus timers con setInterval).
 */
(() => {
  if (window.__bgTimers) return 'ya estaba';
  const src = 'const t={};onmessage=e=>{const d=e.data;if(d.cmd==="set")t[d.id]=setInterval(()=>postMessage(d.id),d.ms);else{clearInterval(t[d.id]);delete t[d.id];}}';
  const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  const fns = {}; let next = 1e7;
  wk.onmessage = (e) => { const f = fns[e.data]; if (f) { try { f(); } catch (err) { console.warn('[bg-timer]', err); } } };
  const origSet = window.setInterval.bind(window), origClear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    if (typeof fn !== 'function') return origSet(fn, ms, ...args);
    const id = ++next; fns[id] = args.length ? () => fn(...args) : fn; wk.postMessage({ cmd: 'set', id, ms: Math.max(10, ms | 0) }); return id;
  };
  window.clearInterval = (id) => { if (fns[id]) { delete fns[id]; wk.postMessage({ cmd: 'clear', id }); } else origClear(id); };
  window.__bgTimers = { wk, count: () => Object.keys(fns).length };
  return 'temporizadores en worker';
})();
