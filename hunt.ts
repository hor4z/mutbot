/**
 * Cacería de dorados: lo más importante del bot. Una invasión dorada (0xFD) con vivos en un mapa al alcance manda al bot
 * ahí (`autoHuntChoice`); al irse los dorados encadena al mejor mapa que quede (`pickHuntMap`, con los datos de la base);
 * un dorado que ve un compañero (`announceGold`, bus.ts) también lo manda. Cazando solo se pega a dorados (dragones primero,
 * `stickyGolden`); sin dorado a la vista va al último visto, a las zonas de dragones de la base o recorre el mapa en celdas.
 * Lo llama farm-loop.ts en cuatro puntos: `huntStep` (arrancar, cortar, viajar), `huntPick` (qué pegar), `huntWander`
 * (a dónde ir sin objetivo) y `onGoldenRequest` (aviso de un compañero).
 */
import { announceGold, teammates, type GoldNotice } from './bus';
import { bandsOf, crewRank } from './crew';
import { trackEvent } from './telemetry';
import { dragonZones, goldenZones, mapsWithZones, nextZone, zoneWeights } from './zones';
import { DRAGON_TYPES, stickyGolden } from './golden';
import { decide, journal, panelLog } from './journal';
import { type LoopCtx, walkTowards, castOnTheWay } from './loop-ctx';
import { AUTO_HUNT, HUNT_MAPS, HuntExplorer, RED_HUNT_MS, autoHuntChoice, huntDryOut, invasionKey, mapName, pickHuntMap, shouldStopHunt } from './panel-logic';
import { WARP_COOLDOWN_MS, warpAndWait, type Warp } from './warps';
import { GOLDEN_TYPES, bot, isGolden, monsterName, world, type ScopedNpc } from './state';
import { isSafeZone, terrainOf, walkableFor } from './terrain';
import { chebyshev, log } from './util';

// Nivel mínimo para salir a cazar: el chequeo de poder (`weak`, stats por detrás del nivel) ya frena al recién reseteado.
const HUNT_MIN_LEVEL = 300;
// Un personaje limitado (stats por detrás del nivel) también sale a la invasión: recorre, avisa lo que ve y solo ataca
// los dorados que su poder aguanta (el resto, como un dragón, queda avisado para el fuerte).
const INFORM_MIN_LEVEL = 150;
const minLevelFor = (weak: boolean) => (weak ? INFORM_MIN_LEVEL : HUNT_MIN_LEVEL);
// Un dorado visto se recuerda 3 min (para volver tras morir); a los compañeros se les avisa como mucho cada 15 s.
const SPOT_TTL_MS = 3 * 60_000;
const SHARE_MS = 15_000;
// El dragón que se le está pegando sale un instante de la vista: se va a donde estaba hasta esto.
const DRAGON_MEMORY_MS = 6_000;
// El aviso "[Mapa] Golden invasion!" vale para esa invasión.
const DRAGON_MAP_TTL_MS = 20 * 60_000;

let lastAutoHuntKey: number | null = null;
let lastRedAt = 0;
let lastDragon: { id: number; x: number; y: number; at: number } | null = null;

/** Los compañeros que cazan en este mapa y mi lugar entre todos (por nombre): el reparto del rastrillaje. */
function huntCrew() {
  const mates = teammates().filter((m) => m.mode === 'hunt' && m.map === world.map);
  return { mates, ...crewRank(bot.charName, mates.map((m) => m.char)) };
}

/** Un dorado común que un compañero tiene más cerca (a <= 6 tiles de él): lo deja a él y busca otro. Los dragones son de todos. */
function claimedByMate(g: { x: number; y: number; type: number }, mates: readonly { x: number; y: number }[]): boolean {
  if (DRAGON_TYPES.has(g.type)) return false;
  const mine = chebyshev(world.x, world.y, g.x, g.y);
  return mates.some((m) => { const d = chebyshev(m.x, m.y, g.x, g.y); return d <= 6 && d < mine; });
}

const freshDragonMap = (now: number) => (bot.dragonMap && now - bot.dragonMap.at < DRAGON_MAP_TTL_MS ? bot.dragonMap.map : null);


const knownMaps = (now: number) => mapsWithZones(HUNT_MAPS.map((x) => x.map), now);
const newHunt = (hunt: (typeof HUNT_MAPS)[number], now: number, extra: Partial<NonNullable<typeof bot.hunting>> = {}) =>
  ({ hunt, since: now, warpTries: 0, nextWarpAt: 0, explorer: new HuntExplorer(), seen: new Set<number>(), ...extra });

