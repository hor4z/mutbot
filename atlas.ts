/**
 * Explorador / atlas (--atlas, orden `atlas` del panel), en lógica pura: qué
 * mapas recorrer, cuánto tiempo por mapa y el registro de qué aparece dónde
 * (por mapa → celda de 25 tiles → tipo de monstruo), más los dorados vistos.
 * Fuera de `headless-bot.ts` para testearlo offline (`atlas-tests.ts`) y para
 * que `scripts/atlas-report.ts` lo lea sin arrancar el bot.
 *
 * Nunca pelea: el bot solo mira lo que el server le manda en scope.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HUNT_CELL, mapName } from './panel-logic';

// ---------------------------------------------------------------------------
// Mapas: índices del menú de warp del cliente 0.97d (bundle del cliente web y
// OpenMU; 2026-10-10) con su nivel. Icarus (warp 23, nivel 170) pide alas: no va.
// ---------------------------------------------------------------------------
export type AtlasMap = { map: number; warp: number; reqLevel: number; name: string };
export const ATLAS_WARPS: readonly AtlasMap[] = [
  { map: 0, warp: 2, reqLevel: 10, name: 'Lorencia' },
  { map: 3, warp: 3, reqLevel: 10, name: 'Noria' },
  // Devias 3 (warp 6), igual que la cacería: el que ya se usó en vivo.
  { map: 2, warp: 6, reqLevel: 20, name: 'Devias' },
  { map: 1, warp: 8, reqLevel: 30, name: 'Dungeon' },
  { map: 4, warp: 14, reqLevel: 50, name: 'Lost Tower' },
  { map: 7, warp: 11, reqLevel: 70, name: 'Atlans' },
  { map: 8, warp: 21, reqLevel: 140, name: 'Tarkan' },
];
export const ATLAS_DEFAULT_MAPS: readonly number[] = [0, 3, 2, 1, 4, 7, 8];
export const ATLAS_MINUTES_PER_MAP = 12;
export const ATLAS_SAVE_EVERY_MS = 30_000;
// Lorencia: el lugar seguro al que vuelve con HP crítico y sin pociones.
export const ATLAS_SAFE_MAP = 0;
export const ATLAS_REST_MS = 60_000;
// Huida: con pociones, HP < 50 % y un monstruo a ≤ 6; sin haber podido comprar, antes y más lejos.
export const ATLAS_FLEE = { pct: 0.5, range: 6 } as const;
export const ATLAS_FLEE_CAUTIOUS = { pct: 0.7, range: 8 } as const;
export const ATLAS_CRITICAL_PCT = 0.3;
// Compra antes de salir: hasta tantas pociones (grandes, si no medianas, si no chicas).
export const ATLAS_POTION_TARGET = 40;
// Un dorado con el mismo id en el mismo mapa dentro de esta ventana es el mismo (el server reusa ids).
export const ATLAS_GOLD_DEDUPE_MS = 30 * 60_000;

/**
 * Mapas a recorrer, en orden: los pedidos (o los default) que estén en la tabla
 * de warps y a los que llegue el nivel. Lo que se saltea vuelve con el motivo
 * (para una línea de log).
 */
export function atlasMapList(requested: readonly number[] | null, level: number, table: readonly AtlasMap[] = ATLAS_WARPS): {
  maps: AtlasMap[];
  skipped: { map: number; why: string }[];
} {
  const maps: AtlasMap[] = [];
  const skipped: { map: number; why: string }[] = [];
  const seen = new Set<number>();
  for (const m of requested ?? ATLAS_DEFAULT_MAPS) {
    if (seen.has(m)) continue;
    seen.add(m);
    const w = table.find((x) => x.map === m);
    if (!w) skipped.push({ map: m, why: `${mapName(m)}: no tengo su warp en la tabla` });
    else if (level < w.reqLevel) skipped.push({ map: m, why: `${w.name} pide nivel ${w.reqLevel} (tengo ${level})` });
    else maps.push(w);
  }
  return { maps, skipped };
}

