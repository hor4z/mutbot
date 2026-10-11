/**
 * Tests offline del lado bot del panel: 0xFD (invasión dorada), 0x91
 * (aperturas de eventos), validación de órdenes, regla de corte de la cacería,
 * recorrido en celdas, tickets, ciclos y la parte pura de ws-server.ts.
 * Sin red, con reloj simulado.
 *
 *   bun run panel-tests.ts
 */
import { PANEL_COMMANDS, isPanelCommand } from './panel-protocol';
import {
  GoldReporter, HUNT_MAX_MS, HuntExplorer, buildOpeningStateRequest, chooseHuntMap, countTickets, goldSighting,
  goldenTypes, nextInvasionAt, parseInvasion, parseOpeningState, resetsPerDay, shouldStopHunt,
  toPanelCycle, validateWarp,
} from './panel-logic';
import { parseClientMessage, originAllowed, MAX_CLIENT_MESSAGE_BYTES } from './ws-server';
import monstersData from './data/monsters.json';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const MIN = 60_000;
const NOW = new Date(2026, 9, 10, 14, 20, 0).getTime(); // 14:20 hora local

// --- 0xFD: invasión dorada -----------------------------------------------------
{
  // activa, 34 vivos, 3 mapas: Lorencia 5, Devias 2, Noria 27
  const b = Uint8Array.from([0xc1, 16, 0xfd, 1, 0, 34, 3, 0, 0, 5, 2, 0, 2, 3, 0, 27]);
  const inv = parseInvasion(b, NOW)!;
  ok('0xFD: estado activa', inv.status === 'active', inv);
  ok('0xFD: total u16 BE', inv.total === 34, inv.total);
  ok('0xFD: 3 mapas con nombre y vivos',
    inv.maps.length === 3 && inv.maps[2].map === 3 && inv.maps[2].name === 'Noria' && inv.maps[2].alive === 27 && inv.maps[0].name === 'Lorencia',
    inv.maps);
  ok('0xFD: at = ahora', inv.at === NOW);
  ok('0xFD: nextAt = próximo hh:50', inv.nextAt === new Date(2026, 9, 10, 14, 50, 0).getTime(), new Date(inv.nextAt).toString());
  const big = parseInvasion(Uint8Array.from([0xc1, 10, 0xfd, 1, 0x01, 0x2c, 1, 85, 0x01, 0x2c]), NOW)!;
  ok('0xFD: vivos > 255 (u16 BE) y Arena 4', big.total === 300 && big.maps[0].alive === 300 && big.maps[0].name === 'Arena 4', big);
  const def = parseInvasion(Uint8Array.from([0xc1, 7, 0xfd, 2, 0, 0, 0]), NOW)!;
  ok('0xFD: derrotada sin mapas', def.status === 'defeated' && def.total === 0 && def.maps.length === 0, def);
  const short = parseInvasion(Uint8Array.from([0xc1, 12, 0xfd, 1, 0, 9, 3, 0, 0, 5, 2, 0]), NOW)!;
  ok('0xFD: packet corto, solo los mapas que entran', short.maps.length === 1, short.maps);
  ok('0xFD: mapa desconocido → "mapa N"', parseInvasion(Uint8Array.from([0xc1, 10, 0xfd, 1, 0, 1, 1, 50, 0, 1]), NOW)!.maps[0].name === 'mapa 50');
  ok('0xFD: otro code → null', parseInvasion(Uint8Array.from([0xc1, 7, 0x91, 1, 0, 0, 0]), NOW) === null);
  ok('nextInvasionAt a las 14:50 justo → 15:50', nextInvasionAt(new Date(2026, 9, 10, 14, 50, 0).getTime()) === new Date(2026, 9, 10, 15, 50, 0).getTime());
  ok('nextInvasionAt a las 14:55 → 15:50', nextInvasionAt(new Date(2026, 9, 10, 14, 55, 0).getTime()) === new Date(2026, 9, 10, 15, 50, 0).getTime());
}