export function stopHunt(reason: string) {
  const h = bot.hunting;
  if (!h) return;
  bot.hunting = null;
  bot.retarget = true;
  bot.goalPoint = null;
  // El spot de la cacería no es de la ruta: que la ruta fija decida (adopta el mapa si es el del tramo, si no warpea).
  bot.currentSpot = null;
  bot.canAdopt = true;
  panelLog(`Cacería en ${h.hunt.name} terminada (${reason}): vuelvo a farmear.`);
}

/** Orden manual (panel): cazar en `map` (o el mejor). */
export function startHunt(hunt: (typeof HUNT_MAPS)[number], now = Date.now()) {
  bot.hunting = newHunt(hunt, now);
  bot.retarget = true;
}

/** Un compañero vio un dorado: si puedo con ellos y estoy libre, voy a ese mapa recordando dónde estaba. */
export function onGoldenRequest(r: GoldNotice, weak: boolean) {
  const now = Date.now();
  const spot = { x: r.x, y: r.y, type: r.dragon ? 79 : 0, at: now };
  if (bot.hunting && bot.hunting.hunt.map === r.map) {
    (bot.hunting.spots ??= new Map()).set(-r.at, spot);
    decide(`${r.from} vio ${r.note} en (${r.x},${r.y}): voy.`);
    return;
  }
  // Un dragón es el objetivo principal y muy duro: van todos (con resets son fuertes aunque el nivel sea bajo) y dejan lo que hacen,
  // incluso otra cacería. Un dorado común solo lo atiende el libre, fuerte y de nivel.
  if (bot.resetting || bot.paused) return;
  if (!r.dragon && (bot.hunting || weak || world.level < HUNT_MIN_LEVEL)) return;
  const hm = HUNT_MAPS.find((h) => h.map === r.map);
  if (!hm || world.level < hm.reqLevel) return;
  if (bot.hunting) stopHunt(`${r.from} vio ${r.note}`);
  bot.hunting = newHunt(hm, now, { auto: true, spots: new Map([[-r.at, spot]]) });
  decide(`${r.from} vio ${r.note}: voy a ayudarlo a cazar.`);
}

