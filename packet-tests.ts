/**
 * Tests offline del bot: valida los parsers legacy 0.97d y los builders C2S
 * contra bytes armados a mano, sin tocar el server.
 *
 *   bun run packet-tests.ts
 *
 * Cubre los packets donde el XML del repo NO coincide con el protocolo 0.97d
 * real (ver AGENTS.md, sección "Trampas de protocolo"), que son los que el
 * cliente_generated parsea mal y hacen que el bot crea estar ciego.
 */
import {
  SkillListUpdatePacket, CharacterInventoryPacket, CurrentHealthAndShieldPacket,
  CurrentManaAndAbilityPacket, MapChanged075Packet, ObjectWalked075Packet,
  ItemsDroppedPacket, NpcItemSellResultPacket, InventoryMoneyUpdatePacket,
  OpenNpcDialogPacket, NpcWindowResponsePacket, StoreItemListPacket,
  MoneyDropped075Packet,
} from './packets';
import { Backoff, RECONNECT, buildPartyDecline, isExcellentItemData, isObjectMovedPacket, parseItemDropRemoved, parsePartyRequest } from './protocol097';
import {
  TalkToNpcRequestPacket, SellItemToNpcRequestPacket, BuyItemFromNpcRequestPacket,
  CloseNpcRequestPacket,
} from './packets';

