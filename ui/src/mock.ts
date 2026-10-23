/**
 * Modo demo (`/panel?demo`): la estación con datos simulados, sin tocar la estación real ni ningún
 * bot. Reemplaza `fetch` solo para /api/*; sirve para probar y capturar la interfaz.
 */
import { roleFromRoutine, roleRoutine, type Alert, type RoleAssign } from "../../estacion-logic";
import type { Character } from "./station-data";

export const isDemo = () => typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");

const min = 60_000;
const rnd = (n: number) => Math.floor(Math.random() * n);

type M = Character & { startedAt?: number };
const mk = (o: Partial<M> & Pick<M, "key" | "char" | "user">): M => ({
  account: "active", cls: null, status: "off", msg: "desconectado", pid: null, port: 8791, panel: false, routine: null, pending: null,
  role: { role: "route" }, roleSaved: true, stuck: false, game: null, ...o,
});
const game = (o: Partial<NonNullable<Character["game"]>>): NonNullable<Character["game"]> => ({
  mode: "farm", doing: "farmeando en Arena 4", level: 380, resets: 12, map: "Arena 4", x: 91, y: 13, hp: [1800, 2400], mp: [600, 900], expPerMin: 84_000,
  zen: 4_200_000, bag: 0.4, nearby: { monsters: 18, players: 1 }, resetsPerDay: 6, session: { since: Date.now() - 95 * min, kills: 640, deaths: 0, exp: 7_900_000 }, ...o,
});

let planAt = 0;
let chars: M[] = [
  mk({ key: "horaz", char: "Horaz", user: "cuenta1", cls: "dk", status: "on", pid: 101, port: 8791, panel: true, msg: "en el juego", routine: { kind: "farm" }, role: { role: "route" }, game: game({}) }),
  mk({ key: "melu", char: "Melu", user: "cuenta2", cls: "dw", status: "on", pid: 102, port: 8792, panel: true, msg: "en el juego", routine: { kind: "hunt" }, role: { role: "golden" }, game: game({ mode: "hunt", doing: "cazando dorados en Devias 3", level: 412, resets: 31, map: "Devias 3", x: 140, y: 88, hp: [900, 2100], expPerMin: 61_000, session: { since: Date.now() - 40 * min, kills: 210, deaths: 2, exp: 2_400_000 } }) }),
  mk({ key: "hume", char: "Hume", user: "cuenta3", cls: "elf", status: "on", pid: 103, port: 8793, panel: true, msg: "en el juego", routine: { kind: "farm" }, role: { role: "explorer" }, game: game({ doing: "explorando Noria (112, 90)", level: 97, resets: 0, map: "Noria", x: 112, y: 90, hp: [700, 760], expPerMin: 22_000, bag: 0.95, session: { since: Date.now() - 20 * min, kills: 88, deaths: 0, exp: 450_000 } }) }),
  mk({ key: "tyrael", char: "Tyrael", user: "cuenta4", cls: "dk", status: "on", pid: 104, port: 8794, panel: true, msg: "en el juego", routine: { kind: "pause" }, role: { role: "support" }, game: game({ mode: "paused", doing: "en pausa", level: 15, resets: 0, map: "Lorencia", x: 130, y: 120, hp: [180, 180], expPerMin: 0, bag: 0.05, session: { since: Date.now() - 8 * min, kills: 0, deaths: 0, exp: 0 } }) }),
  mk({ key: "cinderax", char: "Cinderax", user: "cuenta5", cls: "mg", status: "off", role: { role: "spot", warp: 26 }, roleSaved: false }),
  mk({ key: "lythgard", char: "Lythgard", user: "cuenta6", cls: "elf", status: "failed", account: "blocked", msg: "el server bloqueó la cuenta (AccountBlocked): no la vuelvo a conectar. Consultá a los admins." }),
];

