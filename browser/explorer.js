/**
 * Explorador (atlas) en el navegador: recorre mapas enteros SIN pelear y anota qué monstruos salen
 * en cada zona, para encontrar spots y dónde aparecen dorados (también fuera de la invasión).
 * Pensado para Melu (Dark Wizard, nivel ~120). Se carga después de bg-timers.js y browser-agent.js
 * (usa __ai.isMonster y __ai.moveTo; el agente queda apagado: __ai.on = false).
 *
 *   __atlas.start()   arrancar (vuelve a empezar cuando termina todos los mapas)
 *   Recorre los mapas buscando spots; durante la invasión dorada (> 25 vivos) interrumpe y busca
 *   dorados en la franja oeste del mapa de la invasión, y después sigue donde estaba.
 *   __atlas.invasionOnly = true: fuera de la invasión espera en Lorencia en vez de recorrer.
 *   __atlas.stop()
 *   __atlas.report()  resumen por mapa y dorados vistos
 *
 * Datos: localStorage `mubot-atlas:<pj>` y, cada minuto, POST al servidor local (/atlas) que lo
 * guarda en ~/.mubot/atlas-<pj>.json. Los dorados también van a /gold (el cazador de Horaz los lee).
 * Pelea solo para medir (no farmea): Evil Spirit contra lo que tenga a <= 5 tiles, hasta 3 kills por
 * tipo y mapa (X.sampleKills); dorados siempre.
 * Durante la invasión: búsqueda pasiva, solo dorados chicos (Goblin, Budge Dragon, Soldier, Vepar,
 * Wheel); los grandes (Golden Dragon, Titan, Lizard King, Tantallos) solo se avisan para Horaz.
 * Seguridad: poción bajo 60 % de vida, se aleja del monstruo más cercano bajo 50 %, y bajo 30 % sin
 * pociones vuelve a Lorencia. No levanta nada.
 */
