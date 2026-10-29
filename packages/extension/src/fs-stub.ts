/** En la página no hay disco: `node:fs` se reemplaza (ver build.ts) por esto. Ningún archivo existe y no se guarda nada. */
export const existsSync = (_path: string): boolean => false;
export const readFileSync = (_path: string): never => { throw new Error('sin disco en la página'); };
export const writeFileSync = (_path: string, _data: unknown): void => {};
export const mkdirSync = (_path: string, _opts?: unknown): void => {};
export const readdirSync = (_path: string): string[] => [];
export const statSync = (_path: string): never => { throw new Error('sin disco en la página'); };
export const unlinkSync = (_path: string): void => {};
export const appendFileSync = (_path: string, _data: unknown): void => {};