const now0 = Date.now();
const alerts: Alert[] = [
  { id: 9, at: now0 - 20_000, kind: "gold", tone: "good", char: "Hume", text: "Dorado Golden Titan en Noria (101, 77), visto por Hume" },
  { id: 8, at: now0 - 2 * min, kind: "invasion", tone: "warn", char: null, text: "Invasión: 24 monstruos en Devias, Noria" },
  { id: 7, at: now0 - 4 * min, kind: "death", tone: "bad", char: "Melu", text: "Melu murió en Devias 3 (2 en la sesión)" },
  { id: 6, at: now0 - 9 * min, kind: "bagfull", tone: "warn", char: "Hume", text: "Hume tiene la bolsa casi llena" },
  { id: 5, at: now0 - 15 * min, kind: "scout", tone: "good", char: "Hume", text: "Hume vio 1 dorado en Noria" },
  { id: 4, at: now0 - 31 * min, kind: "level", tone: "good", char: "Horaz", text: "Horaz subió a nivel 380" },
  { id: 10, at: now0 - 3 * min, kind: "stuck", tone: "warn", char: "Hume", text: "trabado 6 min: pared en Noria (112, 90) → reintentar otra celda" },
  { id: 3, at: now0 - 48 * min, kind: "pk", tone: "bad", char: "Horaz", text: "PK a 3 casillas de Horaz en Arena 4" },
  { id: 2, at: now0 - 70 * min, kind: "blocked", tone: "bad", char: "Lythgard", text: "La cuenta de Lythgard quedó bloqueada por el server" },
  { id: 1, at: now0 - 95 * min, kind: "status", tone: "good", char: "Horaz", text: "Horaz entró al juego" },
];
const insights = () => [{
  from: "Melu", at: Date.now() - 4 * min, note: "dragón Devias; ladrones Ladron1, Rata",
  dragon: { map: 2, name: "Devias", n: 7, share: 0.71, scope: "hora" },
  hunt: [{ map: 2, name: "Devias", minutes: 220, boxes: 41, factor: 1.25 }, { map: 3, name: "Noria", minutes: 90, boxes: 9, factor: 0.8 }, { map: 1, name: "Dungeon", minutes: 35, boxes: 3, factor: 0.9 }],
  thieves: [{ name: "Ladron1", n: 6 }, { name: "Rata", n: 3 }],
  lethal: [{ map: 3, name: "Noria", cells: ["4,5", "12,3"] }, { map: 2, name: "Devias", cells: ["7,7"] }],
}];
const equipPlan = (at: number) => ({
  at, source: "vivo" as const,
  steps: ["1. Sacar del baúl [4] Great Dragon Helm +9 → bolsa casilla 25", "2. Equipar Great Dragon Helm +9 en Casco", "3. Sacar del baúl [7] Dragon Boots +7 → bolsa casilla 33", "4. Equipar Dragon Boots +7 en Botas"],
  gains: [
    { slot: 2, slotName: "Casco", before: "Bronze Helm +3", after: "Great Dragon Helm +9", scoreBefore: 21, scoreAfter: 58, delta: 37 },
    { slot: 5, slotName: "Botas", before: null, after: "Dragon Boots +7", scoreBefore: 0, scoreAfter: 33, delta: 33 },
    { slot: 0, slotName: "Mano derecha", before: "Katana +4", after: "Katana +4", scoreBefore: 40, scoreAfter: 40, delta: 0 },
  ],
  blocked: [{ name: "Dragon Armor +5", slot: 3, reason: "pide 170 de fuerza y tiene 140" }],
  notes: ["Los anillos se dejan como están."],
  summary: "2 mejoras: +70 de puntaje, 1 pieza bloqueada",
});
const golds = () => [
  { id: 4401, from: "Hume", name: "Golden Titan", mapName: "Noria", x: 101, y: 77, at: Date.now() - 12_000 },
  { id: 4402, from: "Melu", name: "Golden Budge Dragon", mapName: "Devias 3", x: 150, y: 90, at: Date.now() - 41_000 },
];
const scouts = () => [
  { from: "Hume", map: 3, mapName: "Noria", x: 112, y: 90, players: 1, monsters: 52, golds: 1, note: "", at: Date.now() - 12_000 },
  { from: "Hume", map: 2, mapName: "Devias", x: 60, y: 130, players: 7, monsters: 30, golds: 0, note: "", at: Date.now() - 6 * min },
  { from: "Hume", map: 1, mapName: "Dungeon", x: 30, y: 40, players: 3, monsters: 44, golds: 0, note: "", at: Date.now() - 9 * min },
];

