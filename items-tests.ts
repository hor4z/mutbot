/**
 * Tests offline del sistema de ítems: reglas de items.json, puntaje, plan de equipamiento (con el baúl
 * real de Hume, fixtures/hume-vault.json), packets de mover ítem, mezclas y planificador, y el juez de
 * drops. Sin red.
 *
 *   bun run items-tests.ts
 */
import { buildCloseNpc, buildMoveItem, buildTalkNpc, STORAGE } from './protocol097';
import { cannotUse, classKeyOf, itemRule, type Fighter } from './item-rules';
import { DEFENSE_PER_LEVEL, crystalValue, judgeItem, makeDropJudge, scoreArmor, scoreOf, setNameOf } from './item-score';
import { BagGrid, describeStep, planEquip, summarizePlan, type PlanItem } from './equip-plan';
import { CRYSTALLIZE, HARMONY, MAT, countMat, describeProposal, fenrirRecipe, fusionRecipe, osbourneChance, planCrafts, rerollCost, upgradeRecipe, type Holdings } from './crafting';
import { isValuableDrop, pickLoot } from './farming';
import hume from './fixtures/hume-vault.json';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const bk: Fighter = { cls: 'dk', evolved: true, level: 400, stats: { str: 65535, agi: 65535, vit: 65535, ene: 65535 } };
const weakDk: Fighter = { cls: 'dk', evolved: true, level: 30, stats: { str: 100, agi: 50 } };

// --- reglas de items.json: clases deducidas ---------------------------------------
{
  const by = (g: number, n: number, cls: Fighter['cls']) => itemRule(g, n)?.classes?.[cls] ?? -1;
  ok('Great Dragon (8/21) es de DK evolucionado, no de DW/Elf', by(8, 21, 'dk') === 2 && by(8, 21, 'dw') === 0 && by(8, 21, 'elf') === 0, itemRule(8, 21));
  ok('Hurricane (8/23) y Storm Crow (8/15) son de MG', by(8, 23, 'mg') > 0 && by(8, 15, 'mg') > 0 && by(8, 23, 'dk') === 0);
  ok('Grand Soul (8/18) es de DW', by(8, 18, 'dw') > 0 && by(8, 18, 'dk') === 0);
  ok('Dark Master (8/28) es de DL, Light Plate (8/25) también', by(8, 28, 'dl') > 0 && by(8, 25, 'dl') > 0 && by(8, 28, 'mg') === 0);
  ok('Dragon Knight Armor (8/29) es de DK', by(8, 29, 'dk') === 2);
  ok('Plate (viejo): DK y MG; Vine: solo Elf; Pad: DW', by(8, 9, 'dk') > 0 && by(8, 9, 'mg') > 0 && by(8, 10, 'elf') > 0 && by(8, 10, 'dk') === 0 && by(8, 2, 'dw') > 0 && by(8, 2, 'dk') === 0);
  ok('Scale Gloves (10/6) sirve a DK', by(10, 6, 'dk') > 0);
  ok('formato: Great Dragon "nuevo", Plate "viejo"', itemRule(8, 21)?.layout === 'nuevo' && itemRule(8, 9)?.layout === 'viejo');
  ok('defensa base: nuevo = Def, viejo = DefRate', itemRule(8, 21)?.defense === 126 && itemRule(7, 9)?.defense === 46, [itemRule(8, 21)?.defense, itemRule(7, 9)?.defense]);
  ok('armas: sin reglas de clase (null)', itemRule(0, 17)?.classes === null);
  ok('tamaño del casco 2x2 y la armadura GD 2x3', itemRule(7, 21)?.w === 2 && itemRule(7, 21)?.h === 2 && itemRule(8, 21)?.h === 3);
}

// --- cannotUse ----------------------------------------------------------------
{
  ok('BK de 400 puede con el Great Dragon', cannotUse(7, 21, bk) === null, cannotUse(7, 21, bk));
  ok('DK sin evolucionar no puede con el Great Dragon', cannotUse(7, 21, { ...bk, evolved: false })?.includes('evolucion') === true);
  ok('nivel y fuerza bajos: pide nivel 86', cannotUse(7, 21, weakDk)?.startsWith('pide nivel 86') === true, cannotUse(7, 21, weakDk));
  ok('de otra clase: Hurricane en DK', cannotUse(8, 23, bk)?.includes('no es de la clase') === true);
  ok('ítem inexistente', cannotUse(8, 500, bk) === 'ítem desconocido en items.json');
  ok('clave de clase', classKeyOf('knight') === 'dk' && classKeyOf('wizard') === 'dw' && classKeyOf('gladiator') === 'mg' && classKeyOf('elf') === 'elf');
}

