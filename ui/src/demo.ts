/**
 * Modo `?demo` de la vista del personaje: un bot simulado en el navegador (monstruos, dorados, cajas,
 * equipo, bolsa, eventos, chat, diario) para probar y mirar la interfaz sin tocar ningún personaje real.
 * No abre WebSocket ni manda nada a nadie. `?demo=off` arranca "desconectado" para ver ese estado.
 */
import type { EquippedItem, PanelCommand, PanelState } from "../../panel-protocol";

export const demoMode = (): "on" | "off" | null => {
  const q = new URLSearchParams(location.search);
  if (!q.has("demo")) return null;
  return q.get("demo") === "off" ? "off" : "on";
};

const MAP = 85;
// Terreno sintético (256×256, mismo formato de atributos que .att): bordes, muros, laguito y zona segura.
let terrain: Uint8Array | null = null;
export function demoTerrain(): Uint8Array {
  if (terrain) return terrain;
  const t = new Uint8Array(65536);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const out = x < 60 || x > 200 || y < 60 || y > 200;
      const edge = x < 64 || x > 196 || y < 64 || y > 196;
      if (out || edge) t[y * 256 + x] = 12;
    }
  for (let i = 0; i < 26; i++) {
    const cx = 70 + rnd() * 116, cy = 70 + rnd() * 116, r = 2 + rnd() * 5;
    for (let y = -8; y <= 8; y++)
      for (let x = -8; x <= 8; x++) if (x * x + y * y <= r * r) t[Math.round(cy + y) * 256 + Math.round(cx + x)] = 12;
  }
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const d = Math.hypot(x - 150, y - 90);
      if (d < 12 && !(t[y * 256 + x]! & 12)) t[y * 256 + x] = 16;
      if (Math.abs(x - 128) < 9 && Math.abs(y - 128) < 9) t[y * 256 + x] = 1;
    }
  return (terrain = t);
}
const free = (x: number, y: number) => x >= 0 && y >= 0 && x < 256 && y < 256 && !(demoTerrain()[y * 256 + x]! & 12);

const COMMONS = ["Hell Spider", "Dark Knight", "Blood Soldier", "Soldier", "Poison Bull", "Thunder Lich"];
const GOLDS = ["Golden Budge Dragon", "Golden Titan", "Golden Goblin", "Golden Lizard King"];
type Mob = { id: number; x: number; y: number; type: number; name: string; gold: boolean; hp: number };

const EQUIP: EquippedItem[] = [
  { slot: 0, group: 0, num: 18, level: 9, excellent: true, name: "Blade" },
  { slot: 1, group: 6, num: 13, level: 7, excellent: false, name: "Dragon Shield" },
  { slot: 2, group: 7, num: 0, level: 11, excellent: true, name: "Dragon Helm" },
  { slot: 3, group: 8, num: 0, level: 11, excellent: true, name: "Dragon Armor" },
  { slot: 4, group: 9, num: 0, level: 9, excellent: false, name: "Dragon Pants" },
  { slot: 5, group: 10, num: 0, level: 9, excellent: false, name: "Dragon Gloves" },
  { slot: 6, group: 11, num: 0, level: 9, excellent: false, name: "Dragon Boots" },
  { slot: 7, group: 12, num: 4, level: 0, excellent: false, name: "Wings of Spirits" },
  { slot: 9, group: 13, num: 8, level: 3, excellent: false, name: "Pendant of Fire" },
  { slot: 10, group: 13, num: 9, level: 5, excellent: false, name: "Ring of Ice" },
];
const BAG: EquippedItem[] = [
  { slot: 12, group: 14, num: 11, level: 4, excellent: false, name: "Box of Kundun +4", w: 1, h: 1 },
  { slot: 13, group: 14, num: 13, level: 0, excellent: false, name: "Jewel of Bless", w: 1, h: 1 },
  { slot: 14, group: 14, num: 14, level: 0, excellent: false, name: "Jewel of Soul", w: 1, h: 1 },
  { slot: 15, group: 12, num: 15, level: 0, excellent: false, name: "Jewel of Chaos", w: 1, h: 1 },
  { slot: 16, group: 14, num: 3, level: 0, excellent: false, name: "Large Healing Potion", w: 1, h: 1 },
  { slot: 17, group: 14, num: 6, level: 0, excellent: false, name: "Large Mana Potion", w: 1, h: 1 },
  { slot: 20, group: 0, num: 19, level: 0, excellent: true, name: "Excellent Sword", w: 1, h: 3 },
  { slot: 22, group: 8, num: 5, level: 9, excellent: false, name: "Legendary Armor +9", w: 2, h: 2 },
  { slot: 38, group: 6, num: 5, level: 4, excellent: false, name: "Shield", w: 2, h: 2 },
  { slot: 44, group: 14, num: 16, level: 0, excellent: false, name: "Jewel of Life", w: 1, h: 1 },
  { slot: 52, group: 13, num: 10, level: 0, excellent: false, name: "Transformation Ring", w: 1, h: 1 },
  { slot: 55, group: 14, num: 22, level: 0, excellent: false, name: "Jewel of Creation", w: 1, h: 1 },
];