// --- 0x91: aperturas de eventos -------------------------------------------------
{
  ok('0x91 pregunta DS nivel 1', JSON.stringify([...buildOpeningStateRequest('devilSquare')]) === JSON.stringify([0xc1, 0x05, 0x91, 1, 1]));
  ok('0x91 pregunta CC = tipo 4', buildOpeningStateRequest('chaosCastle')[3] === 4);
  const ds = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 1, 12, 3, 0]), NOW)!;
  ok('0x91 DS: 12 min, 3 jugadores, opensAt', ds.key === 'devilSquare' && ds.minutes === 12 && ds.users === 3 && ds.opensAt === NOW + 12 * MIN, ds);
  const bcOpen = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 2, 0, 0, 0]), NOW)!;
  ok('0x91 BC: 0 = abierto', bcOpen.key === 'bloodCastle' && bcOpen.minutes === 0 && bcOpen.opensAt === NOW, bcOpen);
  const far = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 1, 255, 0, 0]), NOW)!;
  ok('0x91 DS: 255 = lejos → null', far.minutes === null && far.opensAt === null, far);
  const cc = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 4, 0x01, 2, 0x2c]), NOW)!;
  ok('0x91 CC: minutos de 16 bits (b4<<8 | b6) = 300', cc.key === 'chaosCastle' && cc.minutes === 300 && cc.users === 2, cc);
  const ccLow = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 4, 0, 0, 45]), NOW)!;
  ok('0x91 CC: 45 min (solo byte bajo)', ccLow.minutes === 45, ccLow);
  const ccFar = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 4, 0xff, 0, 0xff]), NOW)!;
  ok('0x91 CC: 65535 → null', ccFar.minutes === null, ccFar);
  const cc255 = parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 4, 0, 0, 0xff]), NOW)!;
  ok('0x91 CC: 255 en 16 bits es válido (no es "lejos")', cc255.minutes === 255, cc255);
  ok('0x91 tipo desconocido → null', parseOpeningState(Uint8Array.from([0xc1, 7, 0x91, 3, 5, 0, 0]), NOW) === null);
  ok('0x91 CC sin byte 6 → null', parseOpeningState(Uint8Array.from([0xc1, 6, 0x91, 4, 0, 0]), NOW) === null);
}

// --- isPanelCommand: solo las 5 órdenes con sus campos ----------------------------
{
  ok('PANEL_COMMANDS son 5', PANEL_COMMANDS.length === 5);
  for (const c of [
    { cmd: 'pause' }, { cmd: 'resume' }, { cmd: 'farm' }, { cmd: 'hunt' }, { cmd: 'hunt', map: 3 }, { cmd: 'warp', warp: 26 },
  ]) {
    ok(`acepta ${JSON.stringify(c)}`, isPanelCommand(c));
  }
  const bad: unknown[] = [
    null, undefined, 'pause', 42, [], ['pause'], {},
    { cmd: 'eval' }, { cmd: 'reset' }, { cmd: 'PAUSE' }, { cmd: 'toString' }, { cmd: 'constructor' },
    { cmd: 'pause', extra: 1 }, { cmd: 'farm', code: 'process.exit()' },
    { cmd: 'warp' }, { cmd: 'warp', warp: '26' }, { cmd: 'warp', warp: 1.5 }, { cmd: 'warp', warp: -1 }, { cmd: 'warp', warp: 256 },
    { cmd: 'warp', warp: 2, map: 0 },
    { cmd: 'hunt', map: 'Noria' }, { cmd: 'hunt', map: 300 }, { cmd: 'hunt', map: 3, warp: 3 },
    { cmd: 'hunt', sector: 1 },
    { cmd: 'scout' }, { cmd: 'atlas' },
  ];
  for (const c of bad) ok(`rechaza ${JSON.stringify(c) ?? String(c)}`, !isPanelCommand(c));
}

// --- ws-server: mensajes del panel y origen ------------------------------
{
  const good = parseClientMessage(JSON.stringify({ type: 'command', id: 7, command: { cmd: 'warp', warp: 6 } }));
  ok('ws: orden válida pasa con su id', 'command' in good && good.id === 7 && good.command.cmd === 'warp', good);
  const unk = parseClientMessage(JSON.stringify({ type: 'command', id: 8, command: { cmd: 'eval', code: '1' } }));
  ok('ws: orden desconocida → command-result ok:false con el id', 'reject' in unk && unk.reject?.id === 8, unk);
  const other = parseClientMessage(JSON.stringify({ type: 'hello', id: 9 }));
  ok('ws: otro type → rechazo', 'reject' in other && other.reject?.id === 9, other);
  const junk = parseClientMessage('not json');
  ok('ws: no-JSON → rechazo con id -1', 'reject' in junk && junk.reject?.id === -1, junk);
  const huge = parseClientMessage(JSON.stringify({ type: 'command', id: 1, command: { cmd: 'pause' }, pad: 'x'.repeat(MAX_CLIENT_MESSAGE_BYTES) }));
  ok('ws: > 4 KB se ignora sin contestar', 'reject' in huge && huge.reject === null, huge);
  const bin = parseClientMessage(Buffer.from(JSON.stringify({ type: 'command', id: 2, command: { cmd: 'pause' } })));
  ok('ws: binario con JSON válido también', 'command' in bin && bin.id === 2);

  ok('origen: sin Origin (script local) ok', originAllowed(null, 8787));
  ok('origen: el propio panel ok', originAllowed('http://127.0.0.1:8787', 8787) && originAllowed('http://localhost:8787', 8787));
  ok('origen: otra página no', !originAllowed('https://evil.example', 8787) && !originAllowed('http://127.0.0.1:9999', 8787));

}