// --- puntaje ----------------------------------------------------------------------
{
  const gd = { group: 8, num: 21, level: 9, luck: true, option: 4, excFlags: 44, excCount: 3, excellent: true };
  const s = scoreArmor(gd);
  ok('puntaje GD armadura: base 126 + nivel 27 + opción 16 + exc 38 + luck 4 = 211', s.total === 211 && s.base === 126 && s.level === 27, s);
  ok('más nivel = más puntaje (tabla de defensa por nivel)', scoreOf({ ...gd, level: 10 }) - scoreOf(gd) === DEFENSE_PER_LEVEL[10] - DEFENSE_PER_LEVEL[9]);
  ok('excelente sin detalle vale ~15; sin nada, 0', scoreArmor({ group: 7, num: 9, level: 0, excellent: true }).exc === 15 && scoreArmor({ group: 7, num: 9, level: 0 }).exc === 0);
  ok('durabilidad 0 (rota) descuenta a la mitad', scoreOf({ ...gd, durability: 0 }) < scoreOf(gd) * 0.6);
  ok('nombre del set', setNameOf('Great Dragon Armor') === 'Great Dragon' && setNameOf('Dark Breaker') === 'Dark Breaker');
}

// --- Cristales (guía del Alquimista) -----------------------------------------------
{
  // Ejemplo de la guía: pieza de set top, 4 opciones, +9, luck ≈ 75.
  const top = { group: 8, num: 21, level: 9, luck: true, excCount: 4, excellent: true };
  ok('cristales: top 4 exc +9 luck = 20 × 2 × 1,5 × 1,25 = 75', crystalValue(top) === 75, crystalValue(top));
  ok('cristales: 1 exc sin nada de un set viejo (grado bajo) = 0,5', crystalValue({ group: 8, num: 9, level: 0, excCount: 1, excellent: true }) === 0.5);
  ok('cristales: +15 x15, +14 x4,5', crystalValue({ ...top, level: 15, luck: false }) === 20 * 2 * 15 && crystalValue({ ...top, level: 14, luck: false }) === 20 * 2 * 4.5);
  ok('cristales: sin excelentes no se cristaliza; alas no', crystalValue({ group: 8, num: 21, level: 9 }) === null && crystalValue({ group: 12, num: 5, level: 9, excCount: 2 }) === null);
}

// --- grilla de la bolsa ---------------------------------------------------------------
{
  const g = new BagGrid([{ slot: 12, group: 14, num: 6 }]);
  ok('grilla: 1x1 ocupa 12, el siguiente hueco es 13', g.alloc({ group: 14, num: 6 }) === 13);
  const full = new BagGrid(Array.from({ length: 64 }, (_, i) => ({ slot: 12 + i, group: 14, num: 6 })));
  ok('grilla llena → null', full.alloc({ group: 7, num: 21 }) === null);
  const g2 = new BagGrid();
  const a = g2.alloc({ group: 8, num: 21 })!; // 2x3
  const b = g2.alloc({ group: 8, num: 21 })!;
  ok('grilla: dos 2x3 no se pisan', a === 12 && b === 14, [a, b]);
  g2.free(a, { group: 8, num: 21 });
  ok('grilla: liberar devuelve el hueco', g2.alloc({ group: 8, num: 21 }) === 12);
}

