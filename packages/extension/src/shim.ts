/**
 * El código del bot da por hecho `process` (argumentos y variables de entorno) y `Buffer`; en la página no existen. Va primero, antes de cargar el
 * resto. Del Buffer solo se usa `from` (texto en latin1 o utf8, o bytes), `byteLength`, `toString` (hex, latin1, utf8) y `subarray`.
 */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined>; argv: string[] }; Buffer?: unknown };
g.process ??= { env: {}, argv: [] };
// Sin mapas en disco ni bajada de mapas: el asistente no camina.
g.process.env.MUBOT_NO_SERVER_TERRAIN ??= '1';

class ShimBytes extends Uint8Array {
  override toString(enc: string = 'utf8'): string {
    if (enc === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');
    if (enc === 'latin1' || enc === 'binary') return Array.from(this, (b) => String.fromCharCode(b)).join('');
    return new TextDecoder().decode(this);
  }
}
const from = (src: string | ArrayLike<number>, enc: string = 'utf8'): ShimBytes => {
  if (typeof src === 'string') {
    return new ShimBytes(enc === 'latin1' || enc === 'binary' ? Array.from(src, (c) => c.charCodeAt(0) & 0xff) : new TextEncoder().encode(src));
  }
  return new ShimBytes(src);
};
g.Buffer ??= { from, byteLength: (text: string, enc: string = 'utf8') => from(text, enc).length };
