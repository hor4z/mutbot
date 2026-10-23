/**
 * Generador de nombres para personajes nuevos (la estación los sugiere al crear uno). Arma nombres
 * con dos diccionarios: raíces con peso (sombra, hierro, tormenta, en varios idiomas) y finales
 * de fantasía. El server pide de 4 a 10 letras o números (validación del cliente web), así que todo
 * lo que sale de acá ya cumple eso. Lógica pura: el azar entra por parámetro (tests).
 */

/** Raíces: palabras con peso de fantasía oscura, ya cortas para que entren en 10 letras. */
export const NAME_ROOTS = [
  'umbr', 'noct', 'mor', 'vex', 'drak', 'kael', 'zar', 'thal', 'vor', 'grim', 'ash', 'cinder', 'frost',
  'storm', 'iron', 'blood', 'shade', 'hex', 'rune', 'void', 'obsid', 'ember', 'raven', 'wolf', 'fang',
  'skull', 'bane', 'dusk', 'night', 'soul', 'thorn', 'gloom', 'blaze', 'onyx', 'nyx', 'erebo', 'tyr',
  'fenr', 'odin', 'loki', 'ragn', 'sarn', 'kor', 'val', 'xan', 'zeph', 'lyth', 'aeth', 'sol', 'lun',
  'astr', 'cael', 'seraf', 'nox', 'mort', 'tenebr', 'ferr', 'fulg', 'ign', 'glac', 'sombr', 'acer',
  'lobo', 'cuerv', 'fuego', 'hielo', 'trueno', 'rayo', 'ceniza', 'brasa', 'niebla', 'eclip',
] as const;

/** Finales que suenan a nombre propio. */
export const NAME_ENDINGS = [
  'ar', 'ax', 'or', 'on', 'us', 'is', 'ix', 'yx', 'ia', 'iel', 'ael', 'ion', 'eth', 'oth', 'en', 'an',
  'rok', 'mir', 'dor', 'gar', 'zar', 'wyn', 'ryn', 'lis', 'thor', 'mus', 'ra', 'ka', 'ven', 'ros',
  'heim', 'gard', 'fall', 'born', 'claw', 'fang', 'blade', 'mancer', 'lord', 'reaper', 'heart', 'bane',
] as const;

export const NAME_MIN = 4;
export const NAME_MAX = 10;
const NAME_RE = /^[A-Za-z0-9]+$/;

/** ¿Nombre que el server acepta? (4-10 letras o números, como el cliente web) */
export function validCharName(name: string): boolean {
  return name.length >= NAME_MIN && name.length <= NAME_MAX && NAME_RE.test(name);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Une raíz y final sin que se pisen las letras: si la raíz termina en vocal y el final empieza con
 * vocal, se saca una ("umbra" + "ion" → "umbrion"); tres consonantes iguales seguidas, igual.
 */
export function joinParts(root: string, ending: string): string {
  const vowel = (c: string) => 'aeiouy'.includes(c);
  let r = root;
  if (vowel(r.at(-1)!) && vowel(ending[0])) r = r.slice(0, -1);
  if (r.at(-1) === ending[0] && r.at(-2) === ending[0]) r = r.slice(0, -1);
  return cap(r + ending);
}

/**
 * Un nombre: raíz + final. `rand` devuelve [0, 1). Si no cierra en 10 letras, prueba otra
 * combinación; tras varios intentos, devuelve la raíz sola con un número.
 */
export function coolName(rand: () => number = Math.random): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  for (let i = 0; i < 20; i++) {
    const name = joinParts(pick(NAME_ROOTS), pick(NAME_ENDINGS));
    if (validCharName(name)) return name;
  }
  const base = cap(pick(NAME_ROOTS)).padEnd(NAME_MIN, 'x').slice(0, NAME_MAX - 2);
  return base + String(10 + Math.floor(rand() * 90));
}

/** `n` nombres distintos que no estén en `taken` (sin importar mayúsculas). */
export function coolNames(n: number, taken: Iterable<string> = [], rand: () => number = Math.random): string[] {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (let i = 0; out.length < n && i < n * 30; i++) {
    const name = coolName(rand);
    if (used.has(name.toLowerCase())) continue;
    used.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}
