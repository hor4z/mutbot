/**
 * El mundo según el server: los parsers de los layouts 0.97d que el XML de packets rompe, el
 * tracker que mantiene `world` al día con los packets S2C (vida, skills, inventario, scope de
 * monstruos y jugadores, posición, cambio de mapa, party) y la entrada al mundo (login + elegir
 * personaje). Ver AGENTS.md, "Protocolo: trampas encontradas".
 */
import {
  CharacterLevelUpdatePacket,
  ExperienceGainedPacket,
  ClientReadyAfterMapChangePacket,
  CurrentHealthAndShieldPacket,
  CurrentManaAndAbilityPacket,
  InventoryMoneyUpdatePacket,
  LoginResponseLoginResultEnum,
  LoginResponsePacket,
  MapChanged075Packet,
  MapObjectOutOfScopePacket,
  ObjectMovedPacket,
  ObjectWalked075Packet,
  SelectCharacterPacket,
} from '../packets';
import { CHAR_NAME, PASSWORD, USERNAME } from './config';
import { LoginError, login, requestCharacterList, sendToGS, waitFor } from './connection';
import { drops } from './loot-state';
import { EventBus } from '../net/eventBus';
import { parseHitDamage, parseHitExtended, parsePositionFix } from './protocol097';
import { HpTracker } from './health';
import { learnBlocked } from './terrain';
import { PARTY_DECLINE_DELAY_MS, buildPartyAccept, isObjectMovedPacket, parseInventory, parseItemAdded, parsePartyRequest } from './protocol097';
import { MONSTER_TYPE_NUMBERS, bot, monsterLevel, monsterMaxHp, monsterName, world, type SkillInfo } from './state';
import { log, toBytes } from './util';
import { trackEvent } from './telemetry';

// ---------------------------------------------------------------------------
// Parsers a mano (layouts 0.97d, no los del XML). Los de ítems (5 bytes) están en protocol097.ts.
// ---------------------------------------------------------------------------

// El XML de packets define el CharacterList "Extended" (34 bytes por personaje y
// flags extra), pero un server 0.95/0.97 manda el layout chico: CharacterCount en
// el índice 4, sin UnlockFlags/MoveCnt/IsVaultExtended, y cada CharacterData con
// 26 bytes. Con el parser del XML el acceso desborda, así que lo parseamos a mano.
const CHAR_DATA_097_LENGTH = 26;
const CHAR_LIST_097_HEADER = 5;

export function parseCharacterList097(raw: any) {
  const bytes = toBytes(raw);
  const count = bytes[4];
  const out: Array<{ SlotIndex: number; Name: string; Level: number; ClassId: number | null }> = [];

  for (let i = 0; i < count; i++) {
    const base = CHAR_LIST_097_HEADER + i * CHAR_DATA_097_LENGTH;
    if (base + CHAR_DATA_097_LENGTH > bytes.length) break;
    const nameBytes = bytes.subarray(base + 1, base + 11);
    const nul = nameBytes.indexOf(0);
    out.push({
      SlotIndex: bytes[base],
      Name: new TextDecoder().decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul)),
      Level: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(base + 12, true),
      // Apariencia desde [15] (slot 1 + nombre 10 + 1 + nivel 2 + estado 1): la
      // clase va en los 5 bits altos del primer byte, como deserializeAppearance
      // del cliente (GetByteValue(b, 5, 3)). SIN VERIFICAR en 0.97d: es solo para el panel.
      ClassId: (bytes[base + 15] >> 3) & 0x1f,
    });
  }
  return out;
}

// CharacterInformation del XML es el layout Extended. El server 0.95/0.97 manda el
// layout chico (52 bytes, X/Y en 4/5), así que leemos ese a mano.
export function parseCharacterInformation097(raw: any) {
  const bytes = toBytes(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    x: bytes[4],
    y: bytes[5],
    map: bytes[6],
    exp: view.getUint32(8, true),
    expForNext: view.getUint32(12, true),
    levelUpPoints: view.getUint16(16, true),
    str: view.getUint16(18, true),
    agi: view.getUint16(20, true),
    vit: view.getUint16(22, true),
    ene: view.getUint16(24, true),
    hp: view.getUint16(26, true),
    maxHp: view.getUint16(28, true),
    mana: view.getUint16(30, true),
    maxMana: view.getUint16(32, true),
    money: view.getUint32(40, true),
  };
}