(() => {
  const S = __store, W = () => __world, ai = window.__ai;
  if (!ai) return 'primero browser-agent.js';
  ai.on = false; W().attackTarget = null; W().castRequest = null;
  const me = S.playerData?.name ?? 'pj';
  const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
  const cellOf = (x, z) => `${Math.floor(x / 25)},${Math.floor(z / 25)}`;
  const KEY = `mubot-atlas:${me}`;
  const atlas = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') ?? { maps: {}, goldens: [] }; } catch { return { maps: {}, goldens: [] }; } })();
  // Limpiar lo anotado antes del filtro de NPCs.
  for (const cells of Object.values(atlas.maps)) for (const c of Object.values(cells)) for (const [t, v] of Object.entries(c)) if (/VIP Seller|Battle Royale|Alquimista/i.test(v.name)) delete c[t];
  atlas.spots = (atlas.spots ?? []).filter((sp) => !/kills en 60 s/.test(sp.note ?? ''));
  atlas.goldens = (atlas.goldens ?? []).filter((g) => g.x > 1 || g.y > 1);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(atlas)); } catch {} };
  // Mapas a recorrer: [warp, índice de mapa, nombre, nivel]. Lista de warps del cliente.
  // Primero los mapas de la ruta de Horaz (usuario: "que explore primero los mapas que usa Horaz para
  // optimizar el farmeo"): Lorencia, Devias (las 4 entradas son el mismo mapa), Arena 2/3/4 según el
  // nivel de Melu. Después el resto.
  const ROUTE = [[2, 0, 'Lorencia', 10], [6, 2, 'Devias', 20], [24, 83, 'Arena 2', 100], [25, 84, 'Arena 3', 200], [26, 85, 'Arena 4', 300],
    [3, 3, 'Noria', 10], [8, 1, 'Dungeon', 30], [14, 4, 'Lost Tower', 50], [11, 7, 'Atlans', 70], [21, 8, 'Tarkan', 140]];
  const MINUTES_PER_MAP = 12;
  if (window.__atlas?.timer) window.clearInterval(window.__atlas.timer);
  if (window.__atlas?.statTimer) window.clearInterval(window.__atlas.statTimer);
  const X = (window.__atlas = { kite: true, kiteMin: 4, kiteMax: 6, kiteSkill: 7, dangerDmgFrac: 0.2, sampleKills: 3, danger: {}, clusterMin: 6, clusterRadius: 5, statShares: { ene: 0.5, vit: 0.35, agi: 0.15 }, invasionOnly: false, invMode: null, startAlive: 25, stopAlive: 20, band: [0, 128], fight: true, fightRange: 5, skill: 9, on: false, idx: 0, mapSince: 0, visited: new Set(), goal: null, goalSince: 0, seenIds: new Set(), lastPot: 0, lastWarp: 0, lastPost: 0, timer: null });

  const potion = () => { const it = S.playerData.items || []; let best = -1, bn = -1; it.forEach((x, i) => { if (x && x.group === 14 && x.num >= 1 && x.num <= 3 && i >= 12 && x.num > bn) { best = i; bn = x.num; } }); return best; };
  const record = (w) => {
    const m = (atlas.maps[w.mapIndex] ??= {});
    for (const e of w.byNetId.values()) {
      // Los NPCs propios del server (VIP Seller, Battle Royale Guard, Alquimista: tipo 692…) tienen 0 de vida.
      if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue;
      const id = `${w.mapIndex}:${e.netId}`, p = e.transform.pos, name = String(e.objectNameInWorld ?? '').trim();
      const c = (m[cellOf(p.x, p.z)] ??= {}), t = (c[e.npcType] ??= { name, seen: 0, last: 0, xy: [Math.round(p.x), Math.round(p.z)] });
      t.last = Date.now();
      if (!X.seenIds.has(id)) {
        X.seenIds.add(id); t.seen++;
        // Dorados de verdad: con vida y posición real (el cliente deja "Gold Warrior" fantasma en (0,0)).
        if (/gold/i.test(name) && (e.attributeSystem?.getValue?.('currentHealth') ?? 0) > 0 && (p.x > 1 || p.z > 1)) {
          const inv = window.__invasion; const g = { map: w.mapIndex, x: Math.round(p.x), y: Math.round(p.z), type: e.npcType, name, at: Date.now(), duringInvasion: inv?.status === 1 && Date.now() - inv.at < 120000 };
          atlas.goldens.push(g); ai.L(`ATLAS: ${name} en ${ROUTE.find((r) => r[1] === w.mapIndex)?.[2] ?? w.mapIndex} (${g.x},${g.y})`);
          fetch('http://127.0.0.1:8787/api/gold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: me, map: g.map, x: g.x, y: g.y, name, id: e.netId & 0xffff, at: g.at }) }).catch(() => {});
        }
      }
    }
  };
  // Cierra la pelea en curso: si el objetivo murió, anota la kill en atlas.fights[mapa][tipo].
  const closeFight = () => {
    const f = X.fightWith; X.fightWith = null; if (!f) return;
    const dead = f.e.dying || (f.e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0;
    const secs = (Date.now() - f.since) / 1000; if (!dead || secs > 120) return;
    const pd = S.playerData, exp = Math.max(0, (pd.exp ?? 0) - f.exp0), lost = Math.max(0, f.hp0 - pd.currentHP);
    const r = ((atlas.fights ??= {})[f.map] ??= {})[f.type] ??= { name: f.name, kills: 0, secs: 0, exp: 0, hpLost: 0 };
    r.kills++; r.secs += secs; r.exp += exp; r.hpLost += lost;
  };
  // Spot automático = grupo denso (usuario: "no debe matar tandas repetidas y deben surgir de lugares
  // muy cercanos"): >= clusterMin monstruos DISTINTOS vivos a la vez dentro de clusterRadius tiles.
  // Se anota el centro del grupo, el tamaño y los tipos; no se repite a <= 10 tiles de otro spot.
  // Identificar monstruos (usuario: "identificá los monstruos, si no la van a matar"): tabla de
  // data/monsters.json (tipo → [nivel, daño máx, vida, visión, nombre, rango de ataque]) + lo medido.
  // Peligroso = daño máx > dangerDmgFrac (20 %; con 12 % no atacaba a nada abajo en Arena 2) de la vida de Melu, o le sacó > 25 % de vida por kill.
  // A los peligrosos no les pega y se aleja si se acercan a menos de su visión + 2.
  const MONS = {"0":[6,20,100,1,"Bull Fighter",0],"1":[9,27,140,1,"Hound",0],"2":[4,13,60,1,"Budge Dragon",0],"3":[2,7,30,1,"Spider",0],"4":[12,36,190,1,"Bull Fighter",0],"5":[38,130,1400,1,"Hell Hound",0],"6":[14,46,255,4,"Lich",2],"7":[17,62,400,2,"Giant",0],"8":[46,150,2500,1,"Bull Fighter",1],"9":[44,145,2000,4,"Thunder Lich",3],"10":[48,155,3000,1,"Dark Knight",0],"11":[32,115,1000,1,"Ghost",0],"12":[25,95,750,1,"Larva",1],"13":[40,135,1600,4,"Hell Spider",11],"14":[19,74,525,1,"Skeleton",0],"15":[34,120,1100,5,"Skeleton Archer",0],"16":[42,140,1800,1,"Elite Skeleton",0],"17":[28,105,850,1,"Cyclops",0],"18":[55,175,6000,1,"Gorgon",0],"19":[30,110,900,4,"Yeti",17],"20":[36,125,1200,1,"Elite Yeti",0],"21":[26,100,800,1,"Assassin",0],"22":[22,85,650,1,"Ice Monster",7],"23":[24,90,700,1,"Hommerd",0],"24":[20,80,600,1,"Worm",0],"25":[52,165,4000,4,"Ice Queen",11],"26":[3,10,45,1,"Goblin",0],"27":[5,17,80,1,"Scorpion",0],"28":[10,31,165,1,"Beetle Monster",0],"29":[13,41,220,4,"Hunter",0],"30":[15,51,295,1,"Forest Monster",0],"31":[16,57,340,1,"Agon",0],"32":[18,68,465,2,"Stone Golem",0],"33":[8,23,120,1,"Elite Goblin",0],"34":[54,170,4000,4,"Cursed Wizard",3],"35":[64,210,6000,1,"Death Gorgon",150],"36":[47,153,2800,1,"Shadow",0],"37":[60,195,5000,4,"Devil",3],"38":[66,240,9000,2,"Balrog",150],"39":[50,160,3500,1,"Poison Shadow",1],"40":[62,200,5500,1,"Death Knight",0],"41":[57,180,4500,1,"Death Cow",0],"42":[147,2500,50000,15,"Red Dragon",150],"43":[15,125,2500,1,"Golden Budge Dragon",0],"44":[60,210,15000,2,"Golden Dragon",150],"45":[43,140,2400,1,"Bahamut",0],"46":[45,145,2800,4,"Vepar",17],"47":[46,150,3200,5,"Valkyrie",0],"48":[70,270,9000,3,"Lizard King",3],"49":[74,310,19000,4,"Hydra",150],"51":[66,230,7000,2,"Great Bahamut",0],"52":[68,260,8000,4,"Silver Valkyrie",7],"53":[53,180,6500,3,"Golden Titan",150],"54":[46,150,5000,5,"Golden Solider",0],"55":[30,110,3500,2,"Death King",0],"56":[24,90,1000,1,"Death Bone",0],"57":[80,330,17000,4,"Iron Wheel",0],"58":[83,385,22000,2,"Tantallos",150],"59":[90,690,34000,5,"Zaikan",150],"60":[76,300,13500,2,"Bloody Wolf",0],"61":[84,425,25000,4,"Vim Knight",17],"62":[72,280,10000,1,"Mutant",0],"63":[93,750,40000,5,"Deathvim Knight",150],"64":[70,250,10000,4,"Orc Archer",0],"65":[74,280,14000,1,"Elite Orc",150],"66":[86,470,32000,4,"Cursed King",150],"67":[77,340,22000,2,"Metal Barlog",150],"69":[67,290,11500,5,"Aquamos",17],"70":[79,350,19000,3,"Queen Rainer",17],"71":[69,320,15000,1,"Mega Crust",0],"72":[96,610,41000,2,"Phantom Knight",150],"73":[86,480,29000,5,"Drakan",150],"74":[92,540,34500,1,"Alpha Crust",0],"75":[100,640,50000,5,"Gaint Drakan",150],"76":[111,960,73000,3,"Dark Phoenix Shield",3],"77":[113,1000,95000,6,"Phoenix of Darkness",150],"78":[20,130,3200,1,"Golden Goblin",0],"79":[80,350,22000,2,"Golden Dragon",150],"80":[83,360,25000,3,"Golden Vepar",3],"81":[61,200,10000,4,"Golden Lizard King",17],"82":[90,560,32000,2,"Golden Tantallos",150],"83":[77,360,15000,4,"Golden wheel",0],"84":[33,120,1100,1,"King Orc",0],"85":[37,130,1400,5,"Orc Archer",0],"86":[41,140,1700,1,"Spirit Soldier",0],"87":[44,150,2100,5,"Spirit Beast",17],"88":[47,160,2800,1,"Spirit Knight",0],"89":[51,180,3700,4,"Spirit Sorcerer",150],"90":[49,170,3500,1,"King Orc",0],"91":[53,180,4100,5,"Orc Archer",0],"92":[56,190,5000,1,"Spirit Soldier",0],"93":[60,210,6000,5,"Spirit Beast",17],"94":[64,220,7000,1,"Spirit Knight",0],"95":[71,240,8000,4,"Spirit Sorcerer",150],"96":[56,180,5000,1,"King Orc",0],"97":[61,200,6500,5,"Orc Archer",0],"98":[66,220,8000,1,"Spirit Soldier",0],"99":[70,240,9500,5,"Spirit Beast",17],"100":[80,110,1000,4,"Lance",0],"101":[80,130,1000,0,"Iron Stick",0],"102":[80,150,1000,2,"Fire",0],"103":[90,190,1000,0,"Meteorite",50],"104":[2,600,50,0,"Trap",50],"105":[80,203,1000,4,"Cannon Trap",0],"106":[80,152,1000,1,"Laser Trap",0],"111":[74,260,12000,1,"Spirit Knight",0],"112":[80,280,15000,4,"Spirit Sorcerer",150],"113":[64,220,7500,1,"King Orc",0],"114":[72,240,9500,5,"Orc Archer",0],"115":[75,260,12000,1,"Spirit Soldier",0],"116":[80,290,15000,5,"Spirit Beast",17],"117":[82,320,18000,1,"Spirit Knight",0],"118":[84,350,24000,4,"Spirit Sorcerer",150],"119":[70,270,12000,1,"King Orc",0],"120":[75,300,15000,5,"Orc Archer",0],"121":[80,340,19000,1,"Spirit Soldier",0],"122":[85,390,23000,5,"Spirit Beast",17],"123":[87,410,26000,1,"Spirit Knight",0],"124":[90,460,32000,4,"Spirit Sorcerer",150],"125":[76,290,17000,1,"King Orc",0],"126":[81,350,20000,5,"Orc Archer",0],"127":[86,420,25000,1,"Spirit Soldier",0],"128":[90,500,32000,5,"Spirit Beast",17],"129":[94,540,38000,1,"Spirit Knight",0],"130":[99,580,47000,4,"Spirit Sorcerer",150],"131":[0,0,2000,0,"Castle gate",0],"132":[0,0,3000,0,"Statue of Saint",0],"133":[0,0,3000,0,"Statue of Saint",0],"134":[0,0,3000,0,"Statue of Saint",0],"135":[87,410,26000,5,"White Wizard",3],"136":[70,240,9500,1,"Destructive soldier",0],"137":[74,260,12000,5,"Destructive archer",0],"138":[85,390,23000,1,"King Orc",0],"139":[87,430,26000,5,"Orc Archer",0],"140":[90,480,32000,1,"Spirit Soldier",0],"141":[93,520,37000,5,"Spirit Beast",17],"142":[98,560,45000,1,"Spirit Knight",0],"143":[102,600,55000,4,"Spirit Sorcerer",150],"144":[34,130,1550,6,"Death Angel",17],"145":[43,150,2300,6,"Death Centurion",17],"146":[32,125,1250,6,"Bloody soldier",17],"147":[27,114,990,1,"Aegis",17],"148":[29,120,1100,2,"Lord centurion",17],"149":[38,140,1950,2,"Necron",17],"150":[52,170,7000,1,"Bali",0],"151":[58,180,9000,4,"Gold Warrior",0],"152":[10,0,50,0,"Magic stone of %s",0],"153":[10,0,50,0,"Magic stone of %s",0],"154":[10,0,50,0,"Magic stone of %s",0],"155":[10,0,50,0,"Magic stone of %s",0],"156":[10,0,50,0,"Magic stone of %s",0],"157":[10,0,50,0,"Magic stone of %s",0],"158":[10,0,50,0,"Magic stone of %s",0],"160":[50,174,3200,6,"Schriker",17],"161":[65,400,15000,10,"Illusion Kundun",150],"162":[30,90,700,1,"Chaos Castle 1",0],"163":[32,100,800,6,"Chaos Castle 2",17],"164":[40,130,1600,1,"Chaos Castle 3",0],"165":[45,150,2700,6,"Chaos Castle 4",17],"166":[54,160,4000,1,"Chaos Castle 5",0],"167":[60,170,5000,6,"Chaos Castle 6",17],"168":[65,190,6500,1,"Chaos Castle 7",0],"169":[68,210,8000,6,"Chaos Castle 8",17],"170":[70,230,10000,1,"Chaos Castle 9",0],"171":[75,250,12500,6,"Chaos Castle 10",17],"172":[76,270,15000,1,"Chaos Castle 11",0],"173":[80,290,18000,6,"Chaos Castle 12",17],"174":[50,170,3200,6,"Death Angel",17],"175":[58,200,4900,6,"Death Centurion",17],"176":[47,160,2700,6,"Bloody soldier",17],"177":[42,150,2050,1,"Aegis",17],"178":[44,155,2350,2,"Lord centurion",17],"179":[53,180,3900,2,"Necron",17],"180":[65,230,8450,6,"Schriker",17],"181":[80,600,30000,10,"Illusion Kundun",150],"182":[65,240,6750,6,"Death Angel",17],"183":[73,310,11600,6,"Death Centurion",17],"184":[62,215,5730,6,"Bloody soldier",17],"185":[57,190,4800,1,"Aegis",17],"186":[59,200,5110,2,"Lord centurion",17],"187":[68,275,8450,2,"Necron",17],"188":[80,355,17500,6,"Schriker",17],"189":[95,800,60000,10,"Illusion Kundun",150],"190":[80,370,17500,6,"Death Angel",17],"191":[88,530,32000,6,"Death Centurion",17],"192":[77,330,14000,6,"Bloody soldier",17],"193":[72,290,10000,1,"Aegis",17],"194":[74,310,11700,2,"Lord centurion",17],"195":[83,420,23000,2,"Necron",17],"196":[95,640,43000,6,"Schriker",17],"197":[110,1000,80000,10,"Illusion Kundun",150],"300":[82,560,20000,1,"Hero Mutant",0],"301":[102,1080,69000,1,"Omega Wing",0],"302":[85,580,23000,1,"Axe Hero",0],"303":[94,850,50000,5,"Gigas Golem",17],"304":[84,410,21200,2,"Witch Queen",150],"305":[74,290,12500,2,"Blue Golem",150],"306":[68,262,8000,2,"Death Rider",150],"307":[64,250,6500,2,"Forest Orc",150],"308":[62,245,6000,2,"Death Tree",150],"309":[98,600,40000,2,"Hell Maine",150],"310":[97,380,25000,2,"Hammer Scout",150],"311":[97,380,25000,2,"Lance Scout",150],"312":[97,380,25000,2,"Bow Scout",150],"313":[118,440,30000,2,"Werewolf",150],"314":[123,510,45000,2,"Scout(Hero)",150],"315":[127,540,50000,2,"Werewolf(Hero)",150],"316":[123,490,35000,2,"Valam",150],"317":[127,490,40000,2,"Solam",150],"331":[114,805,82000,1,"Aegis",17],"332":[117,845,86500,2,"Lord Centurion",17],"333":[118,901,93000,6,"Bloody Soldier",17],"334":[120,950,100000,6,"Death Angel",17],"335":[125,1030,108000,2,"Necron",17],"336":[128,1117,118500,6,"Death Centurion",17],"337":[137,1220,155000,6,"Schriker",17],"338":[140,1600,350000,2,"Relics of Kundun",150],"371":[140,1600,350000,2,"Leo the Helper",150],"375":[140,1600,350000,2,"Chaos Card Master",150],"400":[2,30,50,0,"Marce",0],"401":[2,30,50,0,"Mirazu",0],"428":[93,430,33000,1,"Orc Warrior",0],"429":[95,460,37000,5,"Orc Archer",0],"430":[98,490,42000,1,"Elite Or",0],"431":[101,520,50000,5,"Spirit Beast",17],"432":[105,550,55000,1,"Spirit Knight",0],"433":[111,580,61000,4,"Spirit Sorcerer",150],"434":[40000,400,0,7,"Gigantis\"              98",2],"435":[100,530,45000,2,"Berserk",0],"436":[55000,530,0,7,"Balram (Trainee)\"      134",7],"437":[134,620,60000,4,"Soram (Trainee)",0],"438":[118,560,50000,5,"Persona",0],"439":[119,580,55000,2,"Dreadfear",0],"440":[135,730,65000,6,"Dark Elf",0]};
  X.isDangerous = (e, w) => {
    const pd = S.playerData, t = MONS[e.npcType], f = atlas.fights?.[w.mapIndex]?.[e.npcType];
    if (t && t[1] > pd.maxHP * X.dangerDmgFrac) return `daño ${t[1]}`;
    if (f && f.kills && f.hpLost / f.kills > pd.maxHP * 0.25) return `le sacó ${Math.round(f.hpLost / f.kills)} de vida por kill`;
    return null;
  };
  const markDanger = (w, e, why) => { const d = ((atlas.danger ??= {})[w.mapIndex] ??= {}); if (!d[e.npcType]) { d[e.npcType] = { name: String(e.objectNameInWorld ?? '').trim(), why, at: Date.now() }; save(); ai.L(`ATLAS: ${d[e.npcType].name} es peligroso (${why}): no lo ataco`); } };
  const markCluster = (w, P) => {
    const ms = []; for (const e of w.byNetId.values()) if (ai.isMonster(e) && !e.dying && (e.attributeSystem?.getValue?.('currentHealth') ?? 0) > 0 && dist(P, e.transform.pos) <= 15) ms.push(e);
    let best = null;
    for (const c of ms) { const g = ms.filter((o) => dist(o.transform.pos, c.transform.pos) <= X.clusterRadius); if (!best || g.length > best.length) best = g; }
    if (!best || best.length < X.clusterMin) return;
    const cx = Math.round(best.reduce((a, e) => a + e.transform.pos.x, 0) / best.length), cz = Math.round(best.reduce((a, e) => a + e.transform.pos.z, 0) / best.length);
    const spots = (atlas.spots ??= []); const near = spots.find((sp) => sp.map === w.mapIndex && dist(sp, { x: cx, z: cz }) <= 10);
    // Volver a ver el grupo en otra pasada (>= 30 min después) suma una confirmación: Horaz solo usa
    // spots con historia (atlasMinConfirm, por defecto 3).
    if (near) { const now2 = Date.now(); if (now2 - (near.lastConfirm ?? near.at) >= 30 * 60000) { near.confirmations = (near.confirmations ?? 1) + 1; near.lastConfirm = now2; save(); ai.L(`ATLAS: spot (${near.x},${near.z}) confirmado ${near.confirmations} veces`); } if (best.length > (near.size ?? 0)) near.size = best.length; return; }
    const types = {}; for (const e of best) { const n = String(e.objectNameInWorld ?? '').trim(); types[n] = (types[n] ?? 0) + 1; }
    spots.push({ map: w.mapIndex, x: cx, z: cz, size: best.length, types, at: Date.now(), confirmations: 1, lastConfirm: Date.now(), note: `auto: ${best.length} juntos` });
    save(); ai.L(`ATLAS: spot en (${cx},${cz}): ${best.length} monstruos juntos (${Object.entries(types).map(([n, k]) => `${n}×${k}`).join(', ')})`);
  };
  const nextCell = (w, P) => {
    X.visited.add(cellOf(P.x, P.z));
    const walk = (x, z) => { for (let r = 0; r < 10; r++) for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) if (w.isWalkable(x + dx, z + dz)) return { x: x + dx, z: z + dz }; return null; };
    let best = null, bd = 1e9;
    for (let x = 12; x < 250; x += 25) for (let z = 12; z < 250; z += 25) {
      if (X.visited.has(cellOf(x, z)) || (X.invMode && (x < X.band[0] || x >= X.band[1]))) continue;
      const p = walk(x, z); if (!p) { X.visited.add(cellOf(x, z)); continue; }
      const d = dist(P, p); if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  // Nivel de Melu >= requisito del mapa + 50 en mapas de nivel >= 100 (Arenas): con el mínimo justo la matan.
  const route = () => ROUTE.filter((r) => S.playerData.level >= r[3] + (r[3] >= 100 ? 50 : 0) && (X.danger[r[1]] ?? 0) < 2);
  const nextMap = (why) => {
    if (X.idx + 1 >= route().length) X.danger = {}; // recorrido completo: se vuelve a intentar
    X.idx = (X.idx + 1) % route().length; X.mapSince = 0; X.visited.clear(); X.goal = null; ai.L(`ATLAS: siguiente mapa (${why})`); };

  // Solo con invasión (usuario: "si no hay dorados, ¿para qué vamos a buscar?"): fuera de la invasión
  // espera en Lorencia; a los :50, si un mapa al alcance tiene > startAlive vivos (0xFD), va ahí y
  // barre su franja (oeste; Horaz el este); con <= stopAlive vuelve a Lorencia.
  // 0xFD: estado de la invasión por mapa (mismo hook que hunter.js).
  if (!window.__invHooked) {
    __eventBus.on('InvasionMonsters', (raw) => {
      try {
        const e = raw instanceof DataView ? raw : new DataView(raw.buffer ?? raw);
        const maps = []; const n = e.getUint8(6);
        for (let i = 0; i < n; i++) { const r = 7 + i * 3; if (r + 3 > e.byteLength) break; maps.push({ map: e.getUint8(r), alive: e.getUint16(r + 1, false) }); }
        window.__invasion = { status: e.getUint8(3), total: e.getUint16(4, false), maps, at: Date.now() };
      } catch {}
    });
    window.__invHooked = true;
  }
  const INV_MAPS = ROUTE.filter((r) => [0, 3, 2, 7, 8].includes(r[1]));
  const aliveIn = (m) => window.__invasion?.maps?.find((x) => x.map === m)?.alive ?? 0;
  const invActive = () => window.__invasion?.status === 1 && Date.now() - window.__invasion.at < 120000;
  // Durante la invasión (si un mapa al alcance tiene > startAlive vivos según 0xFD) deja el recorrido,
  // va a ese mapa y barre la franja oeste (Horaz el este); con <= stopAlive o al terminar la invasión,
  // vuelve al recorrido donde lo dejó. Con X.invasionOnly, fuera de la invasión espera en Lorencia.
  X.invasionTick = () => {
    const w = W(), pd = S.playerData, now = Date.now();
    if (X.invMode) {
      if (!invActive() || aliveIn(X.invMode.map) <= X.stopAlive) {
        closeFight(); save(); X.idx = X.invMode.prevIdx; X.visited = X.invMode.prevVisited; X.mapSince = 0; X.goal = null; X.invMode = null;
        if (X.invasionOnly) X.on = false;
        ai.L(X.invasionOnly ? 'ATLAS: sin dorados que buscar → Lorencia a esperar' : 'ATLAS: fin de la búsqueda de dorados → sigo explorando');
      }
      return;
    }
    const best = INV_MAPS.filter((r) => pd.level >= r[3] && aliveIn(r[1]) > X.startAlive).sort((a, b) => aliveIn(b[1]) - aliveIn(a[1]))[0];
    if (invActive() && best && S.uiState === 5) {
      X.invMode = { map: best[1], prevIdx: X.idx, prevVisited: X.visited };
      X.idx = route().findIndex((r) => r[1] === best[1]); X.visited = new Set(); X.on = true; X.mapSince = 0; X.goal = null;
      ai.L(`ATLAS: invasión con ${aliveIn(best[1])} dorados en ${best[2]} → busco (franja oeste)`);
      return;
    }
    if (X.invasionOnly && !X.on && w?.mapIndex !== 0 && now - X.lastWarp > 20000 && S.uiState === 5) { X.lastWarp = now; S.warpCommandRequest(2); }
  };
  X.tick = () => {
    X.invasionTick();
    if (!X.on || S.uiState !== 5 || S.sceneLoading) return;
    const w = W(), pe = w?.playerEntity, pd = S.playerData; if (!pe) return;
    const now = Date.now(), P = pe.transform.pos, hp = pd.currentHP / pd.maxHP;
    // Mapas peligrosos (usuario: "en Arena y otros lugares la van a matar, cuidado"): en mapas que
    // piden nivel >= 50 los umbrales son más altos (poción 75 %, no pelea bajo 70 %, se aleja bajo 60 %)
    // y bajo 40 % se va a Lorencia y el mapa suma un susto. Con 2 sustos (o una muerte) el mapa se saltea
    // hasta el próximo recorrido completo.
    const curReq = ROUTE.find((r) => r[1] === w.mapIndex)?.[3] ?? 0, risky = curReq >= 50;
    const potAt = risky ? 0.75 : 0.6, fightAt = risky ? 0.7 : 0.5, fleeAt = risky ? 0.6 : 0.5;
    if (pd.currentHP <= 0 && !X.deadAt) { X.deadAt = now; X.danger[w.mapIndex] = (X.danger[w.mapIndex] ?? 0) + 2; ai.L(`ATLAS: me mataron en ${ROUTE.find((r) => r[1] === w.mapIndex)?.[2] ?? w.mapIndex}; lo salteo`); }
    if (pd.currentHP > 0) X.deadAt = 0;
    if (risky && hp < 0.4 && pd.currentHP > 0 && now - X.lastWarp > 10000) { X.lastWarp = now; X.danger[w.mapIndex] = (X.danger[w.mapIndex] ?? 0) + 1; S.warpCommandRequest(2); ai.L(`ATLAS: ${Math.round(hp * 100)} % de vida en ${ROUTE.find((r) => r[1] === w.mapIndex)?.[2]} → Lorencia (susto ${X.danger[w.mapIndex]})`); if (X.danger[w.mapIndex] >= 2 && !X.invMode) nextMap('mapa peligroso'); return; }
    if (hp < potAt && now - X.lastPot > 500) { const s = potion(); if (s >= 0) { S.consumeItemRequest(s); X.lastPot = now; } }
    if (hp < 0.3 && potion() < 0) { if (w.mapIndex !== 0 && now - X.lastWarp > 20000) { X.lastWarp = now; S.warpCommandRequest(2); ai.L('ATLAS: poca vida y sin pociones → Lorencia'); } return; }
    const [warp, map, name] = route()[X.idx % route().length];
    if (w.mapIndex !== map) { if (now - X.lastWarp > 15000) { X.lastWarp = now; S.warpCommandRequest(warp); ai.L(`ATLAS: voy a ${name}`); } return; }
    X.mapSince ||= now;
    record(w);
    markCluster(w, P);
    if (!X.invMode && now - X.mapSince > MINUTES_PER_MAP * 60000) return nextMap(`${MINUTES_PER_MAP} min en ${name}`);
    // Pelear lo que tenga cerca (usuario: "hacé que ataque"): Evil Spirit (área) contra el monstruo más
    // cercano a <= fightRange, dorados primero. Mientras pelea no camina; después sigue el recorrido.
    if (X.fight && hp >= fightAt && pd.currentMP / pd.maxMP > 0.1) {
      let tgt = null, td = 99;
      // Durante la invasión, búsqueda pasiva (usuario): ni comunes ni dorados grandes (dragones,
      // Titan, Lizard King, Tantallos: se avisan para Horaz); solo dorados chicos.
      for (const e of w.byNetId.values()) {
        if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0) continue;
        const nm = String(e.objectNameInWorld ?? ''), gold = /gold/i.test(nm);
        if (X.invMode && (!gold || /Golden Dragon|Titan|Lizard|Tantal/i.test(nm))) continue;
        const bad = X.isDangerous(e, w);
        if (bad) {
          markDanger(w, e, bad);
          // Kiting (usuario: "si puede dañar desde lejos está ok"): a los peligrosos cuerpo a cuerpo
          // (rango <= 2) se les tira Ice (frena) desde kiteMin..kiteMax tiles; a los de rango, nada.
          const rng = MONS[e.npcType]?.[5] ?? 1, d0 = dist(P, e.transform.pos);
          if (X.kite && rng <= 2 && d0 >= X.kiteMin && d0 <= X.kiteMax && !X.invMode) { X.kiteTarget = e; }
          continue;
        }
        // Solo prueba de daño, no farmeo (usuario): cada tipo hasta sampleKills kills por mapa.
        if (!gold && (atlas.fights?.[w.mapIndex]?.[e.npcType]?.kills ?? 0) >= X.sampleKills) continue;
        const d = dist(P, e.transform.pos) - (gold ? 3 : 0); if (d < td) { td = d; tgt = e; }
      }
      if (!tgt && X.kiteTarget && !X.kiteTarget.dying) {
        const e = X.kiteTarget; X.kiteTarget = null;
        if (!w.castRequest) { if (S.currentSkill !== X.kiteSkill) S.selectSkill(X.kiteSkill); const tp = e.transform.pos; w.castRequest = { target: e, point: { x: tp.x, y: tp.z }, forced: false }; }
        if (X.fightWith?.e !== e) { closeFight(); X.fightWith = { e, type: e.npcType, name: String(e.objectNameInWorld ?? '').trim(), map: w.mapIndex, since: now, hp0: pd.currentHP, exp0: pd.exp ?? 0 }; }
        return;
      }
      X.kiteTarget = null;
      if (tgt && td <= X.fightRange) {
        // Prueba de daño: cuánto tarda en matar cada tipo, la exp que da y la vida que pierde.
        if (X.fightWith?.e !== tgt) { closeFight(); X.fightWith = { e: tgt, type: tgt.npcType, name: String(tgt.objectNameInWorld ?? '').trim(), map: w.mapIndex, since: now, hp0: pd.currentHP, exp0: pd.exp ?? 0 }; }
        if (!w.castRequest) { if (S.currentSkill !== X.skill) S.selectSkill(X.skill); const tp = tgt.transform.pos; w.castRequest = { target: tgt, point: { x: tp.x, y: tp.z }, forced: false }; }
        return;
      }
    }
    closeFight();
    // Alejarse de un monstruo peligroso que se acerca (a menos de su visión + 2).
    for (const e of w.byNetId.values()) {
      if (!ai.isMonster(e) || e.dying || (e.attributeSystem?.getValue?.('currentHealth') ?? 0) <= 0 || !X.isDangerous(e, w)) continue;
      const q = e.transform.pos, rng = MONS[e.npcType]?.[5] ?? 1, view = X.kite && rng <= 2 ? rng + 2 : (MONS[e.npcType]?.[3] ?? 4) + 2;
      if (dist(P, q) <= view) { markDanger(w, e, X.isDangerous(e, w)); const ax = Math.sign(P.x - q.x) || 1, az = Math.sign(P.z - q.z) || 1; ai.moveTo(pe, { x: Math.round(P.x + ax * (view + 3)), z: Math.round(P.z + az * (view + 3)) }); return; }
    }
    // Alejarse si está perdiendo vida con un monstruo encima.
    if (hp < fleeAt) { let near = null, nd = 99; for (const e of w.byNetId.values()) if (ai.isMonster(e) && !e.dying) { const d = dist(P, e.transform.pos); if (d < nd) { nd = d; near = e; } } if (near && nd <= 6) { const q = near.transform.pos, ax = Math.sign(P.x - q.x) || 1, az = Math.sign(P.z - q.z) || 1; ai.moveTo(pe, { x: Math.round(P.x + ax * 6), z: Math.round(P.z + az * 6) }); return; } }
    if (!X.goal || dist(P, X.goal) < 4 || now - X.goalSince > 45000) {
      if (X.goal) X.visited.add(cellOf(X.goal.x, X.goal.z));
      X.goal = nextCell(w, P); X.goalSince = now;
      if (!X.goal) { if (X.invMode) { X.visited.clear(); return; } return nextMap(`recorrí todo ${name}`); }
    }
    const m = pe.playerMoveTo; if (m.handled || m.point.x !== X.goal.x || m.point.y !== X.goal.z) ai.moveTo(pe, X.goal);
    if (now - X.lastPost > 60000) { X.lastPost = now; save(); fetch('http://127.0.0.1:8788/atlas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: me, atlas }) }).catch(() => {}); }
  };
  X.start = () => { if (X.invasionOnly) { X.on = false; ai.on = false; ai.L('ATLAS: espero la invasión en Lorencia'); return; } X.on = true; X.mapSince = 0; X.visited.clear(); X.goal = null; ai.on = false; ai.L(`ATLAS: arranco (${route().map((r) => r[2]).join(' → ')})`); };
  X.stop = () => { X.on = false; save(); ai.L('ATLAS: paro'); };
  X.report = () => Object.fromEntries(Object.entries(atlas.maps).map(([map, cells]) => {
    const tot = {}; for (const c of Object.values(cells)) for (const [t, v] of Object.entries(c)) { tot[t] ??= { name: v.name, seen: 0 }; tot[t].seen += v.seen; }
    return [ROUTE.find((r) => r[1] === +map)?.[2] ?? map, Object.values(tot).sort((a, b) => b.seen - a.seen).slice(0, 8).map((v) => `${v.name}×${v.seen}`)];
  }));
  X.goldens = () => atlas.goldens.slice(-20);
  X.dangers = () => Object.fromEntries(Object.entries(atlas.danger ?? {}).map(([m, t]) => [ROUTE.find((r) => r[1] === +m)?.[2] ?? m, Object.values(t).map((v) => `${v.name} (${v.why})`)]));
  // Rendimiento por tipo: segundos por kill, exp por kill y por minuto, vida perdida por kill.
  X.fights = () => Object.fromEntries(Object.entries(atlas.fights ?? {}).map(([map, types]) => [ROUTE.find((r) => r[1] === +map)?.[2] ?? map,
    Object.values(types).map((v) => ({ name: v.name, kills: v.kills, segPorKill: +(v.secs / v.kills).toFixed(1), expPorKill: Math.round(v.exp / v.kills), expPorMin: Math.round((v.exp / v.secs) * 60), vidaPorKill: Math.round(v.hpLost / v.kills) })).sort((a, b) => b.expPorMin - a.expPorMin)]));
  // Puntos de Melu (usuario: "subí los stats, aprovechemos todo"): maga que explora y pelea sola con
  // Evil Spirit → energía (daño) 50 %, vitalidad (vida) 35 %, agilidad (defensa) 15 %. El agente de
  // farmeo está apagado (ai.on = false) y no reparte: lo hace el explorador cada vez que junta 50.
  ai.planStats = (pts) => { const sh = X.statShares; const out = []; let left = pts; const ks = Object.keys(sh); ks.forEach((k, i) => { const n = i === ks.length - 1 ? left : Math.floor(pts * sh[k]); left -= n; if (n > 0) out.push([k, n]); }); return out; };
  X.statTimer = window.setInterval(async () => { if (X.distributing || S.uiState !== 5 || (S.playerData.points ?? 0) < 50) return; X.distributing = true; try { await ai.distribute(); } finally { X.distributing = false; } }, 5000);
  (window.__mubotTimers ??= []).push(X.statTimer);
  X.timer = window.setInterval(X.tick, 400);
  (window.__mubotTimers ??= []).push(X.timer);
  return `explorador cargado (${route().map((r) => r[2]).join(', ')}): __atlas.start()`;
})();