/** Arrancar, cortar y viajar. true = consumió el tick. */
export async function huntStep(ctx: LoopCtx, weak: boolean): Promise<boolean> {
  const now = Date.now();
  if (!bot.hunting) {
    if (bot.paused || bot.resetting || world.level < minLevelFor(weak)) return false;
    // Dragón Rojo (caja +4): con el aviso del server, a ese mapa a cazarlo (una vez por aviso).
    if (!weak && bot.redDragon && now - bot.redDragon.at < RED_HUNT_MS && lastRedAt !== bot.redDragon.at) {
      lastRedAt = bot.redDragon.at;
      const hm = HUNT_MAPS.find((x) => x.map === bot.redDragon!.map);
      if (hm && world.level >= hm.reqLevel) {
        bot.hunting = newHunt(hm, now, { auto: true, red: true });
        ctx.target = null;
        decide(`Cazador: invasión del Dragón Rojo en ${hm.name}: salgo a cazarlo (${RED_HUNT_MS / 60_000} min).`);
        journal('travel', `cazador: Dragón Rojo en ${hm.name}`, { map: hm.map, reason: 'red-dragon' });
        return true;
      }
    }
    // Invasión dorada con vivos en un mapa al alcance → a cazar, una vez por invasión.
    const ch = autoHuntChoice({ invasion: bot.invasion, level: world.level, now, minLevel: minLevelFor(weak), lastKey: lastAutoHuntKey, dragonMap: freshDragonMap(now), knownMaps: knownMaps(now) });
    if (ch?.ok) {
      lastAutoHuntKey = invasionKey(bot.invasion!);
      bot.hunting = newHunt(ch.hunt, now, { auto: true });
      ctx.target = null;
      decide(`Cazador: invasión dorada con ${ch.alive} vivos en ${ch.hunt.name}${freshDragonMap(now) === ch.hunt.map ? ' (el Golden Dragon está acá)' : ''}: salgo a cazar.`);
      journal('travel', `cazador automático: ${ch.hunt.name}`, { map: ch.hunt.map, alive: ch.alive, reason: 'auto-hunt' });
      return true;
    }
    return false;
  }

  // Cortar a tiempo (0xFD dice pocos vivos, derrotada, 15 min) y encadenar al mejor mapa que quede.
  const h = bot.hunting;
  const stop = h.red
    ? shouldStopHunt({ invasion: null, map: h.hunt.map, since: h.since, now, maxMs: RED_HUNT_MS })
    : shouldStopHunt({ invasion: bot.invasion, map: h.hunt.map, since: h.since, now, stopAlive: h.auto ? AUTO_HUNT.stopAlive : undefined }) ??
      (h.auto && world.map === h.hunt.map
        ? huntDryOut({ invasion: bot.invasion, map: h.hunt.map, lastSeenAt: h.lastSeenAt ?? h.since, now, since: h.since,
            next: pickHuntMap({ invasion: bot.invasion, level: world.level, done: new Set([...(h.done ?? []), h.hunt.map]), knownMaps: knownMaps(now) }) })
        : null);
  if (stop) {
    trackEvent('hunt_end', stop, h.hunt.map, h.seen.size, { map: h.hunt.map, seen: h.seen.size, min: +((now - h.since) / 60_000).toFixed(1), red: !!h.red });
    stopHunt(stop);
    ctx.target = null;
    if (h.auto && !h.red) {
      const done = new Set([...(h.done ?? []), h.hunt.map]);
      const next = pickHuntMap({ invasion: bot.invasion, level: world.level, done, dragonMap: freshDragonMap(now), knownMaps: knownMaps(now) });
      if (next.ok) {
        bot.hunting = newHunt(next.hunt, now, { auto: true, done });
        decide(`Cazador: sigo en ${next.hunt.name} (${next.alive} vivos).`);
        journal('travel', `cazador encadenado: ${next.hunt.name}`, { map: next.hunt.map, alive: next.alive, reason: 'auto-hunt-chain' });
      }
    }
    return true;
  }
  // Llegar al mapa de la cacería (3 intentos, uno cada WARP_COOLDOWN_MS).
  if (world.map !== h.hunt.map) {
    ctx.target = null;
    if (now < h.nextWarpAt) return true;
    if (h.warpTries >= 3) { stopHunt(`no pude llegar a ${h.hunt.name}`); return true; }
    h.warpTries++;
    h.nextWarpAt = now + WARP_COOLDOWN_MS;
    bot.doing = `viajando a ${h.hunt.name} a cazar dorados`;
    const spot: Warp = { index: h.hunt.warp, name: `cacería ${h.hunt.name}`, reqLevel: h.hunt.reqLevel, map: h.hunt.map };
    journal('travel', `warp a ${h.hunt.name} para cazar dorados`, { warp: h.hunt.warp, map: h.hunt.map, reason: 'hunt' });
    await warpAndWait(spot);
    return true;
  }
  return false;
}

/**
 * Cazando: el dorado que corresponde pegar (o null). Anota dónde está cada dorado a la vista y avisa a los compañeros.
 * `walked` = true si el dragón salió de la vista y este tick se fue a donde estaba.
 */
export async function huntPick(ctx: LoopCtx, unreachable: { has(id: number): boolean }, canHit: (type: number) => boolean): Promise<{ gold: ScopedNpc | null; walked: boolean }> {
  const h = bot.hunting!;
  const now = Date.now();
  const { mates } = huntCrew();
  const gold = stickyGolden({ x: world.x, y: world.y }, ctx.target, [...ctx.npcs.values()].filter((n) => !unreachable.has(n.id) && (n.id === ctx.target || !claimedByMate(n, mates))), (t) => GOLDEN_TYPES.has(t) && canHit(t)) as ScopedNpc | null;
  if (gold && DRAGON_TYPES.has(gold.type)) lastDragon = { id: gold.id, x: gold.x, y: gold.y, at: now };
  // No repartir el daño con un común cercano mientras el dragón está fuera de la vista un instante.
  if (lastDragon && (!gold || !DRAGON_TYPES.has(gold.type)) && !ctx.npcs.has(lastDragon.id) && now - lastDragon.at < DRAGON_MEMORY_MS && world.map === h.hunt.map) {
    ctx.target = null;
    ctx.phase = 'walk';
    bot.doing = `cazando: el Golden Dragon salió de la vista, voy a (${lastDragon.x},${lastDragon.y})`;
    await walkTowards(ctx, lastDragon.x, lastDragon.y);
    return { gold: null, walked: true };
  }
  const spots = (h.spots ??= new Map());
  if (world.map === h.hunt.map) {
    for (const n of ctx.npcs.values()) {
      if (!isGolden(n)) continue;
      h.lastSeenAt = now;
      if (!spots.has(n.id)) {
        announceGold(world.map, n.x, n.y, monsterName(n.type), SHARE_MS, DRAGON_TYPES.has(n.type));
        trackEvent('golden_seen', monsterName(n.type), n.type, n.id, { gx: n.x, gy: n.y });
      }
      spots.set(n.id, { x: n.x, y: n.y, type: n.type, at: now });
    }
  }
  if (gold && ctx.target !== gold.id && !h.seen.has(gold.id)) {
    h.seen.add(gold.id);
    panelLog(`Cacería: ${monsterName(gold.type)} a ${chebyshev(world.x, world.y, gold.x, gold.y)} tiles en (${gold.x},${gold.y}).`);
  }
  return { gold, walked: false };
}