// --- Cacería: elegir mapa y regla de corte ----------------------------------------
{
  const inv = parseInvasion(Uint8Array.from([0xc1, 16, 0xfd, 1, 0, 34, 3, 0, 0, 5, 2, 0, 2, 3, 0, 27]), NOW)!;
  const a = chooseHuntMap({ invasion: inv, level: 18 });
  ok('hunt: el mapa con más vivos al alcance (Noria 27)', a.ok && a.hunt.map === 3 && a.hunt.warp === 3 && a.alive === 27, a);
  const b = chooseHuntMap({ invasion: inv, level: 5 });
  ok('hunt: nivel 5 no entra a Noria → Lorencia', b.ok && b.hunt.map === 0 && b.hunt.warp === 2, b);
  const c = chooseHuntMap({ invasion: inv, level: 15, map: 2 });
  ok('hunt: Devias pide nivel 20', !c.ok, c);
  ok('hunt: mapa fuera de la lista se rechaza', !chooseHuntMap({ invasion: inv, level: 400, map: 85 }).ok);
  ok('hunt: sin invasión y sin mapa se rechaza', !chooseHuntMap({ invasion: null, level: 400 }).ok);
  const d = chooseHuntMap({ invasion: null, level: 30, map: 2 });
  ok('hunt: mapa pedido sin 0xFD se acepta (alive null)', d.ok && d.hunt.warp === 6 && d.alive === null, d);

  const since = NOW;
  const at = (s: number, maps: number[][], t: number) => {
    const body = maps.flatMap(([m, n]) => [m, n >> 8, n & 0xff]);
    return parseInvasion(Uint8Array.from([0xc1, 7 + body.length, 0xfd, s, 0, 9, maps.length, ...body]), t)!;
  };
  ok('corte: sin 0xFD sigue', shouldStopHunt({ invasion: null, map: 3, since, now: since + MIN }) === null);
  ok('corte: 15 min', shouldStopHunt({ invasion: null, map: 3, since, now: since + HUNT_MAX_MS }) !== null);
  ok('corte: quedan vivos → sigue', shouldStopHunt({ invasion: at(1, [[3, 4]], since + 1000), map: 3, since, now: since + 2000 }) === null);
  ok('corte: 0 vivos en el mapa → corta', shouldStopHunt({ invasion: at(1, [[3, 0], [2, 5]], since + 1000), map: 3, since, now: since + 2000 }) !== null);
  ok('corte: el mapa ya no figura → 0 vivos → corta', shouldStopHunt({ invasion: at(1, [[2, 5]], since + 1000), map: 3, since, now: since + 2000 }) !== null);
  ok('corte: derrotada → corta', shouldStopHunt({ invasion: at(2, [], since + 1000), map: 3, since, now: since + 2000 }) !== null);
  ok('corte: un 0xFD de antes de empezar no cuenta', shouldStopHunt({ invasion: at(2, [], since - 1000), map: 3, since, now: since + 2000 }) === null);
}

// --- Recorrido en celdas de 25 tiles --------------------------------------------
{
  const h = new HuntExplorer(25, 45_000, 100); // mapa chico: 4×4 celdas
  const g1 = h.next(10, 10, 0);
  ok('celdas: arranca en la celda vecina más cercana, no en la propia', !(g1.x === 12 && g1.y === 12) && Math.max(Math.abs(g1.x - 10), Math.abs(g1.y - 10)) <= 27, g1);
  ok('celdas: mantiene el objetivo hasta llegar', h.next(11, 11, 1000) === h.goal && h.goal!.x === g1.x && h.goal!.y === g1.y);
  const g2 = h.next(g1.x, g1.y, 2000);
  ok('celdas: al llegar elige otra sin visitar', !(g2.x === g1.x && g2.y === g1.y) && h.visited.size === 2, { g2, v: [...h.visited] });
  const g3 = h.next(g1.x, g1.y, 2000 + 46_000);
  ok('celdas: celda inalcanzable en 45 s se da por visitada', h.visited.size === 3 && !(g3.x === g2.x && g3.y === g2.y), { g3, v: [...h.visited] });
  for (let i = 0; i < 40; i++) {
    const g = h.next(h.goal!.x, h.goal!.y, 100_000 + i);
    void g;
  }
  ok('celdas: recorrido todo, vuelve a empezar sin colgarse', h.visited.size >= 1 && h.visited.size <= 16, h.visited.size);
}

