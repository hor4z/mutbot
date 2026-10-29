/**
 * Extensión del asistente (se inyecta en la página del juego, en el mundo de la página, antes de que cargue el cliente). Hace tres cosas:
 *  1. Engancha el WebSocket del game server y le da al asistente (assistant.ts, que corre acá mismo) cada frame que entra y cada frame que sale.
 *  2. El asistente decide a quién pegarle y qué levantar y escribe sus paquetes en ese mismo socket, con el `send` original y el mismo contador de
 *     cifrado que el cliente: una sola secuencia. No hay proceso aparte, ni red local, ni base de datos.
 *  3. Un panel chico en la esquina: prende y apaga el auto attack y el Joyero, reparte puntos y muestra qué está haciendo.
 */
import { diag, onGameSocket, onGameSocketClosed, onPageSend, onServerFrame, setAssist, startAssistant, status as assistantStatus } from './assistant';

const NativeWS = window.WebSocket;
const nativeSend = NativeWS.prototype.send;
const CONNECT_SERVER_PORT = '44405';

let gameSock: WebSocket | null = null;
let created = 0;
let chain: Promise<void> = Promise.resolve();

// --- Enganche del socket del juego -------------------------------------------------------------------------------------------------------------
function isGameSocket(url: string): boolean {
  const port = /[?&]port=(\d+)/.exec(url)?.[1];
  return port ? port !== CONNECT_SERVER_PORT : created > 1; // sin puerto en la URL: el primer socket es el connect server
}

const toBytes = (d: ArrayBuffer | ArrayBufferView) => (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));

class HookedWebSocket extends NativeWS {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    created++;
    if (!isGameSocket(String(url))) return;
    gameSock = this;
    onGameSocket();
    this.addEventListener('message', (e) => {
      const d = e.data;
      if (typeof d === 'string') return;
      // En orden aunque algún mensaje llegue como Blob (que se lee de forma asíncrona).
      chain = chain.then(async () => onServerFrame(new Uint8Array(d instanceof Blob ? await d.arrayBuffer() : (d as ArrayBuffer))));
    });
    this.addEventListener('close', () => { if (gameSock === this) { gameSock = null; onGameSocketClosed(); } });
  }
}
NativeWS.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
  if (this === gameSock && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
    // Con el asistente en marcha, los C3 de la página se vuelven a cifrar con el contador compartido y salen desde el asistente.
    if (onPageSend(Uint8Array.from(toBytes(data)))) return;
  }
  return nativeSend.call(this, data);
};
window.WebSocket = HookedWebSocket as unknown as typeof WebSocket;
startAssistant({
  write: (bytes) => { if (gameSock && gameSock.readyState === NativeWS.OPEN) nativeSend.call(gameSock, bytes); else diag.dropped++; },
  press: (key) => pressKey(key),
});