// SkillListUpdate (F3/11): count en byte 4 (0xFE = agregó una, 0xFF = quitó una).
// Los entries empiezan en el offset 6 (el byte 5 es reservado en 0.97d) y son
// de 4 bytes: SkillIndex(1) + SkillNumber(2 LE) + SkillLevel(1).
//
// OJO: createSocket resuelve por code con `find(p => p.SubCode == null ||
// p.SubCode === subCode)`, así que para F3/11 gana el PRIMERO de la lista, que
// es 'SkillAdded'. El evento 'SkillListUpdate' nunca se emite contra este
// server: hay que escucharlo por 'SkillAdded' y deducir el caso del byte Count.
// Bug real encontrado probando un personaje de nivel 1 (pocas/ninguna
// skill): para ese caso el packet llega más corto de lo que getSkills()
// asume (offset 6 + 4 bytes/entry), y Count puede no caer en 0xfe/0xff ni
// matchear cuántas entries realmente caben en el buffer — getSkills()
// intentaba leer fuera de rango y tiraba abajo el proceso entero. Por eso
// clampeamos Count al tamaño real del buffer: fail-safe (mejor una lista de
// skills incompleta que un bot caído), no un fix del protocolo en sí
// (todavía no sabemos cuál es el layout correcto para este caso corto).
// Layout 0.97d (verificado contra el server real, personaje Horaz): Count en
// [4] (0xfe = agregar una, 0xff = quitar una, otro = lista completa) y desde
// [5] entradas de 3 bytes {index, number, level}. El parser generado asume 4
// bytes/entry (layout 1.xs) y leía basura: "skill 259", world.skills vacío.
function readSkillsUpdate(raw: any): { added: SkillInfo[]; removed: SkillInfo[]; full: SkillInfo[] } {
  const b = toBytes(raw);
  if (process.env.MUBOT_DEBUG_SKILLS) log(`SkillAdded raw: ${Buffer.from(b).toString('hex')}`);
  const count = b[4];
  const entry = (i: number): SkillInfo => ({ index: b[i], number: b[i + 1], level: b[i + 2] });
  if (count === 0xfe && b.length >= 8) return { added: [entry(5)], removed: [], full: [] };
  if (count === 0xff && b.length >= 8) return { added: [], removed: [entry(5)], full: [] };
  const safe = Math.min(count, Math.floor((b.length - 5) / 3));
  return { added: [], removed: [], full: Array.from({ length: safe }, (_, k) => entry(5 + k * 3)) };
}

// AddNpcsToScope del XML es el layout Extended; el server 0.95/0.97 manda el
// layout chico (NpcData de 12 bytes, Id BigEndian). Con el parser del XML el
// TypeNumber cae en otro offset y nunca matchea un monstruo, así que el bot
// exploraba sin ver objetivos.
const NPC_DATA_095_LENGTH = 12;

function parseNpcs095(raw: any): Array<{ Id: number; TypeNumber: number; CurrentPositionX: number; CurrentPositionY: number }> {
  const bytes = toBytes(raw);
  const count = bytes[4];
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = 5 + i * NPC_DATA_095_LENGTH;
    if (base + NPC_DATA_095_LENGTH > bytes.length) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    out.push({
      Id: view.getUint16(base, false), // BigEndian
      TypeNumber: bytes[base + 2],
      CurrentPositionX: bytes[base + 6],
      CurrentPositionY: bytes[base + 7],
    });
  }
  return out;
}