export type DemoSink = {
  state: (s: PanelState) => void;
  log: (text: string, at?: number) => void;
  chat: (c: { at: number; kind: "normal" | "party" | "guild" | "whisper" | "server"; from: string; text: string; mine?: boolean }) => void;
  decisions: (list: { at: number; kind: string; what: string }[]) => void;
  result: (id: number, ok: boolean, msg: string) => void;
};

export function startDemo(sink: DemoSink): { send: (id: number, c: PanelCommand) => void; stop: () => void } {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const t0 = Date.now() - 18 * 60_000;
  let me = { x: 112, y: 112 };
  let level = 372, hp = 5200, mp = 2300, kills = 214, casts = 880, exp = 48_000_000, loot = 31, deaths = 0;
  let paused = false, hunting = false, pinned: string | null = null, spot: string | null = "Arena 4";
  let nextId = 1;
  const mobs: Mob[] = [];
  const spawn = (gold = false): Mob => {
    let x = 0, y = 0;
    do { x = Math.round(me.x + (rnd() - 0.5) * 70); y = Math.round(me.y + (rnd() - 0.5) * 70); } while (!free(x, y));
    const type = gold ? [43, 44, 79, 78][Math.floor(rnd() * 4)]! : 20 + Math.floor(rnd() * 6);
    const name = gold ? (type === 44 ? "Red Dragon" : type === 79 ? "Golden Dragon" : GOLDS[Math.floor(rnd() * GOLDS.length)]!) : COMMONS[type - 20]!;
    return { id: nextId++, x, y, type, name, gold, hp: 1 };
  };
  for (let i = 0; i < 38; i++) mobs.push(spawn());
  for (let i = 0; i < 4; i++) mobs.push(spawn(true));
  mobs.push({ ...spawn(true), type: 79, name: "Golden Dragon", x: 124, y: 98 });
  let drops: { x: number; y: number; name: string; money: boolean; valuable: boolean }[] = [
    { x: 117, y: 109, name: "Box of Kundun +4", money: false, valuable: true },
    { x: 108, y: 116, name: "180 zen", money: true, valuable: false },
  ];
  let target: number | null = mobs[0]!.id;
  const trail: [number, number][] = [];
  let camp: [number, number] | null = [130, 100];
  let bag = [...BAG];
  let doing = "acampando en Arena 4 (112,112)";
  const hz = [{ x: 150, y: 140, n: 4 }, { x: 96, y: 150, n: 2 }];
  const startAt = Date.now();
  const mode = (): PanelState["mode"] => (paused ? "paused" : hp <= 0 ? "dead" : hunting ? "hunt" : "farm");

  function build(now: number): PanelState {
    const rate = Math.round(1_900_000 + Math.sin((now - startAt) / 9000) * 600_000);
    return {
      at: now,
      mode: mode(),
      doing: paused ? "en pausa" : doing,
      char: {
        name: "Hume", cls: "Blade Knight", classId: 6, level, resets: 63, hp: [Math.round(hp), 6400], mp: [Math.round(mp), 2600],
        stats: { str: 28400, agi: 9100, vit: 12200, ene: 4300 }, points: 0, zen: 18_450_000,
      },
      where: { map: MAP, mapName: "Arena 4", x: me.x, y: me.y, spot, pinned: !!pinned },
      exp: { perMin1: paused ? 0 : rate, perMin5: paused ? 0 : Math.round(rate * 0.93) },
      cycle: { start: t0, min: null, marks: { "20": 9, "50": 31, "100": 70, "200": 160, "300": 260 } },
      cycles: [], resetsPerDay: 11.4,
      events: [
        { key: "devilSquare", minutes: 12, opensAt: now + 12 * 60_000, users: 4, at: now },
        { key: "bloodCastle", minutes: 0, opensAt: now, users: 9, at: now },
        { key: "chaosCastle", minutes: null, opensAt: null, users: 0, at: now },
      ],
      invasion: { status: "active", total: 31, maps: [{ map: 0, name: "Lorencia", alive: 5 }, { map: 2, name: "Devias", alive: 12 }, { map: 3, name: "Noria", alive: 14 }], at: now, nextAt: now + 38 * 60_000 },
      tickets: { "Devil's Invitation +4": 2, "Blood Bone +3": 1 },
      nearby: { monsters: mobs.filter((m) => Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) <= 10).length, players: 2 },
      equipment: EQUIP, inventory: bag,
      trail: trail.map((p) => [...p] as [number, number]),
      camp,
      entities: {
        monsters: mobs.map((m) => ({ id: m.id, x: m.x, y: m.y, type: m.type, name: m.name, gold: m.gold, target: m.id === target })),
        players: [{ id: 900, x: me.x + 8, y: me.y - 5, name: "Melu", mate: true }, { id: 901, x: me.x - 22, y: me.y + 14, name: "xKillerx" }],
        drops,
      },
      zones: [{ x: 126, y: 98, n: 7 }, { x: 160, y: 120, n: 3 }],
      hazards: hz,
      squad: [{ name: "Melu", map: MAP, x: me.x + 8, y: me.y - 5, role: "farmer" }, { name: "Scout1", map: MAP, x: 90, y: 90, role: "scout" }],
      skills: [
        { name: "Death Stab", current: true },
        { name: "Rageful Blow", readyAt: now + 2200 },
        { name: "Swell Life", readyAt: now + 41_000 },
        { name: "Twisting Slash", readyAt: now + 900 },
      ],
      session: { since: t0, level0: 366, kills, deaths, casts, exp, loot, skill: "Death Stab" },
    };
  }

  const say = (kind: "normal" | "party" | "guild" | "whisper" | "server", from: string, text: string, mine = false) =>
    sink.chat({ at: Date.now(), kind, from, text, mine });
  const decide = (kind: string, what: string) => sink.decisions([{ at: Date.now(), kind, what }]);

  sink.decisions([
    { at: t0 + 1000, kind: "mode", what: "connecting → farm" },
    { at: t0 + 60_000, kind: "travel", what: "Arena 3 rinde 62M/min y Arena 4 el 91M/min medido → Arena 4 (sin costo)" },
    { at: t0 + 5 * 60_000, kind: "decide", what: "Campamento (112,112) — 9 monstruos juntos y la exp subió un 18 %" },
  ]);
  say("server", "", "[Devias] Golden invasion!");
  say("normal", "Melu", "buenas, voy a Noria");
  say("party", "Melu", "pasame el dorado de la derecha");
  for (const l of ["Conectado al servidor.", "Entré al mundo en Arena 4.", "Spot: Arena 4 (nivel 372)."]) sink.log(l, t0);

  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const now = Date.now();
    if (!paused && hp > 0) {
      // Camina hacia el objetivo (o el campamento) un par de casillas por segundo.
      const t = mobs.find((m) => m.id === target);
      const goal = t ?? { x: camp?.[0] ?? me.x, y: camp?.[1] ?? me.y };
      for (let step = 0; step < 2; step++) {
        const gx = Math.sign(goal.x - me.x), gy = Math.sign(goal.y - me.y);
        if (Math.max(Math.abs(goal.x - me.x), Math.abs(goal.y - me.y)) <= 1) break;
        for (const [sx, sy] of [[gx, gy], [gx, 0], [0, gy]] as const) {
          if ((sx || sy) && free(me.x + sx, me.y + sy)) { me = { x: me.x + sx, y: me.y + sy }; break; }
        }
      }
      if (tick % 2 === 0) { trail.push([me.x, me.y]); if (trail.length > 60) trail.shift(); }
      if (t && Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)) <= 2) {
        casts += 2;
        if (rnd() < 0.55) {
          mobs.splice(mobs.indexOf(t), 1);
          kills++; exp += t.gold ? 3_000_000 : 400_000;
          if (rnd() < 0.2) {
            drops = [...drops.slice(-5), rnd() < 0.5 ? { x: t.x, y: t.y, name: "Jewel of Soul", money: false, valuable: true } : { x: t.x, y: t.y, name: `${Math.round(rnd() * 400)} zen`, money: true, valuable: false }];
          }
          mobs.push(spawn(t.gold && rnd() < 0.5));
          target = mobs.filter((m) => Math.abs(m.x - me.x) < 30)[0]?.id ?? null;
          if (kills % 17 === 0) { level++; say("server", "", `Subiste al nivel ${level}.`); }
          if (kills % 23 === 0 && bag.length < 18) {
            loot++;
            const taken = new Set(bag.flatMap((b) => { const p = b.slot - 12; return Array.from({ length: (b.w ?? 1) * (b.h ?? 1) }, (_, i) => p + (i % (b.w ?? 1)) + Math.floor(i / (b.w ?? 1)) * 8); }));
            const slot = 12 + Array.from({ length: 64 }, (_, i) => i).find((i) => !taken.has(i))!;
            bag = [...bag, { slot, group: 14, num: 14, level: 0, excellent: false, name: "Jewel of Soul", w: 1, h: 1 }];
          }
        }
      }
    }
    for (const m of mobs) if (rnd() < 0.25) {
      const nx = m.x + Math.round(rnd() * 2 - 1), ny = m.y + Math.round(rnd() * 2 - 1);
      if (free(nx, ny)) { m.x = nx; m.y = ny; }
    }
    if (!target || !mobs.some((m) => m.id === target)) target = mobs.find((m) => Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) < 25)?.id ?? null;
    hp = Math.max(1500, Math.min(6400, hp + (rnd() - 0.55) * 400));
    mp = Math.max(300, Math.min(2600, mp + (rnd() - 0.5) * 150));
    if (tick % 40 === 0) decide("decide", "Sigo en Arena 4 — rinde 91M/min y ninguna otra supera a esta en un 15 %");
    if (tick % 70 === 0) sink.log("Skill: Death Stab a un Golden Titan.", now);
    sink.state(build(now));
  }, 1000);
  sink.state(build(Date.now()));

  return {
    send(id, c) {
      const ok = (msg: string) => { sink.result(id, true, msg); decide("command", `${c.cmd}: ${msg}`); };
      switch (c.cmd) {
        case "pause": paused = true; ok("en pausa (demo)"); break;
        case "resume": paused = false; ok("sigo (demo)"); break;
        case "farm": paused = false; hunting = false; pinned = null; spot = "Arena 4"; ok("farmeo normal por la ruta (demo)"); break;
        case "hunt": hunting = true; spot = "cacería Devias"; doing = "cazando dorados en Devias"; ok("cazo dorados (demo)"); break;
        case "warp": pinned = String(c.warp); spot = `spot ${c.warp}`; ok(`voy al warp ${c.warp} (demo)`); break;
        case "say": say("normal", "Hume", c.text, true); sink.result(id, true, "enviado (demo)"); break;
        default: sink.result(id, true, "ok (demo)");
      }
    },
    stop: () => clearInterval(timer),
  };
}
