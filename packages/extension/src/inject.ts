/**
 * Extensión del asistente (se inyecta en la página del juego, en el mundo de la página, antes de que cargue el cliente). Hace tres cosas:
 *  1. Engancha el WebSocket del game server y le manda al bot local (ws://127.0.0.1:8792, ver bot/src/attach.ts) cada frame que entra y cada
 *     frame que sale. Solo copia: lo que ve la página no cambia.
 *  2. Lo que el bot le devuelve (paquetes ya cifrados) lo escribe en ese mismo socket, con el `send` original (no se vuelve a copiar).
 *  3. Un botón chico en la esquina: prende y apaga el auto attack y muestra qué está haciendo.
 */
const NativeWS = window.WebSocket;
const nativeSend = NativeWS.prototype.send;
const ASSISTANT_URL = 'ws://127.0.0.1:8792';
const CONNECT_SERVER_PORT = '44405';

let gameSock: WebSocket | null = null;
let bridge: WebSocket | null = null;
let created = 0;
const queue: Uint8Array[] = [];
let chain: Promise<void> = Promise.resolve();

// --- Puente con el bot local -------------------------------------------------------------------------------------------------------------------
function openBridge() {
  const ws = new NativeWS(ASSISTANT_URL);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    bridge = ws;
    for (const f of queue.splice(0)) ws.send(f);
    paint({ link: true });
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try { paint({ link: true, ...JSON.parse(e.data) }); } catch { /* mensaje inválido */ }
      return;
    }
    if (gameSock && gameSock.readyState === NativeWS.OPEN) nativeSend.call(gameSock, e.data as ArrayBuffer);
  };
  ws.onclose = () => {
    bridge = null;
    paint({ link: false });
    setTimeout(openBridge, 3000);
  };
}

function forward(dir: 0 | 1, data: ArrayBuffer | ArrayBufferView) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = dir;
  frame.set(bytes, 1);
  if (bridge && bridge.readyState === NativeWS.OPEN) bridge.send(frame);
  else if (queue.length < 2000) queue.push(frame);
}

// --- Enganche del socket del juego -------------------------------------------------------------------------------------------------------------
function isGameSocket(url: string): boolean {
  if (url.startsWith(ASSISTANT_URL)) return false;
  const port = /[?&]port=(\d+)/.exec(url)?.[1];
  return port ? port !== CONNECT_SERVER_PORT : created > 1; // sin puerto en la URL: el primer socket es el connect server
}

class HookedWebSocket extends NativeWS {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    if (String(url).startsWith(ASSISTANT_URL)) return;
    created++;
    if (!isGameSocket(String(url))) return;
    gameSock = this;
    this.addEventListener('message', (e) => {
      const d = e.data;
      if (typeof d === 'string') return;
      chain = chain.then(async () => forward(0, d instanceof Blob ? await d.arrayBuffer() : (d as ArrayBuffer)));
    });
    this.addEventListener('close', () => { if (gameSock === this) gameSock = null; });
  }
}
NativeWS.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
  if (this === gameSock && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) forward(1, data as ArrayBuffer | ArrayBufferView);
  return nativeSend.call(this, data);
};
window.WebSocket = HookedWebSocket as unknown as typeof WebSocket;

// --- Botón y estado ----------------------------------------------------------------------------------------------------------------------------
type Status = { link?: boolean; enabled?: boolean; inGame?: boolean; name?: string; hp?: number; maxHp?: number; monsters?: number; skill?: string; target?: number; error?: string };
let last: Status = { link: false };
let box: HTMLDivElement | null = null;
let btn: HTMLButtonElement | null = null;
let line: HTMLDivElement | null = null;

// Se mueve arrastrando el título (la esquina que tapa depende del cliente) y la posición se recuerda; doble clic lo achica.
const POS_KEY = 'asistente-pos';
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
    for (const el of [btn, line]) if (el) el.style.display = hide ? 'none' : '';
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
  btn.onclick = () => {
    if (bridge && bridge.readyState === NativeWS.OPEN) bridge.send(JSON.stringify({ type: 'set', on: !last.enabled }));
  };
  line = document.createElement('div');
  line.style.cssText = 'margin-top:6px;color:#aaa;min-height:34px';
  box.append(title, btn, line);
  document.documentElement.appendChild(box);
  paint({});
}

function paint(s: Status) {
  last = { ...last, ...s };
  if (!box) {
    if (document.documentElement) build();
    else return;
  }
  if (!btn || !line) return;
  btn.textContent = last.enabled ? 'Auto attack: ENCENDIDO' : 'Auto attack: apagado';
  btn.style.background = last.enabled ? '#2e9e5b' : '#555';
  btn.style.color = '#fff';
  btn.disabled = !last.link;
  if (!last.link) line.textContent = 'Sin conexión con el bot (bun run asistente).';
  else if (last.error) line.textContent = last.error;
  else if (!last.inGame) line.textContent = 'Esperando que entres al mundo (cargá la página con el asistente andando).';
  else line.textContent = `${last.name ?? ''} · vida ${last.hp}/${last.maxHp} · ${last.monsters} monstruos · ${last.skill}`;
}

openBridge();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => paint({}));
else paint({});