// --- plan de equipamiento con el baúl REAL de Hume --------------------------------------
{
  const toItems = (xs: unknown[]) => xs as PlanItem[];
  const plan = planEquip({ fighter: bk, equipped: toItems(hume.equipped), bag: toItems(hume.bag), vault: toItems(hume.vault) });
  const take = plan.steps.filter((s) => s.kind === 'take');
  const equip = plan.steps.filter((s) => s.kind === 'equip');
  const names = equip.map((s) => s.item.name);
  ok('Hume: equipa 5 piezas (casco, armadura, pantalones, guantes, botas)', equip.length === 5 && take.length === 5, plan.steps.map((s) => describeStep(s, 0)));
  ok('Hume: casco, pantalones y botas son Great Dragon', ['Great Dragon Helm', 'Great Dragon Pants', 'Great Dragon Boots'].every((n) => names.includes(n)), names);
  ok('Hume: armadura = Dragon Knight Armor +10 (219 > 211 del Great Dragon)', names.includes('Dragon Knight Armor') && !names.includes('Great Dragon Armor'), names);
  ok('Hume: guantes = Scale Gloves (lo único usable de su clase)', names.includes('Scale Gloves'));
  ok('Hume: no toca alas ni arma (no hay unequip)', !plan.steps.some((s) => s.kind === 'unequip'));
  ok('Hume: nada de otras clases (Hurricane, Storm Crow, Grand Soul, Dark Master)', !names.some((n) => /Hurricane|Storm Crow|Grand Soul|Dark Master|Legendary|Guardian/.test(n)), names);
  const firstEquip = plan.steps.findIndex((s) => s.kind === 'equip');
  ok('orden: primero todos los take, después los equip', plan.steps.slice(0, firstEquip).every((s) => s.kind === 'take') && plan.steps.slice(firstEquip).every((s) => s.kind === 'equip'));
  const cells = take.map((s) => (s.kind === 'take' ? s.toBag : -1));
  ok('las casillas de la bolsa no chocan con lo que ya hay (12-24) ni entre sí', cells.every((c) => c >= 25) && new Set(cells).size === cells.length, cells);
  ok('equip sale de la casilla donde se dejó el take', equip.every((e) => e.kind === 'equip' && take.some((t) => t.kind === 'take' && t.toBag === e.fromBag)));
  ok('ganancia total grande y resumen', plan.gains.reduce((a, g) => a + g.delta, 0) > 700 && summarizePlan(plan).includes('5 pieza(s)'), summarizePlan(plan));
  ok('nota del set: 3/5 de Great Dragon', plan.notes.some((n) => n.includes('3/5 de Great Dragon')), plan.notes);

  // Un DK de nivel 30 y stats bajos no puede con nada del Great Dragon: no propone nada de eso.
  const weak = planEquip({ fighter: weakDk, equipped: [], bag: [], vault: toItems(hume.vault) });
  ok('DK débil: no se pone el Great Dragon', !weak.steps.some((s) => s.item.name.startsWith('Great Dragon')), weak.steps.map((s) => s.item.name));
  ok('DK débil: lo bloqueado dice por qué (nivel/fuerza)', weak.blocked.some((b) => b.name.startsWith('Great Dragon') && b.reason.startsWith('pide')), weak.blocked.slice(0, 2));

  // Bolsa llena: no entra → bloqueado, sin pasos.
  const fullBag = Array.from({ length: 64 }, (_, i) => ({ slot: 12 + i, group: 14, num: 6, level: 0, name: 'x' })) as PlanItem[];
  const noRoom = planEquip({ fighter: bk, equipped: [], bag: fullBag, vault: toItems(hume.vault) });
  ok('bolsa llena: sin pasos y con motivo', noRoom.steps.length === 0 && noRoom.blocked.some((b) => b.reason === 'no entra en la bolsa'));

  // Reemplazar una pieza puesta: primero se saca (unequip), después se pone.
  const worn: PlanItem = { slot: 2, group: 7, num: 9, level: 0, name: 'Plate Helm', excellent: false };
  const swap = planEquip({ fighter: bk, equipped: [worn], bag: [], vault: toItems(hume.vault).filter((i) => i.name === 'Great Dragon Helm') });
  const kinds = swap.steps.map((s) => s.kind);
  ok('reemplazo: take → unequip → equip', kinds.join() === 'take,unequip,equip', kinds);
  // Lo puesto igual o mejor no se toca.
  const keep = planEquip({ fighter: bk, equipped: [{ ...toItems(hume.vault).find((i) => i.name === 'Great Dragon Helm')!, slot: 2 }], bag: [], vault: toItems(hume.vault) });
  ok('lo puesto que ya es lo mejor no se mueve', !keep.steps.some((s) => s.item.name.includes('Helm')), keep.steps.map((s) => s.item.name));
}