// --- Reparto de stats: clicks reales en el panel de personaje, no paquetes ----------------------------------------------------------------------
// El panel (ventana "Character" del cliente web) manda directo al server con sus propios clicks, con su propio
// contador de cifrado: no comparte nada con el bot ni con el socket interceptado, así que no hay riesgo de
// desincronizar nada (el problema que rompía el ataque y el `/add` por chat cuando el usuario jugaba a la vez
// que el asistente). Shift+click = +10, Cmd/Ctrl+click = +100, click solo = +1 (lo dice el propio panel).
function statRows(): { label: string; value: number; btn: HTMLElement }[] {
  const panel = document.querySelector('.v097d-window.v097d-character');
  if (!panel) return [];
  const kids = Array.from(panel.children) as HTMLElement[];
  const rows: { label: string; value: number; btn: HTMLElement }[] = [];
  let pendingLabel: string | null = null;
  for (const el of kids) {
    if (el.classList.contains('v097d-stat-name')) {
      const m = /^(Str|Agi|Vit|Ene):\s*(\d+)/.exec(el.textContent ?? '');
      pendingLabel = m ? m[1]! : null;
      if (m) rows.push({ label: m[1]!, value: Number(m[2]), btn: null as unknown as HTMLElement });
    } else if (pendingLabel && el.classList.contains('v097d-button')) {
      const row = rows.find((r) => r.label === pendingLabel && !r.btn);
      if (row) row.btn = el;
      pendingLabel = null;
    }
  }
  return rows.filter((r) => r.btn);
}
function readPoints(): number {
  const el = Array.from(document.querySelectorAll('.v097d-window.v097d-character *')).find((e) => /^Point:\s*\d+/.test(e.textContent ?? '') && e.children.length === 0);
  return Number(/Point:\s*(\d+)/.exec(el?.textContent ?? '')?.[1] ?? 0);
}
function clickStatButton(el: HTMLElement, mods: { shift?: boolean; cmd?: boolean }) {
  const r = el.getBoundingClientRect();
  const opts: MouseEventInit = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, shiftKey: !!mods.shift, metaKey: !!mods.cmd, ctrlKey: !!mods.cmd, button: 0 };
  for (const [type, Ctor] of [['pointerdown', PointerEvent], ['mousedown', MouseEvent], ['pointerup', PointerEvent], ['mouseup', MouseEvent], ['click', MouseEvent]] as const) {
    el.dispatchEvent(new Ctor(type, opts));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Un stat hasta sumar `n` puntos: de a 100 (cmd), 10 (shift) y 1 (solo), con una pausa chica entre cada click. */
async function addToStat(btnEl: HTMLElement, n: number) {
  const steps: [number, { shift?: boolean; cmd?: boolean }][] = [[100, { cmd: true }], [10, { shift: true }], [1, {}]];
  for (const [step, mods] of steps) {
    while (n >= step) { clickStatButton(btnEl, mods); n -= step; await sleep(120); }
  }
}
/** Energía hasta que fuerza − 2000 − energía llegue a 0 (ahí el giro de Twisting Slash rinde igual por punto en
 * los dos), después mitad y mitad entre fuerza y energía. Sin vitalidad (pedido del usuario, 2026-10-29). */
async function investStatsNow() {
  const rows = statRows();
  const str = rows.find((r) => r.label === 'Str');
  const ene = rows.find((r) => r.label === 'Ene');
  const points = readPoints();
  if (!str || !ene || points <= 0) return;
  const gap = Math.max(0, str.value - 2000 - ene.value);
  const toEne = Math.min(points, gap);
  const rest = points - toEne;
  const half = Math.floor(rest / 2);
  const eneN = toEne + half;
  const strN = rest - half;
  if (eneN > 0) await addToStat(ene.btn, eneN);
  if (strN > 0) await addToStat(str.btn, strN);
}

// --- Botón y estado ----------------------------------------------------------------------------------------------------------------------------
type Status = { link?: boolean; enabled?: boolean; gold?: boolean; inGame?: boolean; name?: string; hp?: number; maxHp?: number; monsters?: number; skill?: string; target?: number; error?: string; sniper?: boolean; loot?: { id: number; name: string; dist: number; dir: string } | null };
let last: Status = { link: true };
let box: HTMLDivElement | null = null;
let btn: HTMLButtonElement | null = null;
let btn2: HTMLButtonElement | null = null;
let btn3: HTMLButtonElement | null = null;
let btnGold: HTMLButtonElement | null = null;
let lastLoot = 0;
let line: HTMLDivElement | null = null;

// Se mueve arrastrando el título (la esquina que tapa depende del cliente) y la posición se recuerda; doble clic lo achica.
const POS_KEY = 'asistente-pos';
/** Teclas del hotbar que el asistente puede apretar: solo las pociones (Q curación, W maná). El ataque va por
 * packet (ver brain/assist.ts), no por tecla. */
const HOTBAR_KEYS = new Set(['q', 'w', 'e', 'r']);
function pressKey(key: string) {
  if (!HOTBAR_KEYS.has(key)) return;
  const code = key.toUpperCase().charCodeAt(0);
  const domCode = `Key${key.toUpperCase()}`;
  for (const type of ['keydown', 'keyup']) {
    const ev = new KeyboardEvent(type, { key, code: domCode, keyCode: code, which: code, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    document.dispatchEvent(ev);
  }
}

function placeBox(b: HTMLDivElement) {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null') as { x: number; y: number } | null;
    if (p) Object.assign(b.style, { left: `${Math.min(p.x, innerWidth - 60)}px`, top: `${Math.min(p.y, innerHeight - 30)}px` });
  } catch { /* sin almacenamiento */ }
}
function dragBox(b: HTMLDivElement, handle: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    const dx = e.clientX - b.offsetLeft, dy = e.clientY - b.offsetTop;
    const move = (m: PointerEvent) => Object.assign(b.style, { left: `${Math.max(0, m.clientX - dx)}px`, top: `${Math.max(0, m.clientY - dy)}px` });
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: b.offsetLeft, y: b.offsetTop })); } catch { /* sin almacenamiento */ }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });
  handle.addEventListener('dblclick', () => {
    const hide = btn?.style.display !== 'none';
    for (const el of [btn, btn2, btnGold, btn3, line]) if (el) el.style.display = hide ? 'none' : '';
    b.style.width = hide ? 'auto' : '210px';
  });
}