// AddCharactersToScope (C2 12): otros jugadores que entran al scope. El
// evento se emite con el nombre 'AddCharactersToScope' (gana el primero de la
// tabla para el code 0x12), pero el layout es el de 0.95d (el server corre el
// inicializador Version095d, igual que AddNpcsToScope095): count en [4] y
// desde [5] CharacterData de 31 bytes (075: 27) con Id BE@0, X@2, Y@3
// (ServerToClientPackets.xml de OpenMU). Solo leemos id y posición: es para
// penalizar objetivos con jugadores cerca. El stride se deduce del largo
// (31 o 27); si no cierra con ninguno, se ignora el packet entero en vez de
// leer basura. SIN VERIFICAR contra el server real.
const CHAR_DATA_095_LENGTH = 31;
const CHAR_DATA_075_LENGTH = 27;
// Nombre: 10 bytes en 14 (formato 075, 27 bytes) o en 18 (095, 31 bytes), según el XML del cliente.
function parseCharacters095(raw: any): Array<{ id: number; x: number; y: number; name: string }> {
  const bytes = toBytes(raw);
  const count = bytes[4];
  if (!count) return [];
  const body = bytes.length - 5;
  const stride = body === count * CHAR_DATA_095_LENGTH ? CHAR_DATA_095_LENGTH : body === count * CHAR_DATA_075_LENGTH ? CHAR_DATA_075_LENGTH : 0;
  if (!stride) {
    if (process.env.MUBOT_DEBUG_NPCS) log(`AddCharactersToScope con layout inesperado (${bytes.length} bytes, count=${count}), lo ignoro.`);
    return [];
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = 5 + i * stride;
    const nameAt = base + (stride === CHAR_DATA_095_LENGTH ? 18 : 14);
    const nb = bytes.subarray(nameAt, nameAt + 10);
    const end = nb.indexOf(0);
    const name = Buffer.from(end >= 0 ? nb.subarray(0, end) : nb).toString('latin1');
    out.push({ id: ((bytes[base] << 8) | bytes[base + 1]) & 0x7fff, x: bytes[base + 2], y: bytes[base + 3], name });
  }
  return out;
}

// NPC amistosos del pueblo (vendedores, guardias): tipos 200-299; los monstruos propios del server, desde 300.
const isTownNpcType = (type: number) => type >= 200 && type <= 299;
const isMonsterType = (type: number, known: ReadonlySet<number>) => !isTownNpcType(type) && (known.has(type) || type >= 300);

// Llegada a un mapa (entrada al mundo o MapChanged).
export function onMapArrival() {
  bot.lastArrivalAt = Date.now();
  log(`Llegada en (${world.x},${world.y}) map=${world.map}.`);
}