// --- Señales de dorados -----------------------------------------------------------
{
  ok('celdas: 10 columnas (12..237)', new HuntExplorer().columns().length === 10);
  const g = { id: 77, x: 140, y: 60, name: 'Golden Goblin' };
  ok('aviso: payload exacto', JSON.stringify(goldSighting('Melu', 3, g, 5)) === JSON.stringify({ from: 'Melu', map: 3, x: 140, y: 60, name: 'Golden Goblin', id: 77, at: 5 }));
  const r = new GoldReporter('Melu');
  const a1 = r.update(3, [g], 1000);
  ok('aviso: dorado nuevo sale ya y es nuevo', a1.length === 1 && a1[0].isNew && (a1[0].payload as { x: number }).x === 140, a1);
  ok('aviso: quieto no repite', r.update(3, [g], 5000).length === 0);
  ok('aviso: se movió (pasaron > 2 s del último aviso) → avisa', r.update(3, [{ ...g, x: 141 }], 5500).length === 1);
  ok('aviso: se movió otra vez a < 2 s → espera', r.update(3, [{ ...g, x: 142 }], 5600).length === 0);
  const a2 = r.update(3, [{ ...g, x: 142 }], 7600);
  ok('aviso: cumplidos 2 s sale la última posición, no nuevo', a2.length === 1 && !a2[0].isNew && (a2[0].payload as { x: number }).x === 142, a2);
  const a3 = r.update(3, [], 8000);
  ok('aviso: murió o salió del scope → gone', a3.length === 1 && JSON.stringify(a3[0].payload) === JSON.stringify({ from: 'Melu', map: 3, id: 77, gone: true, at: 8000 }), a3);
  ok('aviso: gone una sola vez', r.update(3, [], 9000).length === 0);
  r.update(3, [g], 10_000);
  const a4 = r.update(0, [], 11_000);
  ok('aviso: cambio de mapa → gone con el mapa viejo', a4.length === 1 && (a4[0].payload as { map: number }).map === 3, a4);
  r.update(3, [g], 12_000);
  ok('aviso: clear avisa gone de lo pendiente', r.clear(13_000).length === 1 && r.update(3, [], 14_000).length === 0);

}

// --- Tickets, dorados, ciclos, warp ---------------------------------------------
{
  const t = countTickets([
    { group: 14, num: 19, level: 4 }, { group: 14, num: 19, level: 4 }, { group: 14, num: 19, level: 2 },
    { group: 13, num: 18, level: 1 }, { group: 13, num: 29, level: 3 }, { group: 14, num: 11 }, { group: 14, num: 1 },
  ]);
  ok('tickets: invitaciones por nivel, capa, armadura y cajas', t["Devil's Invitation +4"] === 2 && t["Devil's Invitation +2"] === 1 &&
    t['Invisibility Cloak +1'] === 1 && t['Armor of Guardsman'] === 1 && t['Box of Luck'] === 1 && Object.keys(t).length === 5, t);

  const gold = goldenTypes(monstersData as Array<{ Numb: number; Name: string }>);
  ok('dorados: Golden Goblin (78), Golden Titan (53) y Gold Warrior (151)', gold.has(78) && gold.has(53) && gold.has(151), [...gold]);
  ok('dorados: Golden Archer (236, NPC de pueblo) no', !gold.has(236));
  ok('dorados: Goblin común (26) no', !gold.has(26));

  const cur = toPanelCycle({ start: 0, marks: { 20: 1.5, 100: 12 } }, true);
  ok('ciclo actual: min null y marcas con clave string', cur.min === null && cur.marks['100'] === 12, cur);
  const done = [60, 50, 40, 30, 20, 10].map((m, i) => toPanelCycle({ start: i, min: m, marks: {} }));
  ok('resets/día: 1440 / promedio de los últimos 5', resetsPerDay(done) === +(1440 / 30).toFixed(1), resetsPerDay(done));
  const tagged = [...done, { ...toPanelCycle({ start: 9, min: 5, marks: {} }), tag: 'duo' }];
  ok('resets/día: ignora ciclos con tag', resetsPerDay(tagged) === resetsPerDay(done));
  ok('resets/día: sin ciclos → null', resetsPerDay([cur]) === null);

  const spots = [{ index: 2, name: 'Lorencia', reqLevel: 10 }, { index: 26, name: 'Arena 4', reqLevel: 300 }];
  ok('warp: de la ruta y con nivel', validateWarp(26, 350, spots).ok);
  ok('warp: nivel insuficiente', !validateWarp(26, 200, spots).ok);
  ok('warp: fuera de la ruta', !validateWarp(99, 400, spots).ok);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DEL PANEL PASARON' : `\n${fails} TEST(S) DEL PANEL FALLARON`);
process.exit(fails ? 1 : 0);
