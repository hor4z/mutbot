/** En la página no hay base de datos: `@mubot/db` se reemplaza (ver build.ts) por esto, que no hace nada ni sale a ninguna red. */
export const dbOn = () => false;
export const dbRows = async <T = Record<string, unknown>>(_sql: string): Promise<T[]> => [];
export const dbInsert = async (_table: string, _rows: object[]): Promise<void> => {};
export const readDirectives = async (): Promise<Record<string, boolean | number>> => ({});
export const writeDirective = async (_k: string, _v: boolean | number): Promise<void> => {};
export const deleteDirective = async (_k: string): Promise<void> => {};
export const readSettings = async (): Promise<Record<string, string>> => ({});
export const writeSetting = async (_k: string, _v: string): Promise<void> => {};
export const readCharacter = async (): Promise<null> => null;
export const writeCharacter = async (_c: unknown): Promise<void> => {};