function tick() {
  for (const c of chars) {
    if (c.status === "starting" && Date.now() - (c.startedAt ?? 0) > 2500) {
      c.status = "on";
      c.msg = "en el juego";
      const r = c.pending ?? roleRoutine(c.role);
      c.routine = r;
      c.pending = null;
      c.game = game({ mode: r.kind === "pause" ? "paused" : r.kind === "hunt" ? "hunt" : "farm", doing: r.kind === "pause" ? "en pausa" : "entrando al mapa", level: 50, resets: 0, map: "Lorencia", x: 130, y: 120, expPerMin: 0, session: { since: Date.now(), kills: 0, deaths: 0, exp: 0 } });
    } else if (c.status === "stopping") {
      c.status = "off"; c.pid = null; c.game = null; c.panel = false; c.msg = "desconectado";
    } else if (c.status === "on" && c.game && c.game.mode !== "paused") {
      const g = c.game;
      g.hp = [Math.max(100, Math.min(g.hp[1], g.hp[0] + rnd(160) - 70)), g.hp[1]];
      g.x = Math.max(5, Math.min(250, g.x + rnd(3) - 1));
      g.y = Math.max(5, Math.min(250, g.y + rnd(3) - 1));
      if (g.expPerMin) g.expPerMin = Math.max(10_000, g.expPerMin + rnd(8000) - 4000);
      if (g.session) { g.session.kills += rnd(3); g.session.exp += Math.round(g.expPerMin / 30); }
    }
  }
}
setInterval(() => { if (isDemo()) tick(); }, 2000);

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const lines = (k: string) => Array.from({ length: 60 }, (_, i) => {
  const t = new Date(Date.now() - (60 - i) * 4000).toLocaleTimeString("es-AR");
  const pool = ["tick: sin objetivo cerca, avanzo al campamento", "ataque con skill 41 a Budge Dragon", "loot: Jewel of Bless", "aviso: HP bajo, tomo poción", "dorado a la vista: Golden Titan (101, 77)", "camino a Arena 4 (91, 13)", "error: no pude abrir el baúl, reintento", "subí de nivel"];
  return `[${t}] ${k}: ${pool[(i * 7 + k.length) % pool.length]}`;
}).join("\n");

