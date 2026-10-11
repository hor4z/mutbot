// ==UserScript==
// @name         mubot: cargar el agente en mu.mormon.garden
// @namespace    mubot
// @version      1.0
// @description  Inyecta bg-timers.js, browser-agent.js y tuner.js (servidos por `bun run agent` en 127.0.0.1:8788) cada vez que carga la página del juego. Así un deploy o un F5 no deja al bot apagado.
// @match        https://mu.mormon.garden/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// Uso: instalar en Tampermonkey / Violentmonkey, y tener corriendo `bun run agent` en ~/self/mubot.
// No toca credenciales: si después de un deploy el cliente vuelve a la pantalla de login, entrás vos
// con el personaje; apenas está en el mundo, el agente se carga solo y sigue con lo aprendido.
// Si el server solo corta la conexión (sin recargar la página), el agente ya vuelve a entrar solo
// desde la selección de personaje.
(() => {
  const BASE = 'http://127.0.0.1:8788/';
  const FILES = ['bg-timers.js', 'browser-agent.js', 'tuner.js', 'hunter.js', 'defense.js', 'corner.js'];
  let loaded = false;
  const tryLoad = async () => {
    if (loaded || !window.__store || !window.__eventBus) return;
    // Solo con el personaje ya en el mundo: lo aprendido se guarda por nombre (mubot-ai:<pj>) y en
    // la selección de personaje el nombre todavía está vacío.
    if (window.__store.uiState !== 5 || !window.__store.playerData?.name) return;
    loaded = true;
    try {
      for (const f of FILES) (0, eval)(await (await fetch(BASE + f + '?' + Date.now())).text());
      console.log('[mubot] agente cargado');
    } catch (e) { loaded = false; console.warn('[mubot] no pude cargar el agente (¿corre `bun run agent`?)', e); }
  };
  setInterval(tryLoad, 3000);
})();