// ---------------------------------------------------------------------------
// Tracker de estado: mantiene `world` al día con todo lo que manda el server.
// Es lo que permite que el bot decida solo (pocarse, subir stats, etc.).
// Se engancha una sola vez: los handlers del EventBus sobreviven a la reconexión.
// ---------------------------------------------------------------------------
// Vida de 16 bits que se da vuelta (health.ts): world.hp/maxHp quedan con la vida real estimada.
const hpTracker = new HpTracker();
export function trackWorld() {
  // Exp total: la exp de cada kill suma acá (el panel arma la barra con esto).
  EventBus.on('ExperienceGained', (raw: any) => { world.exp += new ExperienceGainedPacket(raw).AddedExperience; });
  EventBus.on('CharacterLevelUpdate', (raw: any) => {
    const p = new CharacterLevelUpdatePacket(raw);
    world.level = p.Level;
    world.levelUpPoints = p.LevelUpPoints;
    if (p.MaximumHealth) world.maxHp = p.MaximumHealth;
    if (p.MaximumMana) world.maxMana = p.MaximumMana;
  });

  EventBus.on('CurrentHealthAndShield', (raw: any) => {
    const p = new CurrentHealthAndShieldPacket(raw);
    world.hp = hpTracker.feed(p.Health, world.maxHp);
    world.maxHp = hpTracker.maxFor(world.maxHp);
  });

  EventBus.on('CurrentManaAndAbility', (raw: any) => {
    const p = new CurrentManaAndAbilityPacket(raw);
    world.mana = p.Mana;
  });

  // F3/11 trae la lista completa, un alta (Count=0xFE) o una baja (0xFF).
  // Según la tabla de rutas se emite con uno u otro nombre; el cliente web
  // engancha el mismo handler a los tres, así que hacemos lo mismo.
  const onSkills = (raw: any) => {
    const { added, removed, full } = readSkillsUpdate(raw);
    if (full.length || (!added.length && !removed.length)) {
      world.skills.clear();
      for (const s of full) world.skills.set(s.number, s);
    }
    for (const s of added) world.skills.set(s.number, s);
    for (const s of removed) world.skills.delete(s.number);
    log(`Skills: ${[...world.skills.values()].map((s) => `${s.number}@${s.index}`).join(', ') || 'ninguno'}`);
  };
  for (const ev of ['SkillListUpdate', 'SkillAdded', 'SkillRemoved']) EventBus.on(ev, onSkills);

  EventBus.on('CharacterInventory', (raw: any) => {
    const items = parseInventory(toBytes(raw));
    if (!items) {
      log(`AVISO: inventario con layout inesperado (${toBytes(raw).length} bytes), lo ignoro.`);
      return;
    }
    world.inventory.clear();
    for (const it of items) world.inventory.set(it.slot, it);
    log(`Inventario: ${world.inventory.size} item(s)${world.inventory.size <= 12 ? ' [' + [...world.inventory.values()].map((i) => `slot ${i.slot}: ${i.group}/${i.num}${i.level ? ' +' + i.level : ''}`).join(', ') + ']' : ''}.`);
  });

  // Tirar un ítem: ItemDropResponse (C1 23: éxito en @3) y ItemRemoved (C1 28: casilla en @3). Se quita de la bolsa lo que el server confirma.
  EventBus.on('ItemDropResponse', (raw: any) => {
    const b = toBytes(raw);
    log(`Tirar ítem: respuesta ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
    if (b[3] === 1 && world.pendingDrop != null) world.inventory.delete(world.pendingDrop);
    world.pendingDrop = null;
  });
  EventBus.on('ItemRemoved', (raw: any) => {
    const b = toBytes(raw);
    log(`Ítem quitado de la casilla ${b[3]}`);
    world.inventory.delete(b[3]);
  });

  // Compra a un NPC: C1 len 32 <casilla> <ítem>; la misma forma que levantar un ítem. FF = no se pudo.
  EventBus.on('ItemBought' as any, (raw: any) => {
    const b = toBytes(raw);
    log(`Compra: ${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`);
    const it = b[3] === 0xff ? null : parseItemAdded(b);
    if (it) world.inventory.set(it.slot, it);
  });

  EventBus.on('ItemAddedToInventory', (raw: any) => {
    const b = toBytes(raw);
    // Zen levantado: C3 08 22 FE <zen total u32 BE> (no llega InventoryMoneyUpdate). FF = no se pudo.
    if (b[3] === 0xfe && b.length >= 8) {
      bot.lastMoney = ((b[4] << 24) >>> 0) + (b[5] << 16) + (b[6] << 8) + b[7];
      return;
    }
    if (b[3] === 0xff) return;
    const it = parseItemAdded(b);
    if (it) world.inventory.set(it.slot, it);
  });

  // El server re-sincroniza nuestra posición acá (rubber-band) cuando rechaza
  // un movimiento. Sin esto el dead-reckoning queda desfasado para siempre.
  //
  // OJO con el nombre del evento: createSocket resuelve el packet por code y
  // emite pDef.Name. El code 0x10 de 0.97d es ObjectWalked075; ObjectWalked es
  // el 0xD4 de seasons modernas y NUNCA se emite contra este server. Escuchar
  // 'ObjectWalked' dejaba al bot sin resync para siempre.
  EventBus.on('ObjectWalked075', (raw: any) => {
    const p = new ObjectWalked075Packet(raw);
    const id = p.ObjectId & 0x7fff;
    if (id === bot.playerId) {
      if (p.TargetX !== world.x || p.TargetY !== world.y) {
        log(`Resync del server: creía (${world.x},${world.y}), real (${p.TargetX},${p.TargetY})`);
      }
      world.x = p.TargetX;
      world.y = p.TargetY;
      return;
    }
    // Bug real encontrado jugando (cuenta horaz, nivel 48): un monstruo
    // detectado por AddNpcsToScope quedaba con su posición CONGELADA para
    // siempre, porque este handler solo actualizaba la posición del jugador.
    // El bot entonces perseguía la última posición conocida del monstruo,
    // que ya se había movido — 0 kills a pesar de "ver" monstruos todo el
    // tiempo. Se arregla actualizando también la posición de cualquier NPC
    // ya trackeado en world.npcs.
    const npc = world.npcs.get(id);
    if (npc) {
      npc.x = p.TargetX;
      npc.y = p.TargetY;
    }
    const pl = world.players.get(id);
    if (pl) {
      pl.x = p.TargetX;
      pl.y = p.TargetY;
    }
  });

  // ObjectMoved (0x15): "un objeto se movió instantáneamente" (teleport/salto,
  // no caminata) — mismo problema de posición congelada que ObjectWalked075 si
  // no se trackea para NPCs ya vistos.
  //
  // OJO: a diferencia de ObjectWalked075 (verificado a fondo, es la única
  // fuente de la posición del JUGADOR), este packet NO se usa para actualizar
  // world.x/y del jugador — apareció 367 veces en una corrida de 130s (mucho
  // más que los pasos propios) y una corrida terminó con "posición final
  // (0,0)", probablemente por confiar en este packet para el jugador sin
  // verificarlo. Conservador: solo actualiza NPCs ya trackeados, nunca al
  // jugador, hasta confirmar el campo/formato con más cuidado.
  // 0x11 de 8 bytes: "estás en (x, y)" (ver parsePositionFix). Con el id propio, corrige la
  // posición del bot (si no, cada paso salía de una posición equivocada y el server lo rechazaba);
  // con otro id, la de ese monstruo o jugador.
  let lastFixLog = 0;
  let hitRawLogged = 0;
  EventBus.on('ObjectHit', (raw: any) => {
    // ObjectHitExtended (16 bytes): la vida que le queda al blanco, en fracciones de 1/250 (la barra roja del cliente).
    const h = parseHitExtended(toBytes(raw));
    if (h) {
      // Layout sin verificar contra bytes reales: los primeros paquetes quedan en el log para confirmarlo.
      if (hitRawLogged++ < 6) log(`Hit extendido raw: ${Buffer.from(toBytes(raw)).toString('hex')}: id=${h.id} vida=${h.healthStatus}/250 daño=${h.damage}`);
      if (world.npcs.has(h.id)) {
        const prev = world.hits.get(h.id);
        world.hits.set(h.id, { pct: Math.max(0, Math.min(100, Math.round((h.healthStatus / 250) * 100))), dealt: (prev?.dealt ?? 0) + h.damage, at: Date.now() });
      }
      return;
    }
    const f = parsePositionFix(toBytes(raw));
    if (!f) return;
    if (f.id === (bot.playerId & 0x7fff)) {
      // El tile que creíamos alcanzado no se puede pisar: queda bloqueado para los caminos.
      if (world.x !== f.x || world.y !== f.y) learnBlocked(world.map, world.x, world.y);
      if ((world.x !== f.x || world.y !== f.y) && Date.now() - lastFixLog > 10_000) {
        lastFixLog = Date.now();
        log(`Posición corregida por el server: de (${world.x},${world.y}) a (${f.x},${f.y}).`);
      }
      world.x = f.x;
      world.y = f.y;
      return;
    }
    const o = world.npcs.get(f.id) ?? world.players.get(f.id);
    if (o) {
      o.x = f.x;
      o.y = f.y;
    }
  });

  EventBus.on('ObjectMoved', (raw: any) => {
    if (!isObjectMovedPacket(toBytes(raw))) {
      // 0.97d: con 10 bytes es el daño de un golpe; sirve para estimar la vida si el server no manda la barra.
      const d = parseHitDamage(toBytes(raw));
      if (d && world.npcs.has(d.id)) {
        const prev = world.hits.get(d.id);
        world.hits.set(d.id, { pct: prev?.pct ?? null, dealt: (prev?.dealt ?? 0) + d.damage, at: Date.now() });
      }
      return;
    }
    const p = new ObjectMovedPacket(raw);
    const id = p.ObjectId & 0x7fff;
    if (id === bot.playerId) return;
    const npc = world.npcs.get(id);
    if (npc) {
      npc.x = p.PositionX;
      npc.y = p.PositionY;
    }
    const pl = world.players.get(id);
    if (pl) {
      pl.x = p.PositionX;
      pl.y = p.PositionY;
    }
  });

  // Scope de NPCs: se registra al entrar al mundo, NO al arrancar el loop. El
  // server manda el scope inicial (y el del mapa nuevo tras /move) antes de que
  // el loop exista; enganchar tarde = bot ciego a los monstruos.
  const npcs = world.npcs;
  const ignoredSeen = new Set<number>();
  const onAdd = (raw: any) => {
    for (const n of parseNpcs095(raw)) {
      // MUBOT_DEBUG_NPCS=1: loguea todo tipo que aparezca, pase o no el filtro
      // (así se vieron los custom 690/692 que monsters.json no conoce).
      const isMonster = isMonsterType(n.TypeNumber, MONSTER_TYPE_NUMBERS);
      if (process.env.MUBOT_DEBUG_NPCS) {
        log(`NPC en scope (debug): Id=${n.Id} tipo=${n.TypeNumber} monstruo=${isMonster} en (${n.CurrentPositionX},${n.CurrentPositionY})`);
      }
      if (!isMonster) {
        // Lo que no se reconoce como monstruo ni NPC del pueblo se ignora: se avisa una vez por tipo para ver si el radar se pierde monstruos.
        if (!isTownNpcType(n.TypeNumber) && !ignoredSeen.has(n.TypeNumber)) {
          ignoredSeen.add(n.TypeNumber);
          log(`NPC ignorado: tipo ${n.TypeNumber} en (${n.CurrentPositionX},${n.CurrentPositionY}): no está en la tabla de monstruos ni es del pueblo.`);
        }
        if (isTownNpcType(n.TypeNumber)) {
          const tid = n.Id & 0x7fff;
          world.townNpcs.set(tid, { id: tid, type: n.TypeNumber, x: n.CurrentPositionX, y: n.CurrentPositionY });
        }
        continue;
      }
      // Bug real (cuenta horaz, nivel 48, 22 monstruos detectados, 0 kills):
      // n.Id viene CRUDO (con el bit alto de "vivo" puesto, ej. 33356), pero
      // HitRequest.TargetId necesita el id real sin ese bit — el server hace
      // `currentMap.GetObject(message.TargetId)` con el id exacto (confirmado
      // en HitHandlerPlugInBase.cs de OpenMU) y no lo encuentra si mandamos el
      // crudo, así que el golpe no hace nada (ni error ni log del lado
      // server, falla en silencio). El resto del código SIEMPRE enmascara con
      // `& 0x7fff` (onRemove, onKilled, ObjectWalked075) — acá faltaba, y
      // además por eso `onRemove` nunca lograba borrar estos NPCs del mapa
      // (comparaba contra una clave que nunca existía).
      const id = n.Id & 0x7fff;
      const isNew = !npcs.has(id);
      npcs.set(id, { id, type: n.TypeNumber, x: n.CurrentPositionX, y: n.CurrentPositionY });
      // El tipo de cada id visto: cuando llega ExperienceGained el monstruo ya
      // salió del scope (ver farming.ts, ExpSplitTracker).
      if (isNew) {
        log(`Monstruo en scope: Id=${id} tipo=${n.TypeNumber} en (${n.CurrentPositionX},${n.CurrentPositionY})`);
        noteMonsterSeen(n.TypeNumber, n.CurrentPositionX, n.CurrentPositionY);
      }
    }
  };
  const onRemove = (raw: any) => {
    const p = new MapObjectOutOfScopePacket(raw);
    for (const o of p.getObjects()) {
      npcs.delete(o.Id & 0x7fff);
      world.townNpcs.delete(o.Id & 0x7fff);
      world.players.delete(o.Id & 0x7fff);
    }
  };
  EventBus.on('AddNpcsToScope', onAdd);
  // Otros jugadores: solo id y posición (ver parseCharacters095).
  EventBus.on('AddCharactersToScope', (raw: any) => {
    for (const c of parseCharacters095(raw)) {
      if (c.id === bot.playerId) continue;
      world.players.set(c.id, { x: c.x, y: c.y, name: c.name });
    }
  });
  EventBus.on('MapObjectOutOfScope', onRemove);

  // Cambiar de mapa: hay que confirmarlo con ClientReadyAfterMapChange (F3/12)
  // o el server nos cuelga en el limbo. El evento que se emite es
  // 'MapChanged075' (code 0x1C sin subcode), no 'MapChanged' (que espera 0x1C/0x15).
  EventBus.on('MapChanged075', (raw: any) => {
    const p = new MapChanged075Packet(raw);
    world.map = p.MapNumber;
    world.x = p.PositionX;
    world.y = p.PositionY;
    log(`Cambio de mapa: map=${world.map} pos=(${world.x},${world.y})`);
    // Lo que había en scope era del mapa viejo: si no se limpia, el bot
    // persigue NPCs y drops que ya no existen (el server no manda el remove).
    world.npcs.clear();
    world.hits.clear();
    world.townNpcs.clear();
    world.players.clear();
    drops.clear();
    sendToGS(ClientReadyAfterMapChangePacket.createPacket().buffer);
    // Punto de llegada (correa de Devias) y primer campamento (camp.ts).
    onMapArrival();
  });

  // Reaparición tras morir (C1 F3 04, formato 075: X @4, Y @5, mapa @6). Sin esto el bot seguía
  // creyendo que estaba donde murió: caminaba desde ahí, el server le rechazaba los pasos y en el
  // panel quedaba congelado (Hume, 2026-10-12: murió en el Lich y el panel lo mostraba ahí, ya en el pueblo).
  EventBus.on('RespawnAfterDeath075', (raw: any) => {
    const b = toBytes(raw);
    if (b.length < 7) return;
    const [x, y, map] = [b[4], b[5], b[6]];
    const changed = map !== world.map;
    world.map = map;
    world.x = x;
    world.y = y;
    log(`Reaparezco en map=${map} pos=(${x},${y}).`);
    if (changed) {
      world.npcs.clear();
      world.hits.clear();
      world.townNpcs.clear();
      world.players.clear();
      drops.clear();
    }
    onMapArrival();
  });

  // Invitaciones a party: se aceptan siempre (el usuario quiere party). Con un respiro humano.
  EventBus.on('PartyRequest', (raw: any) => {
    const id = parsePartyRequest(toBytes(raw));
    if (id == null) return;
    const [lo, hi] = PARTY_DECLINE_DELAY_MS;
    setTimeout(() => {
      sendToGS(new DataView(buildPartyAccept(id).buffer));
      log(`Party aceptada (de ${world.players.get(id)?.name ?? '#' + id}).`);
    }, lo + Math.random() * (hi - lo));
  });
  for (const ev of ['PartyList', 'PartyList075']) EventBus.on(ev, () => { if (!bot.inParty) trackEvent('party', 'join'); bot.inParty = true; });
  EventBus.on('RemovePartyMember', () => { if (bot.inParty) trackEvent('party', 'leave'); bot.inParty = false; });
}

// --- Zen -----------------------------------------------------------
// El bot no compra ni vende (pedido del usuario): solo lleva el zen para el panel.
export function watchMoney() {
  EventBus.on('InventoryMoneyUpdate', (raw: any) => {
    bot.lastMoney = new InventoryMoneyUpdatePacket(raw).Money;
  });
}

// ---------------------------------------------------------------------------
// Entrada al mundo: login -> lista de personajes -> elegir -> CharacterInformation.
// ---------------------------------------------------------------------------
export async function loginAndSelectCharacter() {
  login(USERNAME, PASSWORD);
  const loginBytes = await waitFor('LoginResponse');
  const loginResp = new LoginResponsePacket(loginBytes);
  if (loginResp.Success !== LoginResponseLoginResultEnum.Okay) throw new LoginError(loginResp.Success);
  log('Login OK');

  const listWaiter = waitFor('CharacterList');
  requestCharacterList();
  return selectCharacter(await listWaiter);
}

/** El personaje pedido no está en la cuenta. No se reintenta. */
/**
 * Registro de monstruos vistos: una fila `monster_seen` por tipo y mapa cada 10 min (nombre, nivel y vida del cliente, dónde, y si el tipo
 * está en la tabla del cliente). Alimenta `v_monsters`: qué hay en cada mapa, incluidos los custom del server y los jefes.
 */
const MONSTER_SEEN_MS = 10 * 60_000;
const seenAt = new Map<string, number>();
function noteMonsterSeen(type: number, x: number, y: number) {
  const key = `${world.map}:${type}`;
  const now = Date.now();
  if (now - (seenAt.get(key) ?? 0) < MONSTER_SEEN_MS) return;
  seenAt.set(key, now);
  trackEvent('monster_seen', monsterName(type), type, monsterLevel(type) ?? 0, { x, y, map: world.map, maxHp: monsterMaxHp(type), known: monsterMaxHp(type) != null });
}

export class CharNotFoundError extends Error {}

export async function selectCharacter(charListBytes: any) {
  const characters = parseCharacterList097(charListBytes);
  log(
    `Personajes: ${characters.map((c: any) => `${c.Name}(lv.${c.Level})`).join(', ')}`,
  );

  const target = characters.find((c: any) => c.Name === CHAR_NAME);
  // No se arregla reintentando: el personaje tiene que existir en la cuenta, en el Slow.
  if (!target) throw new CharNotFoundError(`${CHAR_NAME} no está en la cuenta (hay: ${characters.map((c: any) => c.Name).join(', ') || 'ninguno'}).`);

  const selP = SelectCharacterPacket.createPacket();
  selP.setName(target.Name);
  sendToGS(selP.buffer);

  const infoBytes = await waitFor('CharacterInformation');
  const info = parseCharacterInformation097(infoBytes);
  hpTracker.reset();
  Object.assign(world, {
    x: info.x,
    y: info.y,
    map: info.map,
    hp: info.hp,
    maxHp: info.maxHp,
    mana: info.mana,
    maxMana: info.maxMana,
    level: target.Level ?? world.level,
    classId: target.ClassId ?? null,
    levelUpPoints: info.levelUpPoints,
    exp: info.exp,
    expForNext: info.expForNext,
    stats: { str: info.str, agi: info.agi, vit: info.vit, ene: info.ene },
  });
  log(
    `Entré al mundo con ${target.Name}: pos=(${info.x},${info.y}) map=${info.map} nivel=${world.level} puntos=${info.levelUpPoints} exp=${info.exp} HP=${info.hp}/${info.maxHp}`,
  );
  // Retomar desde el estado real: si ya está en el mapa del tramo, la ruta lo
  // adopta sin warpear (chooseFixedRoute, 'adopt').
  bot.canAdopt = true;
  bot.lastMoney = info.money;
  bot.inGameAt = Date.now();
  bot.charName = target.Name;
  // El panel pregunta las aperturas de eventos (0x91) apenas entra al mundo.
  onMapArrival();
  return { name: target.Name, startX: info.x, startY: info.y, startExp: info.exp };
}