/** `--atlas-maps 0,3,2` → [0, 3, 2]; vacío o inválido → null (los default). */
export function parseAtlasMaps(arg: string | undefined): number[] | null {
  if (!arg) return null;
  const out = arg.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n < 256);
  return out.length ? out : null;
}

/** Regla de tiempo por mapa: pasado el presupuesto (o recorrido el mapa entero), al siguiente. */
export function atlasMapDone(inp: { since: number; now: number; minutes: number; fullPass?: boolean }): string | null {
  if (inp.fullPass) return 'recorrí todas las celdas';
  if (inp.now - inp.since >= inp.minutes * 60_000) return `pasaron ${inp.minutes} min`;
  return null;
}

/** Índice del próximo mapa; al terminar la lista vuelve a empezar (cada vuelta suma datos). */
export const nextAtlasIndex = (idx: number, n: number) => (n <= 0 ? 0 : (idx + 1) % n);

// ---------------------------------------------------------------------------
// Datos del atlas (~/.mubot/atlas.json).
// ---------------------------------------------------------------------------
export type AtlasEntry = { name: string; seen: number; lastSeen: number; sampleXY: [number, number] };
export type AtlasGolden = { map: number; x: number; y: number; type: number; name: string; at: number; duringInvasion: boolean; id: number };
export type AtlasData = {
  version: 1;
  /** mapa → celda "cx,cy" (de 25 tiles) → tipo → entrada */
  maps: Record<string, Record<string, Record<string, AtlasEntry>>>;
  goldens: AtlasGolden[];
};

export const emptyAtlas = (): AtlasData => ({ version: 1, maps: {}, goldens: [] });
export const atlasCellKey = (x: number, y: number, cell = HUNT_CELL) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
export const ATLAS_FILE = join(homedir(), '.mubot', 'atlas.json');

export type AtlasSighting = { map: number; x: number; y: number; id: number; type: number; name: string; golden: boolean; duringInvasion: boolean };

/**
 * El atlas en memoria. `seen` cuenta ids de objeto DISTINTOS por (mapa, celda,
 * tipo) dentro de una visita al mapa: el mismo monstruo visto en cada tick
 * cuenta una vez. `beginVisit` empieza otra visita (otra vuelta = datos nuevos:
 * el server reusa ids al respawnear).
 */
export class Atlas {
  private ids = new Map<string, Set<number>>();
  dirty = false;

  constructor(readonly data: AtlasData = emptyAtlas()) {}

  beginVisit(map: number) {
    for (const k of [...this.ids.keys()]) if (k.startsWith(`${map}|`)) this.ids.delete(k);
  }

  /** Registra lo visto; devuelve el dorado si es un avistamiento nuevo (para el log). */
  observe(s: AtlasSighting, now: number): AtlasGolden | null {
    const cell = atlasCellKey(s.x, s.y);
    const byCell = (this.data.maps[String(s.map)] ??= {});
    const byType = (byCell[cell] ??= {});
    const e = (byType[String(s.type)] ??= { name: s.name, seen: 0, lastSeen: now, sampleXY: [s.x, s.y] });
    const k = `${s.map}|${cell}|${s.type}`;
    let set = this.ids.get(k);
    if (!set) this.ids.set(k, (set = new Set()));
    if (!set.has(s.id)) {
      set.add(s.id);
      e.seen++;
      e.sampleXY = [s.x, s.y];
    }
    e.lastSeen = now;
    e.name = s.name;
    this.dirty = true;
    if (!s.golden) return null;
    const dup = this.data.goldens.some((g) => g.map === s.map && g.id === s.id && g.type === s.type && now - g.at < ATLAS_GOLD_DEDUPE_MS);
    if (dup) return null;
    const g: AtlasGolden = { map: s.map, x: s.x, y: s.y, type: s.type, name: s.name, at: now, duringInvasion: s.duringInvasion, id: s.id };
    this.data.goldens.push(g);
    return g;
  }
}