// --- packets de mover ítem (bytes) ----------------------------------------------------
{
  const item5 = Uint8Array.from([0x15, 0x4c, 0x53, 0x2c, 0x00]);
  const item6 = Uint8Array.from([0x15, 0x4c, 0x53, 0x2c, 0x00, 0x00]);
  // Igual que lo que mandaba equip.ts antes del refactor (probado en vivo): [c3, 7+n, 24, 0, slot, ...raw, 0, to]
  ok('MoveItem inventario→inventario, ítem de 5 bytes (idéntico al probado en vivo)', [...buildMoveItem(0, 20, item5, 0, 3)].join() === [0xc3, 12, 0x24, 0, 20, ...item5, 0, 3].join());
  ok('MoveItem con ítem de 6 bytes → C3 0D', buildMoveItem(0, 20, item6, 0, 3)[1] === 13 && buildMoveItem(0, 20, item6, 0, 3).length === 13);
  const take = buildMoveItem(STORAGE.vault, 4, item6, STORAGE.inventory, 25);
  ok('baúl→bolsa: depósito 2 casilla 4 → depósito 0 casilla 25 (SIN verificar en vivo)', [...take].join() === [0xc3, 13, 0x24, 2, 4, ...item6, 0, 25].join(), [...take]);
  let threw = false;
  try { buildMoveItem(0, 1, Uint8Array.from([1, 2, 3]), 0, 2); } catch { threw = true; }
  ok('ítem de largo raro → error (no se manda basura)', threw);
  ok('hablar con Baz (240) y cerrar', [...buildTalkNpc(240)].join() === [0xc3, 5, 0x30, 0, 240].join() && [...buildCloseNpc()].join() === [0xc1, 3, 0x31].join());
  ok('Chaos Machine = depósito 3, baúl = 2', STORAGE.chaosMachine === 3 && STORAGE.vault === 2);
}

// --- recetas (cada número sale de una guía; ver docs/items-y-maquinas.md) ------------------
{
  const u10 = upgradeRecipe(10), u13 = upgradeRecipe(13);
  ok('+10: 1 Chaos + 1 Soul + 1 Bless; +13: 1 Chaos + 4 Soul + 4 Bless', u10.materials.chaos === 1 && u10.materials.soul === 1 && u10.materials.bless === 1 && u13.materials.soul === 4 && u13.materials.bless === 4);
  ok('subida: tasa NO publicada (null) y estimación marcada', u10.success === null && !!u10.assumed?.src);
  ok('subida: confirmación humana siempre', u10.needsConfirmation && u13.needsConfirmation);
  const f14 = fusionRecipe(14, 0), f14b = fusionRecipe(14, 2), f15 = fusionRecipe(15, 1), f15b = fusionRecipe(15, 2);
  ok('fusión +14: 45 %, 50 M; con 1 talismán 55 %, con 2 65 %', f14.success === 0.45 && f14.zen === 50_000_000 && fusionRecipe(14, 1).success === 0.55 && f14b.success === 0.65 + 0);
  ok('fusión +15: 25 %, 100 M; 35 % y 45 % con talismanes', fusionRecipe(15, 0).success === 0.25 && fusionRecipe(15, 0).zen === 100_000_000 && f15.success === 0.35 && Math.abs((f15b.success ?? 0) - 0.45) < 1e-9);
  ok('talismanes cuestan Cristales: 100 / 250 por unidad', f14b.crystals === 200 && f15.crystals === 250);
  ok('fusión falla → se queman los dos; con protección quedan', f14.onFail.includes('LOS DOS') && f14.onFailProtected!.includes('intactos'));
  const fe = [1, 2, 3, 4].map((s) => fenrirRecipe(s as 1 | 2 | 3 | 4));
  ok('Fenrir: 70 % / 50 % / 30 %, fase 3 con 10 M y 3 Life', fe[0].success === 0.7 && fe[1].success === 0.5 && fe[2].success === 0.3 && fe[2].zen === 10_000_000 && fe[2].materials.life === 3 && fe[0].materials.splinter === 20);
  ok('Fenrir fase 4: tasa no publicada (hasta 79 %)', fe[3].success === null && fe[3].materials.life === 5);
  ok('re-sorteo de opciones: 60 + 60 por candado, 20 M', rerollCost(0).crystals === 60 && rerollCost(2).crystals === 180 && rerollCost(1).zen === 20_000_000);
  ok('cristalizar: 8 ítems, 500.000 por tanda', CRYSTALLIZE.maxItems === 8 && CRYSTALLIZE.zenPerBatch === 500_000);
  ok('armonía: 80 % Elpis, 60 % joya, 20/80 % piedras', HARMONY.elpisRefine === 0.8 && HARMONY.applyJewel === 0.6 && HARMONY.lowerStone === 0.2 && HARMONY.higherStone === 0.8);
  ok('Osbourne: 1 excelente = 50 %, 2 = 75 %, 3 comunes ≈ 48,8 %', osbourneChance(0, 1) === 0.5 && osbourneChance(0, 2) === 0.75 && Math.abs(osbourneChance(3, 0) - 0.488) < 1e-9);
}

