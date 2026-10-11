/**
 * Extrae de los packets generados del repo SOLO las clases que el bot usa, y las
 * deja en packets/ junto con las helpers mínimas.
 *
 *   MU_SRC=~/self/mu/src bun run extract-packets.ts
 *
 * Por qué existe: los .ts de packets del repo son de 20k líneas cada uno,
 * generados desde los XML del cliente 1.xs, y no matchean 0.97d en varios casos
 * (ver AGENTS.md). Copiarlos enteros dentro del bot arrastraría todo eso.
 *
 * El script es determinista: si un día hay que re-copiar algo, se corre esto y
 * no hay que editar el archivo a mano. Falla ruidosamente si falta una clase,
 * para que un rename upstream no rompa el bot en silencio.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Raíz del cliente MU JS de donde se copian los packets (github.com/asosnovskiy).
// Solo hace falta para regenerar; el bot no depende de él en runtime.
//   MU_SRC=~/self/mu/src bun run extract-packets.ts
const MU_SRC = process.env.MU_SRC ?? join(HERE, '..', 'mu', 'src');
const SRC = join(MU_SRC, 'common', 'packets');

// Las clases que importa el bot (headless-bot.ts y sus módulos), agrupadas por archivo de origen.
const WANTED: Record<string, string[]> = {
  'ConnectServerPackets.ts': [
    'ConnectionInfoPacket',
    'ConnectionInfoRequestPacket',
    'ServerListRequestOldPacket',
    'ServerListResponseOldPacket',
    'ServerListResponsePacket',
  ],
  'ClientToServerPackets.ts': [
    'BuyItemFromNpcRequestPacket',
    'ClientReadyAfterMapChangePacket',
    'CloseNpcRequestPacket',
    'ConsumeItemRequest075Packet',
    'EnterGateRequest075Packet',
    'HitRequestPacket',
    'IncreaseCharacterStatPointPacket',
    'LoginShortPasswordPacket',
    'PickupItemRequest075Packet',
    'RequestCharacterListPacket',
    'SelectCharacterPacket',
    'SellItemToNpcRequestPacket',
    'TalkToNpcRequestPacket',
    'TargetedSkill095Packet',
    'WalkRequest075Packet',
  ],
  'ServerToClientPackets.ts': [
    'CharacterLevelUpdatePacket',
    'CurrentHealthAndShieldPacket',
    'CurrentManaAndAbilityPacket',
    'ExperienceGainedPacket',
    'GameServerEnteredPacket',
    'InventoryMoneyUpdatePacket',
    'ItemAddedToInventoryPacket',
    'ItemsDroppedPacket',
    'LoginResponseLoginResultEnum',
    'LoginResponsePacket',
    'MapChanged075Packet',
    'CharacterInventoryPacket',
    'MasterCharacterLevelUpdatePacket',
    'MasterSkillLevelUpdatePacket',
    'MasterStatsUpdatePacket',
    'MoneyDropped075Packet',
    'ObjectMovedPacket',
    'OpenNpcDialogPacket',
    'StoreItemListPacket',
    'StoreItemListItemWindowEnum',
    'MapObjectOutOfScopePacket',
    'NpcItemBuyFailedPacket',
    'NpcItemSellResultPacket',
    'NpcWindowResponseNpcWindowEnum',
    'NpcWindowResponsePacket',
    'ObjectGotKilledPacket',
    'ObjectWalked075Packet',
    'SkillListUpdatePacket',
  ],
};

// Helpers de src/common/utils que los packets generados usan en sus getters/setters.
// Copia literal: la firma es (byte, bits, leftShifted). Ojo con invertirla: un
// Count de byte entero se lee como GetByteValue(b, 8, 0) y con el orden al revés
// da siempre 0 (le pasó a una versión anterior de este script).
const HELPERS: Record<string, string> = {
  GetByteValue: `(byte: number, bits: number, leftShifted: number) =>
    ((byte >> leftShifted) & ((2 ** bits - 1) & 0xff)) & 0xff`,
  SetByteValue: `(oldValue: number, value: number, bits: number, leftShifted: number) => {
    const bitMask = ((2 ** bits - 1) & 0xff) << leftShifted;
    return ((oldValue & ((0xff - bitMask) & 0xff)) | (((value & 0xff) << leftShifted) & bitMask & 0xff));
  }`,
  GetBoolean: `(byte: number, leftShifted: number) => ((byte >> leftShifted) & 1) === 1`,
  SetBoolean: `(oldValue: number, value: boolean, leftShifted: number) => {
    oldValue &= (0xff - (1 << leftShifted)) & 0xff;
    return value ? oldValue | ((1 << leftShifted) & 0xff) : oldValue;
  }`,
};

// Corta un `export class X ... { ... }` / `export enum X {...}` completo,
// balanceando llaves para no cortar en un method que tenga strings o comentarios.
function extract(source: string, name: string): string | null {
  const start = source.search(new RegExp(`^export (class|enum) ${name}\\b`, 'm'));
  if (start < 0) return null;

  const open = source.indexOf('{', start);
  if (open < 0) return null;

  let depth = 0;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

const BANNER = `/**
 * GENERADO por extract-packets.ts — no editar a mano.
 *
 * Subconjunto de las clases de packets que el bot usa, extraído de
 * src/common/packets/*.ts del cliente MU JS. Ver AGENTS.md ("Trampas de protocolo") por qué el
 * bot no parsea el protocolo real con los XML del cliente.
 *
 * Para regenerar:  MU_SRC=~/self/mu/src bun run extract-packets.ts
 */`;

const missing: string[] = [];

for (const [file, names] of Object.entries(WANTED)) {
  const source = await readFile(join(SRC, file), 'utf-8');
  const chunks: string[] = [];

  for (const name of names) {
    const chunk = extract(source, name);
    if (!chunk) {
      missing.push(`${file}:${name}`);
      continue;
    }
    chunks.push(chunk);
  }

  const helperSrc = Object.entries(HELPERS)
    .map(([k, v]) => `const ${k} = ${v};`)
    .join('\n\n');

  await mkdir(join(HERE, 'packets'), { recursive: true });
  await writeFile(
    join(HERE, 'packets', file),
    `${BANNER}\n\n${helperSrc}\n\n${chunks.join('\n\n')}\n`,
    'utf-8',
  );
  console.log(`${file}: ${chunks.length}/${names.length} clases`);
}

// Tabla de rutas: code/subcode -> nombre de evento, para TODOS los packets S2C del
// repo y en el mismo orden. net/socket.ts resuelve con el mismo `find` que el
// createSocket del cliente, así que el nombre del evento que emite (y las trampas
// de "code compartido", ver AGENTS.md) quedan idénticos aunque el bot solo tenga
// un subconjunto de las clases.
const { ConnectServerPackets } = await import(join(SRC, 'ConnectServerPackets.ts'));
const { ServerToClientPackets } = await import(join(SRC, 'ServerToClientPackets.ts'));
const routes = [...ConnectServerPackets, ...ServerToClientPackets]
  .filter((p: any) => p.Direction === 'ServerToClient')
  .map((p: any) => ({ name: p.name, Name: p.Name, Code: p.Code, SubCode: p.SubCode ?? null, HeaderType: p.HeaderType }));
await writeFile(
  join(HERE, 'packets', 'routes.ts'),
  `${BANNER}\n\nexport type PacketRoute = { name: string; Name: string; Code: number; SubCode: number | null; HeaderType: string };\n\nexport const S2C_ROUTES: readonly PacketRoute[] = ${JSON.stringify(routes, null, 1)};\n`,
  'utf-8',
);
console.log(`routes.ts: ${routes.length} rutas S2C`);

// Barrel único, para que el bot importe de un solo lugar.
await writeFile(
  join(HERE, 'packets', 'index.ts'),
  `${BANNER}\n\nexport * from './ConnectServerPackets';\nexport * from './ClientToServerPackets';\nexport * from './ServerToClientPackets';\n`,
  'utf-8',
);

if (missing.length) {
  console.error(`\nFaltan ${missing.length} clase(s) — el bot se rompe:`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
console.log('\nTodo OK. Regenerado en packets/');