function apply(body: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  const find = () => chars.find((c) => c.key === body.char);
  const c = find();
  const bad = (msg: string, status = 409) => ({ status, body: { ok: false, msg } });
  switch (body.action) {
    case "connect": {
      if (!c) return bad("no conozco a ese personaje", 404);
      if (c.pid) return bad(`${c.char} ya está corriendo`);
      if (chars.some((x) => x !== c && x.pid && x.user === c.user)) return bad(`la cuenta ${c.user} ya está jugando con otro personaje: desconectalo primero`);
      Object.assign(c, { status: "starting", pid: 200 + rnd(99), msg: "conectando…", startedAt: Date.now(), pending: body.routine, panel: true });
      return { status: 200, body: { ok: true, msg: `conectando a ${c.char}… (demo)` } };
    }
    case "disconnect":
      if (!c) return bad("no conozco a ese personaje", 404);
      if (c.pid) { c.status = "stopping"; c.msg = "desconectando…"; }
      return { status: 200, body: { ok: true, msg: `desconectando a ${c.char} (demo)` } };
    case "routine": {
      if (!c) return bad("no conozco a ese personaje", 404);
      if (!c.pid) return bad(`${c.char} no está conectado`);
      const r = body.routine as { kind: string };
      c.routine = r as never;
      if (c.game) {
        c.game.mode = r.kind === "pause" ? "paused" : r.kind === "hunt" ? "hunt" : "farm";
        c.game.doing = r.kind === "pause" ? "en pausa" : r.kind === "hunt" ? "cazando dorados" : "farmeando por la ruta";
      }
      return { status: 200, body: { ok: true, msg: `${c.char}: ${r.kind} (demo)` } };
    }
    case "role": {
      if (!c) return bad("no conozco a ese personaje", 404);
      c.role = body.role as RoleAssign;
      c.roleSaved = true;
      if (c.pid && c.game) { c.game.mode = c.role.role === "golden" ? "hunt" : "farm"; c.game.doing = c.role.role === "golden" ? "cazando dorados" : "farmeando por la ruta"; c.routine = roleRoutine(c.role); }
      return { status: 200, body: { ok: true, msg: `${c.char}: estrategia cambiada (demo)` } };
    }
    case "bot": {
      if (!c) return bad("no conozco a ese personaje", 404);
      if (!c.pid || c.status !== "on") return bad(`${c.char} no está en el juego`);
      const cmd = body.command as { cmd: string; text?: string };
      if (cmd.cmd === "equipplan") { planAt = Date.now(); (c as M & { equipPlan?: unknown }).equipPlan = equipPlan(planAt); return { status: 200, body: { ok: true, msg: "2 mejoras: +70 de puntaje (baúl: vivo; solo mostrado, para ejecutar mandá equip) (demo)" } }; }
      if (cmd.cmd === "equip") { (c as M & { equipPlan?: unknown }).equipPlan = null; return { status: 200, body: { ok: true, msg: "voy a Lorencia a equiparme (demo: no se movió nada)" } }; }
      if (cmd.cmd === "say" && cmd.text === "/pkclear") return { status: 200, body: { ok: true, msg: `${c.char}: /pkclear enviado (demo)` } };
      return bad("pedido inválido", 400);
    }
    case "probe":
      return { status: 200, body: { ok: true, msg: `${body.user}: 2 personajes (demo)`, chars: [{ name: "Viejo", level: 120 }, { name: "Otro", level: 33 }] } };
    case "create":
    case "add": {
      const name = String(body.char);
      if (chars.some((x) => x.key === name.toLowerCase())) return bad(`ya hay un personaje ${name} en la estación`);
      chars.push(mk({ key: name.toLowerCase(), char: name, user: String(body.user), cls: (body.cls as never) ?? null, roleSaved: false, role: roleFromRoutine(null) }));
      return { status: 200, body: { ok: true, msg: `Guardado ${name} (demo: no se registró nada en el server).` } };
    }
  }
  return bad("pedido inválido", 400);
}

export function installMock() {
  if (!isDemo()) return;
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/")) return real(input, init);
    await new Promise((r) => setTimeout(r, 60));
    if (url.pathname === "/api/state") {
      return json({
        chars, golds: golds(), alerts, insights: insights(), scouts: scouts(), now: Date.now(),
        invasion: { status: "active", total: 24, maps: [{ map: 2, name: "Devias", alive: 14 }, { map: 3, name: "Noria", alive: 10 }], at: Date.now(), nextAt: Date.now() + 40 * min },
        events: [{ key: "devilSquare", minutes: 12, opensAt: Date.now() + 12 * min, users: 3, at: Date.now() }, { key: "bloodCastle", minutes: 0, opensAt: null, users: 8, at: Date.now() }, { key: "chaosCastle", minutes: null, opensAt: null, users: 0, at: Date.now() }],
      });
    }
    if (url.pathname.startsWith("/api/log/")) return new Response(lines(url.pathname.split("/").pop()!), { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/api/names") return json({ names: ["Drakmoor", "Sylvane", "Korvath", "Elyndra", "Zaphir", "Morgrim", "Vexalis", "Thornak"] });
    if (url.pathname === "/api/ranking") {
      const names = ["Zeus", "Horaz", "Aquiles", "Melu", "Odin", "Kratos", "Thor", "Loki", "Hera", "Atenea"];
      return json({
        updatedAt: new Date().toISOString(),
        resets: names.map((name, i) => ({ name, classNumber: 4, totalResets: 120 - i * 9, grandResets: i < 2 ? 1 : 0, level: 400 - i * 7 })),
        elo: names.map((name, i) => ({ name, classNumber: 4, elo: 1800 - i * 42, wins: 60 - i * 4, losses: 10 + i * 3 })),
      });
    }
    if (url.pathname === "/api/do" && init?.method === "POST") {
      const r = apply(JSON.parse(String(init.body)));
      return json(r.body, r.status);
    }
    return json({ ok: false, msg: "no existe (demo)" }, 404);
  }) as typeof fetch;
}