// --- planificador -------------------------------------------------------------------------
{
  const piece = (over: Partial<PlanItem>): PlanItem => ({ slot: 30, group: 7, num: 21, level: 9, name: 'Great Dragon Helm', excellent: true, luck: true, option: 4, excFlags: 44, excCount: 3, durability: 83, ...over });
  const jewels = (q: Record<string, number>): PlanItem[] => Object.entries(q).map(([k, n], i) => ({ slot: 12 + i, group: MAT[k as keyof typeof MAT].group, num: MAT[k as keyof typeof MAT].num, level: 0, name: k, durability: n }));
  const worn = piece({ slot: 2 });

  // Sin Chaos: faltan materiales.
  const noChaos = planCrafts({ zen: 1e9, items: [worn, ...jewels({ bless: 74, soul: 11 })].map((i) => ({ ...i, equipped: i.slot === 2 })) }, bk);
  const up = noChaos.find((p) => p.kind === 'upgrade')!;
  ok('sin Jewel of Chaos: "faltan materiales" y lo dice', up.verdict === 'faltan materiales' && up.missing[0].startsWith('Jewel of Chaos ×1'), up);
  ok('apilados: la durabilidad es la cantidad (74 Bless)', countMat({ zen: 0, items: jewels({ bless: 74 }) }, MAT.bless) === 74);

  // Con todo pero sin talismán: con ~211 puntos en juego, subir +9→+10 (gana 4) no conviene.
  const withChaos: Holdings = { zen: 1e9, items: [worn, ...jewels({ chaos: 3, bless: 74, soul: 11 })].map((i) => ({ ...i, equipped: i.slot === 2 })) };
  const up2 = planCrafts(withChaos, bk).find((p) => p.kind === 'upgrade')!;
  ok('con joyas pero sin Talismán de Protección: no conviene (riesgo > ganancia)', up2.verdict === 'no conviene' && up2.ev < 0 && up2.successPublished === false, up2);
  // Con Protección el ítem no se pierde: pasa a convenir.
  const prot: Holdings = { zen: 1e9, items: [...withChaos.items, ...jewels({ talismanProt: 1 }).map((i) => ({ ...i, slot: 70 }))] };
  const up3 = planCrafts(prot, bk).find((p) => p.kind === 'upgrade')!;
  ok('con Talismán de Protección: propone', up3.verdict === 'proponer' && up3.ev > 0, up3);
  ok('TODA propuesta pide confirmación humana y no es ejecutable', planCrafts(prot, bk).every((p) => p.needsConfirmation === true && p.executable === false));

  // Fusión: dos +13 iguales.
  const a = piece({ slot: 30, level: 13 }), b = piece({ slot: 31, level: 13, excFlags: 12, excCount: 2 });
  const fus = planCrafts({ zen: 60_000_000, items: [a, b] }, bk).find((p) => p.kind === 'fusion')!;
  ok('fusión +13+13: tasa publicada 45 %, riesgo: se queman los dos', fus.successUsed === 0.45 && fus.successPublished && fus.risk.includes('LOS DOS') && fus.recipe!.zen === 50_000_000, fus);
  ok('fusión sin el zen: faltan materiales', planCrafts({ zen: 1000, items: [a, b] }, bk).find((p) => p.kind === 'fusion')!.verdict === 'faltan materiales');
  ok('fusión con talismanes +14 en mano: usa hasta 2 (65 %)', planCrafts({ zen: 60_000_000, items: [a, b, ...jewels({ talisman14: 1 }), { slot: 60, group: 14, num: 12, level: 0, name: 't', durability: 1 }] }, bk).find((p) => p.kind === 'fusion')!.successUsed === 0.65);

  // Cristalizar: las piezas del baúl de Hume que no son de su clase.
  const humeItems: Holdings = { zen: 5e6, items: [...(hume.vault as unknown as PlanItem[]), ...(hume.bag as unknown as PlanItem[])] };
  const cry = planCrafts(humeItems, bk).filter((p) => p.kind === 'crystallize');
  ok('cristalizar: propone tandas de hasta 8 con zen para 500.000', cry.length >= 1 && cry.every((p) => p.items.length <= 8 && p.verdict === 'proponer'), cry.map((p) => p.title));
  const crItems = new Set(cry.flatMap((p) => p.items.map((i) => i.name)));
  ok('cristalizar: NO propone quemar lo que Hume se va a poner (Great Dragon, Dragon Knight)', ![...crItems].some((n) => /Great Dragon (Helm|Pants|Boots)|Dragon Knight/.test(n)), [...crItems]);
  const others = planCrafts(humeItems, bk, { others: [{ cls: 'mg', evolved: true, level: 400, stats: { str: 65535, agi: 65535 } }] }).filter((p) => p.kind === 'crystallize').flatMap((p) => p.items.map((i) => i.name));
  ok('otro personaje de la cuenta (MG) puede usar Hurricane/Storm Crow: no se cristalizan', !others.some((n) => /Hurricane|Storm Crow/.test(n)), others);
  ok('cristalizar sin zen: faltan materiales', planCrafts({ ...humeItems, zen: 0 }, bk).filter((p) => p.kind === 'crystallize').every((p) => p.verdict === 'faltan materiales'));

  // Armonía
  const harm = planCrafts({ zen: 0, items: [{ ...worn, equipped: true }, ...jewels({ harmony: 1 })] }, bk).find((p) => p.kind === 'harmony');
  ok('armonía: con la joya propone sobre lo puesto; si falla solo se gasta la joya', !!harm && harm.successUsed === 0.6 && harm.risk.includes('se gasta la joya'), harm);
  ok('describeProposal menciona confirmación', describeProposal(up3).includes('confirmación humana'));
}