/** Cazando sin objetivo: al dorado recordado, a una zona de dragones de la base o recorriendo el mapa en celdas. true = caminó. */
export async function huntWander(ctx: LoopCtx): Promise<boolean> {
  const h = bot.hunting!;
  const now = Date.now();
  // Primero el dorado recordado más cercano (visto hace < 3 min); llegado ahí sin verlo, se olvida.
  let mem: { x: number; y: number } | null = null;
  const { mates, rank, n } = huntCrew();
  if (h.spots && world.map === h.hunt.map) {
    let md = Infinity;
    for (const [id, sp] of h.spots) {
      const d = chebyshev(world.x, world.y, sp.x, sp.y);
      if (now - sp.at > SPOT_TTL_MS || (d <= 4 && !ctx.npcs.has(id))) { h.spots.delete(id); continue; }
      if (claimedByMate(sp, mates)) continue;
      if (d < md) { md = d; mem = sp; }
    }
  }
  if (mem) {
    bot.goalPoint = [mem.x, mem.y];
    bot.doing = `cazando dorados en ${h.hunt.name}: voy al dorado visto en (${mem.x},${mem.y})`;
    ctx.phase = 'walk';
    castOnTheWay(ctx);
    await walkTowards(ctx, mem.x, mem.y);
    return true;
  }
  if (world.map !== h.hunt.map) return false;
  // Sin dorado recordado: la zona de dragones más cercana sin visitar (de la base), después las de cualquier dorado.
  const visited = (h.zonesVisited ??= new Set());
  const dz = dragonZones(world.map);
  let zs = dz.some((z) => !visited.has(`${z.x},${z.y}`)) ? dz : goldenZones(world.map);
  // Lo que pisa un compañero también está visto. Con cuadrilla, cada uno va primero a las zonas de su franja.
  for (const z of zs) if (chebyshev(world.x, world.y, z.x, z.y) <= 6 || mates.some((m) => chebyshev(m.x, m.y, z.x, z.y) <= 6)) visited.add(`${z.x},${z.y}`);
  if (n > 1) {
    const band = bandsOf(zs, n);
    const own = zs.filter((z) => band.get(z) === rank);
    if (own.some((z) => !visited.has(`${z.x},${z.y}`))) zs = own;
  }
  const z = nextZone(zs, { x: world.x, y: world.y }, visited);
  if (z) {
    bot.goalPoint = [z.x, z.y];
    bot.doing = `cazando dorados en ${h.hunt.name}: voy a la zona (${z.x},${z.y}) (${z.n} avistamientos)`;
    ctx.phase = 'walk';
    castOnTheWay(ctx);
    await walkTowards(ctx, z.x, z.y);
    return true;
  }
  // Recorrer el mapa en celdas de 25 tiles: la sin visitar más cercana, primero las que tuvieron dorados.
  if (terrainOf(world.map)) {
    const walk = walkableFor(world.map);
    h.explorer.useTerrain(world.map, walk, (x, y) => walk(x, y) && !isSafeZone(world.map, x, y), { x: world.x, y: world.y }, zoneWeights(world.map, h.explorer.cell, now), undefined);
  }
  h.explorer.setCrew(rank, n);
  for (const m of mates) h.explorer.markSeen(m.x, m.y);
  const g = h.explorer.next(world.x, world.y, now);
  bot.goalPoint = [g.x, g.y];
  bot.doing = `cazando dorados en ${h.hunt.name}: recorro la celda (${g.x},${g.y})`;
  ctx.phase = 'walk';
  castOnTheWay(ctx);
  await walkTowards(ctx, g.x, g.y);
  return true;
}