let fails = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` -> ${JSON.stringify(got)}`}`);
  if (!cond) fails++;
};
const dv = (u: Uint8Array) => new DataView(u.buffer, u.byteOffset, u.byteLength);
// Los packets del repo exponen el buffer como DataView; para volcarlo a bytes.
const bytes = (b: DataView) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)];
const itemNum = (d: DataView) => d.getUint8(0);
const itemGroup = (d: DataView) => (d.getUint8(5) & 0xf0) >> 4;

// --- CharacterInventory (F3/10, header C4): count en 5, StoredItem[slot+12 bytes]
const inv = new Uint8Array(6 + 2 * 13);
inv[0] = 0xc4; inv[1] = inv.length & 0xff; inv[2] = inv.length >> 8;
inv[3] = 0xf3; inv[4] = 0x10; inv[5] = 2;
inv[6] = 0;   inv[7] = 1;  inv[12] = 0xe0;   // ItemData[5] = idx base+6
inv[19] = 13; inv[20] = 2; inv[25] = 0xe0;
const invItems = new CharacterInventoryPacket(dv(inv)).getItems(2);
ok('inv: 2 items', invItems.length === 2, invItems.length);
ok('inv: item0 slot=0 potion 14/1',
   invItems[0].ItemSlot === 0 && itemNum(invItems[0].ItemData) === 1 && itemGroup(invItems[0].ItemData) === 14,
   { s: invItems[0].ItemSlot, n: itemNum(invItems[0].ItemData), g: itemGroup(invItems[0].ItemData) });
ok('inv: item1 slot=13 potion 14/2',
   invItems[1].ItemSlot === 13 && itemNum(invItems[1].ItemData) === 2,
   { s: invItems[1].ItemSlot, n: itemNum(invItems[1].ItemData) });

// --- SkillListUpdate (F3/11): count en 4, entries desde offset 6
const sk = new Uint8Array(6 + 2 * 4);
sk[0] = 0xc1; sk[1] = sk.length; sk[2] = 0xf3; sk[3] = 0x11; sk[4] = 2;
sk[6] = 0; sk[7] = 14; sk[8] = 0; sk[9] = 3;
sk[10] = 1; sk[11] = 45; sk[12] = 0; sk[13] = 1;
const skp = new SkillListUpdatePacket(dv(sk));
const skills = skp.getSkills(skp.Count);
ok('skills: count 2', skills.length === 2, skills.length);
ok('skills: #0 num=14 lvl=3', skills[0].SkillNumber === 14 && skills[0].SkillLevel === 3, skills[0]);
ok('skills: #1 num=45 lvl=1', skills[1].SkillNumber === 45 && skills[1].SkillLevel === 1, skills[1]);

// --- CurrentHealthAndShield (0x26/0xFF): Health BE idx4, Shield BE idx7 -> len 9
const hp = new Uint8Array([0x26, 0x09, 0xff, 0x00, 0x12, 0x34, 0x00, 0x00, 0x00]);
const hpp = new CurrentHealthAndShieldPacket(dv(hp));
ok('hp: 4660 (BigEndian)', hpp.Health === 4660, hpp.Health);

// --- CurrentManaAndAbility (0x27/0xFF): Mana BE idx4, Ability BE idx6 -> len 8
const mp = new Uint8Array([0x27, 0x08, 0xff, 0x00, 0x03, 0xe8, 0x00, 0x00]);
const mpp = new CurrentManaAndAbilityPacket(dv(mp));
ok('mana: 1000 (BigEndian)', mpp.Mana === 1000, mpp.Mana);

// --- MapChanged075: header C3Header -> idx0=0xC3, idx1=len, idx2=code 0x1C
const mcp = new MapChanged075Packet(dv(new Uint8Array([0xc3, 0x08, 0x1c, 0x01, 0x12, 0x50, 0x60, 0x00])));
ok('map: num=0x12 pos(80,96)', mcp.MapNumber === 0x12 && mcp.PositionX === 0x50 && mcp.PositionY === 0x60,
   { n: mcp.MapNumber, x: mcp.PositionX, y: mcp.PositionY });

// --- ObjectWalked075 (0x10): ObjectId BE idx3, TargetX idx5, TargetY idx6
const owp = new ObjectWalked075Packet(dv(new Uint8Array([0x10, 0x07, 0x00, 0x00, 0x50, 0x63, 0x00])));
ok('walk: id=0x50 target=(99,0)', owp.ObjectId === 0x50 && owp.TargetX === 99,
   { id: owp.ObjectId, x: owp.TargetX, y: owp.TargetY });

// --- ItemsDropped (C3/0x16): count en 4, items desde offset 5, cada uno
//     Id BE(2) + IsFresh(1) + X(1) + Y(1) + ItemData(12) = 17 bytes
const dropBuf = new Uint8Array(5 + 1 * 17);
dropBuf[0] = 0xc3; dropBuf[1] = dropBuf.length; dropBuf[2] = 0x16; dropBuf[4] = 1;
dropBuf[5] = 0x12; dropBuf[6] = 0x34;   // Id = 0x1234
dropBuf[7] = 111; dropBuf[8] = 99;       // X, Y
dropBuf[9] = 7;                          // ItemData[0] = num
dropBuf[14] = 0xc0;                      // ItemData[5] = group 12 (nibble alto)
const dropped = new ItemsDroppedPacket(dv(dropBuf)).getItems(1)[0];
ok('drop: id=0x1234 pos=(111,99)',
   dropped.Id === 0x1234 && dropped.PositionX === 111 && dropped.PositionY === 99,
   { id: dropped.Id, x: dropped.PositionX, y: dropped.PositionY });
ok('drop: item 12/7', itemGroup(dropped.ItemData) === 12 && itemNum(dropped.ItemData) === 7,
   { g: itemGroup(dropped.ItemData), n: itemNum(dropped.ItemData) });

// --- MoneyDropped075 (C2/0x20, 14 bytes): MISMO código que ItemsDropped (ver
//     arriba, también 0x20) pero layout totalmente distinto — bug real
//     encontrado jugando: el bot intentaba leer un ItemData de 12 bytes de un
//     drop de dinero (que no lo tiene) y crasheaba. Se distingue por tamaño
//     de buffer (14 bytes fijos), ver parseDropsPacket en headless-bot.ts.
const moneyDrop = new Uint8Array(14);
moneyDrop[0] = 0xc2; moneyDrop[1] = 0; moneyDrop[2] = 14; moneyDrop[3] = 0x20;
moneyDrop[4] = 1;                 // ItemCount=1 (siempre, es un solo drop)
moneyDrop[5] = 0x00; moneyDrop[6] = 0x55; // Id BE = 0x55
moneyDrop[7] = 111; moneyDrop[8] = 99;    // X, Y
moneyDrop[9] = (14 << 4) | 15;             // MoneyGroup=14 (nibble alto), MoneyNumber=15
new DataView(moneyDrop.buffer).setUint32(10, 777, true); // Amount LE
const mdp = new MoneyDropped075Packet(dv(moneyDrop));
ok('money drop: id=0x55 pos=(111,99) group=14 num=15 amount=777',
   mdp.Id === 0x55 && mdp.PositionX === 111 && mdp.PositionY === 99 &&
   mdp.MoneyGroup === 14 && mdp.MoneyNumber === 15 && mdp.Amount === 777,
   { id: mdp.Id, x: mdp.PositionX, y: mdp.PositionY, g: mdp.MoneyGroup, n: mdp.MoneyNumber, a: mdp.Amount });

// --- NpcItemSellResult (C3/0x33): Success = bit 0 del byte 3, Money LE uint32 idx4
//     OJO: Money es LITTLE endian acá, al revés que InventoryMoneyUpdate.
const sellp = new NpcItemSellResultPacket(dv(new Uint8Array([0xc3, 0x08, 0x33, 0x01, 0x39, 0x30, 0x00, 0x00])));
ok('sell: ok y dinero=12345', sellp.Success === true && sellp.Money === 12345,
   { ok: sellp.Success, m: sellp.Money });
const sellFail = new NpcItemSellResultPacket(dv(new Uint8Array([0xc3, 0x08, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00])));
ok('sell: rechazo se distingue', sellFail.Success === false, sellFail.Success);

// --- InventoryMoneyUpdate (C3/0x22 sub FE): Money BIG endian uint32 idx4
const money = new InventoryMoneyUpdatePacket(dv(new Uint8Array([0xc3, 0x08, 0x22, 0xfe, 0x00, 0x00, 0x30, 0x39])));
ok('money: 12345', money.Money === 12345, money.Money);

// --- OpenNpcDialog (C3/0xF9 sub 01): NpcNumber LITTLE endian uint16 idx4
const dlg = new OpenNpcDialogPacket(dv(new Uint8Array([0xc3, 0x0a, 0xf9, 0x01, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x00])));
ok('dialog: npc=500', dlg.NpcNumber === 500, dlg.NpcNumber);

// --- StoreItemList (C2/0x31): mismo layout que CharacterInventory (ItemCount
//     en 5, items desde offset 6, stride 1+12), pero el getItems() generado
//     tiene un bug nuevo: calcula el ItemData con longitud 0 en vez de 12 (a
//     diferencia de CharacterInventory/ItemsDropped arriba, que sí matchean).
//     headless-bot.ts NO usa getItems() acá, parsea a mano (parseStoreItemList097).
const shop = new Uint8Array(6 + 2 * 13);
shop[0] = 0xc2; shop[1] = shop.length & 0xff; shop[2] = shop.length >> 8;
shop[3] = 0x31; shop[5] = 2; // Type=0, ItemCount=2
shop[6] = 0; shop[7] = 1; shop[12] = 0xe0;    // shopSlot=0, item 14/1 (poción)
shop[19] = 5; shop[20] = 2; shop[25] = 0xe0;  // shopSlot=5, item 14/2
const storeItems = new StoreItemListPacket(dv(shop)).getItems(2);
ok('store: getItems() generado da ItemData vacío (bug confirmado)',
   storeItems.length === 2 && storeItems[0].ItemData.byteLength === 0,
   { len: storeItems[0]?.ItemData?.byteLength });
// Mismo parseo manual que parseStoreItemList097 en headless-bot.ts:
function manualStoreItems(buf: Uint8Array) {
  const count = buf[5];
  const out: { shopSlot: number; group: number; num: number }[] = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 13;
    out.push({ shopSlot: buf[base], num: buf[base + 1], group: (buf[base + 6] & 0xf0) >> 4 });
  }
  return out;
}
const manualShop = manualStoreItems(shop);
ok('store: manual shopSlot=0 item 14/1',
   manualShop[0].shopSlot === 0 && manualShop[0].group === 14 && manualShop[0].num === 1, manualShop[0]);
ok('store: manual shopSlot=5 item 14/2',
   manualShop[1].shopSlot === 5 && manualShop[1].group === 14 && manualShop[1].num === 2, manualShop[1]);

// --- NpcWindowResponse (0x30): Window byte idx3
const win = new NpcWindowResponsePacket(dv(new Uint8Array([0x30, 0x04, 0x00, 0x00])));
ok('window: merchant(0)', win.Window === 0, win.Window);

// --- Builders C2S de NPC: TalkToNpcRequest requiere 5 bytes
//     header C3Header(0xC3,len,code=0x30) + NpcId BE(2)
const talk = TalkToNpcRequestPacket.createPacket();
talk.NpcId = 500;
ok('talk: code=0x30 npc=500',
   talk.buffer.getUint8(0) === 0xc3 && talk.buffer.getUint8(2) === 0x30 &&
   talk.buffer.getUint16(3, false) === 500 && talk.buffer.byteLength === 5,
   { head: bytes(talk.buffer) });
// Sell/Buy: header C3Header + ItemSlot(1) -> 4 bytes
const sellReq = SellItemToNpcRequestPacket.createPacket();
sellReq.ItemSlot = 13;
ok('sell req: code=0x33 slot=13',
   sellReq.buffer.getUint8(2) === 0x33 && sellReq.buffer.getUint8(3) === 13 &&
   sellReq.buffer.byteLength === 4, { head: bytes(sellReq.buffer) });
const buyReq = BuyItemFromNpcRequestPacket.createPacket();
buyReq.ItemSlot = 7;
ok('buy req: code=0x32 slot=7',
   buyReq.buffer.getUint8(2) === 0x32 && buyReq.buffer.getUint8(3) === 7,
   { head: bytes(buyReq.buffer) });
// Close: header C1Header -> 3 bytes, sin payload
const closeReq = CloseNpcRequestPacket.createPacket();
ok('close req: len=3', closeReq.buffer.byteLength === 3,
   { head: bytes(closeReq.buffer) });

// --- Party: rechazar invitaciones (protocol097.ts) ------------------------------
{
  const req = Uint8Array.from([0xc1, 0x05, 0x40, 0x81, 0x23]);
  ok('PartyRequest: id del que invita, BE en el byte 3 (sin el bit alto)', parsePartyRequest(req) === 0x0123);
  ok('PartyRequest corto: null', parsePartyRequest(Uint8Array.from([0xc1, 0x04, 0x40, 0x01])) === null);
  ok('rechazo: C1 06 41 00 <id BE>', buildPartyDecline(0x0123).join() === [0xc1, 0x06, 0x41, 0x00, 0x01, 0x23].join());
}

// --- ItemDropRemoved y excelentes --------------------------------------------------
{
  const rem = Uint8Array.from([0xc2, 0x00, 0x09, 0x21, 0x02, 0x80, 0x10, 0x00, 0x22]);
  ok('ItemDropRemoved: count @4, ids BE de a 2 bytes', parseItemDropRemoved(rem).join() === '16,34', parseItemDropRemoved(rem));
  // 0x15: 8 bytes = movimiento; 10 bytes = daño de un golpe en 0.97d (no mover al monstruo).
  ok('0x15 de 8 bytes es ObjectMoved', isObjectMovedPacket(Uint8Array.from([0xc1, 8, 0x15, 0x03, 0x8e, 20, 40, 0])));
  ok('0x15 de 10 bytes es el daño (no movimiento)', !isObjectMovedPacket(Uint8Array.from([0xc1, 10, 0x15, 0x03, 0x8e, 0x14, 0x28, 0, 0, 0])));
  ok('ItemDropRemoved truncado: no lee fuera', parseItemDropRemoved(Uint8Array.from([0xc2, 0, 6, 0x21, 5, 0])).length === 0);
  const item = new Uint8Array(12);
  ok('ítem común: no excelente', !isExcellentItemData(item));
  item[3] = 0x80; // bit alto: no es opción excelente
  ok('bit 7 del byte 3 no cuenta', !isExcellentItemData(item));
  item[3] = 0x21;
  ok('opciones excelentes en los 6 bits bajos del byte 3', isExcellentItemData(item));
}

// --- Reconexión con backoff --------------------------------------------------------
{
  const b = new Backoff();
  const w = [b.next(1000), b.next(1000), b.next(1000)];
  ok('backoff exponencial desde 5 s', w.join() === '5000,10000,20000', w);
  for (let i = 0; i < 20; i++) b.next(1000);
  ok('con tope', b.next(1000) === RECONNECT.MAX_MS);
  ok('una sesión sana vuelve al primer escalón', b.next(RECONNECT.HEALTHY_MS) === RECONNECT.BASE_MS);
  ok('cuenta todavía conectada: espera más', new Backoff().next(0, true) === RECONNECT.ALREADY_CONNECTED_MS);
}

console.log(fails === 0 ? '\nTODOS LOS TESTS PASARON' : `\n${fails} TEST(S) FALLARON`);
process.exit(fails ? 1 : 0);