// --- juez de drops: default sin cambios -------------------------------------------------------
{
  const gearExc = { group: 8, num: 21, excellent: true };
  ok('default (sin juez): igual que siempre', isValuableDrop(gearExc, false, true) === true && isValuableDrop(gearExc, false, false) === false && isValuableDrop({ group: 8, num: 9 }, false, true) === false);
  const judge = makeDropJudge(bk, () => undefined);
  ok('juez: un Great Dragon sirve (lugar vacío)', isValuableDrop({ ...gearExc, level: 9 } as never, false, true, judge) === true);
  const none = makeDropJudge(bk, () => undefined, { minCrystals: 1000 });
  ok('juez: un excelente de otra clase con pocos cristales se deja', isValuableDrop({ group: 8, num: 10, excellent: true } as never, false, true, none) === false);
  ok('juez: sin lugar (gear=false) no opina', isValuableDrop(gearExc, false, false, judge) === false);
  ok('juez: cajas y cristales siguen siempre', isValuableDrop({ group: 14, num: 11 }, false, false, none) === true && isValuableDrop({ group: 14, num: 31 }, false, false, none) === true);
  ok('juez: lo que no es equipo no se toca (joyas no)', isValuableDrop({ group: 14, num: 13 }, false, true, judge) === false);
  const pk = pickLoot({ x: 0, y: 0 }, [{ x: 1, y: 1, group: 8, num: 10, excellent: true }, { x: 5, y: 5, group: 14, num: 11 }], 12, false, true, none);
  ok('pickLoot con juez: ignora el excelente que no sirve y va a la caja', pk?.group === 14, pk);
  const judged = judgeItem({ group: 8, num: 10, level: 3, excCount: 1, excellent: true }, bk, undefined);
  ok('judgeItem: Vine (Elf) para un BK no se equipa; 1 exc de grado bajo no da para cristalizar', judged.action === 'basura', judged);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS DE ÍTEMS PASARON' : `\n${fails} TEST(S) DE ÍTEMS FALLARON`);
process.exit(fails ? 1 : 0);