function build() {
  box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', left: '12px', top: '12px', zIndex: '2147483647', font: '12px/1.4 system-ui, sans-serif', color: '#e8e8e8',
    background: 'rgba(20,20,24,.92)', border: '1px solid #444', borderRadius: '8px', padding: '8px 10px', width: '210px', userSelect: 'none',
  });
  const title = document.createElement('div');
  title.textContent = 'Asistente de Capitan';
  title.style.cssText = 'font-weight:600;margin-bottom:6px;cursor:move';
  title.title = 'Arrastrá para moverlo; doble clic para achicarlo';
  placeBox(box);
  dragBox(box, title);
  btn = document.createElement('button');
  btn.style.cssText = 'width:100%;padding:6px;border-radius:6px;border:0;cursor:pointer;font-weight:600';
  btn.onclick = () => { tick(setAssist({ on: !last.enabled })); };
  btn2 = document.createElement('button');
  btn2.style.cssText = 'width:100%;padding:6px;margin-top:6px;border-radius:6px;border:0;cursor:pointer;font-weight:600';
  btn2.onclick = () => { tick(setAssist({ sniper: !last.sniper })); };
  btnGold = document.createElement('button');
  btnGold.style.cssText = 'width:100%;padding:6px;margin-top:6px;border-radius:6px;border:0;cursor:pointer;font-weight:600';
  btnGold.onclick = () => { tick(setAssist({ gold: !last.gold })); };
  btn3 = document.createElement('button');
  btn3.style.cssText = 'width:100%;padding:6px;margin-top:6px;border-radius:6px;border:0;cursor:pointer;font-weight:600;background:#555;color:#fff';
  btn3.textContent = 'Repartir puntos';
  btn3.onclick = () => { void investStatsNow(); };
  line = document.createElement('div');
  line.style.cssText = 'margin-top:6px;color:#aaa;min-height:34px';
  box.append(title, btn, btn2, btnGold, btn3, line);
  document.documentElement.appendChild(box);
  paint({});
}

// Un pitido corto cuando cae una joya cerca: se avisa de lo que hay que correr a buscar.
function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  } catch { /* sin audio */ }
}

function paint(s: Status) {
  last = { ...last, ...s };
  if (!box) {
    if (document.documentElement) build();
    else return;
  }
  if (!btn || !btn2 || !btnGold || !btn3 || !line) return;
  const points = readPoints();
  btn3.textContent = points > 0 ? `Repartir puntos (${points})` : 'Repartir puntos';
  btn3.disabled = points <= 0;
  btn3.style.opacity = btn3.disabled ? '0.5' : '1';
  btnGold.textContent = last.gold ? 'Oro: ENCENDIDO' : 'Oro: apagado';
  btnGold.style.background = last.gold ? '#2e9e5b' : '#555';
  btnGold.style.color = '#fff';
  btnGold.disabled = !last.link;
  btn2.textContent = last.sniper ? 'Joyero: ENCENDIDO' : 'Joyero: apagado';
  btn2.style.background = last.sniper ? '#2e9e5b' : '#555';
  btn2.style.color = '#fff';
  btn2.disabled = !last.link;
  if (last.sniper && last.loot && last.loot.id !== lastLoot) {
    lastLoot = last.loot.id;
    beep();
  }
  btn.textContent = last.enabled ? 'Auto attack: ENCENDIDO' : 'Auto attack: apagado';
  btn.style.background = last.enabled ? '#2e9e5b' : '#555';
  btn.style.color = '#fff';
  btn.disabled = !last.link;
  if (last.error) line.textContent = last.error;
  else if (!last.inGame) line.textContent = 'Esperando que entres al mundo.';
  else if (last.sniper && last.loot) line.textContent = `${last.loot.name} a ${last.loot.dist} casillas al ${last.loot.dir}`;
  else line.textContent = `${last.name ?? ''} · vida ${last.hp}/${last.maxHp} · ${last.monsters} monstruos · ${last.skill}`;
}

// --- Que el panel nunca se quede con un "soltar" del juego ----------------------------------------------------------------------------------------
// Si empezás a apretar sobre el juego (atacar, perseguir) y soltás con el mouse encima del panel, el juego no recibe nunca el "soltar": queda con el
// botón apretado y el personaje sigue persiguiendo sin poder soltarlo. Se reenvía al mismo elemento donde empezó el click.
let downTarget: EventTarget | null = null;
window.addEventListener('pointerdown', (e: PointerEvent) => { downTarget = e.target; }, true);
window.addEventListener('pointerup', (e: PointerEvent) => {
  const from = downTarget;
  downTarget = null;
  if (!from || !box || !(from instanceof Element) || !(e.target instanceof Node)) return;
  if (!box.contains(e.target) || box.contains(from)) return;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: 0 };
  from.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary }));
  from.dispatchEvent(new MouseEvent('mouseup', init));
}, true);

/** Actualiza el panel con lo que ve el asistente; `error` es el motivo de un pedido que no se pudo cumplir. */
function tick(error?: string | null) {
  paint({ ...assistantStatus(), error: error ?? undefined });
}
setInterval(() => tick(), 1000);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => paint({}));
else paint({});