/** Lee el atlas (archivo roto o de otra forma → vacío, sin tirar). */
export function loadAtlas(path = ATLAS_FILE): AtlasData {
  try {
    if (!existsSync(path)) return emptyAtlas();
    const d = JSON.parse(readFileSync(path, 'utf8'));
    if (!d || typeof d !== 'object' || typeof d.maps !== 'object' || !Array.isArray(d.goldens)) return emptyAtlas();
    return { version: 1, maps: d.maps, goldens: d.goldens };
  } catch {
    return emptyAtlas();
  }
}

/** Escribe entero (tmp + rename: un corte a mitad no deja el archivo roto). Sincrónico: sirve al salir. */
export function saveAtlas(data: AtlasData, path = ATLAS_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** Como mucho una escritura cada ATLAS_SAVE_EVERY_MS (y solo con cambios). */
export class AtlasSaver {
  private lastAt = 0;
  constructor(readonly everyMs = ATLAS_SAVE_EVERY_MS) {}
  due(atlas: Atlas, now: number): boolean {
    if (!atlas.dirty || now - this.lastAt < this.everyMs) return false;
    this.lastAt = now;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Reporte (scripts/atlas-report.ts): por mapa, los tipos más vistos por zona y
// todos los dorados con hora local, ordenados.
// ---------------------------------------------------------------------------
export function formatAtlasReport(d: AtlasData, opts: { top?: number; time?: (ms: number) => string } = {}): string {
  const top = opts.top ?? 5;
  const time = opts.time ?? ((ms: number) => new Date(ms).toLocaleString());
  const out: string[] = [];
  const mapIds = Object.keys(d.maps).map(Number).sort((a, b) => a - b);
  if (!mapIds.length) out.push('Atlas vacío: todavía no se exploró nada.');
  for (const m of mapIds) {
    const cells = d.maps[String(m)];
    const totals = new Map<string, { name: string; seen: number }>();
    for (const byType of Object.values(cells)) {
      for (const [t, e] of Object.entries(byType)) {
        const cur = totals.get(t) ?? { name: e.name, seen: 0 };
        cur.seen += e.seen;
        totals.set(t, cur);
      }
    }
    out.push(`\n== ${mapName(m)} (mapa ${m}): ${Object.keys(cells).length} celda(s) con monstruos ==`);
    const best = [...totals].sort((a, b) => b[1].seen - a[1].seen).slice(0, top);
    out.push(`  más vistos: ${best.map(([t, e]) => `${e.name} [${t}] ×${e.seen}`).join(', ')}`);
    const ranked = Object.entries(cells)
      .map(([cell, byType]) => ({ cell, total: Object.values(byType).reduce((a, e) => a + e.seen, 0), byType }))
      .sort((a, b) => b.total - a.total)
      .slice(0, top);
    for (const r of ranked) {
      const [cx, cy] = r.cell.split(',').map(Number);
      const x0 = cx * HUNT_CELL;
      const y0 = cy * HUNT_CELL;
      const types = Object.entries(r.byType)
        .sort((a, b) => b[1].seen - a[1].seen)
        .slice(0, top)
        .map(([, e]) => `${e.name} ×${e.seen}`)
        .join(', ');
      const last = Math.max(...Object.values(r.byType).map((e) => e.lastSeen));
      out.push(`  zona (${x0}-${x0 + HUNT_CELL - 1}, ${y0}-${y0 + HUNT_CELL - 1}): ${r.total} vistos — ${types} (último ${time(last)})`);
    }
  }
  const golds = [...d.goldens].sort((a, b) => a.map - b.map || a.at - b.at);
  out.push(`\n== Dorados: ${golds.length} ==`);
  for (const g of golds) {
    out.push(`  ${time(g.at)}  ${mapName(g.map)} (${g.x},${g.y})  ${g.name} [${g.type}]${g.duringInvasion ? '  invasión' : '  FUERA de la invasión'}`);
  }
  return out.join('\n').trimStart();
}
