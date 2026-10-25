/**
 * Orquestador de la escuadra: decide quién lidera y quién es su sombra. Una instancia por servidor (`Orquestadores` las crea): un servidor
 * es un mundo aparte, así que un personaje solo se relaciona con los de su mismo servidor, y no hay forma de mezclarlos.
 *
 * Reglas (las mismas de siempre): el más fuerte de los conectados (suma de stats) es el líder; los que tienen menos de la mitad de su fuerza
 * lo siguen como sombra por todos los mapas, salvo los que el usuario apagó. El nivel y los resets no cuentan (nivel 100 con 200 resets no es
 * nivel 100 con 0). Quien sigue a un humano no es sombra de ningún bot. Es lógica pura (sin sockets ni procesos): la estación le pasa los
 * miembros conectados y manda por el canal de los bots las órdenes que devuelve.
 */
import type { ServerKey } from './estacion-logic';

/** Un personaje conectado y en el juego. */
export type Miembro = { key: string; char: string; server: ServerKey; power: number };
/** A qué humano sigue un personaje (por nombre; con posición opcional para ir a buscarlo). */
export type Humano = { name: string; map?: number; x?: number; y?: number };
/** La orden de un miembro: a quién sigue (líder), quiénes lo siguen y el humano al que sigue, si lo hay. */
export type Orden = { lider: string | null; sombras: string[]; humano: Humano | null };

/** Con menos de esta fracción de la fuerza del líder, un personaje es su sombra. */
export const RATIO_SOMBRA = 0.5;

export class Orquestador {
  private readonly apagadas = new Set<string>();
  private readonly humanos = new Map<string, Humano>();
  private lideres = new Map<string, string>(); // clave del miembro → nombre del líder

  constructor(readonly server: ServerKey, private readonly sombrasActivas: () => boolean = () => true) {}

  /** El usuario apaga (o vuelve a prender) que un personaje sea sombra. */
  apagarSombra(key: string, apagada: boolean) {
    if (apagada) this.apagadas.add(key); else this.apagadas.delete(key);
  }
  sombraApagada = (key: string) => this.apagadas.has(key);

  /** Un personaje sigue a un humano (null: deja de seguirlo). En memoria: se vuelve a pedir tras reiniciar la estación. */
  seguirHumano(key: string, humano: Humano | null) {
    if (humano) this.humanos.set(key, humano); else this.humanos.delete(key);
  }

  /** A quién sigue como sombra este personaje (la última asignación). */
  sombraDe = (key: string) => this.lideres.get(key) ?? null;

  /** Reparte los roles entre los miembros de ESTE servidor y devuelve la orden de cada uno. */
  asignar(miembros: readonly Miembro[]): Map<string, Orden> {
    const mios = miembros.filter((m) => m.server === this.server);
    this.lideres = new Map();
    const lider = mios.length > 1 ? mios.reduce((a, b) => (b.power > a.power ? b : a)) : null;
    if (lider && this.sombrasActivas()) {
      for (const m of mios) {
        const debil = m.power > 0 && m.power < lider.power * RATIO_SOMBRA;
        if (m !== lider && debil && !this.apagadas.has(m.key) && !this.humanos.has(m.key)) this.lideres.set(m.key, lider.char);
      }
    }
    const ordenes = new Map<string, Orden>();
    for (const m of mios) {
      const sombras = mios.filter((o) => this.lideres.get(o.key) === m.char).map((o) => o.char);
      ordenes.set(m.key, { lider: this.lideres.get(m.key) ?? null, sombras, humano: this.humanos.get(m.key) ?? null });
    }
    return ordenes;
  }
}

/** Una instancia por servidor, creadas cuando hacen falta. */
export class Orquestadores {
  private readonly porServidor = new Map<ServerKey, Orquestador>();
  constructor(private readonly sombrasActivas: () => boolean = () => true) {}

  de(server: ServerKey): Orquestador {
    let o = this.porServidor.get(server);
    if (!o) this.porServidor.set(server, (o = new Orquestador(server, this.sombrasActivas)));
    return o;
  }

  /** Reparte los roles de todos los servidores a la vez; cada orquestador solo ve a los suyos. */
  asignar(miembros: readonly Miembro[]): Map<string, Orden> {
    const todas = new Map<string, Orden>();
    for (const server of new Set([...miembros.map((m) => m.server), ...this.porServidor.keys()]))
      for (const [k, o] of this.de(server).asignar(miembros)) todas.set(k, o);
    return todas;
  }
}
