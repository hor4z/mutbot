/**
 * Caja ajena a los 10 s: los dueños (el que dio el golpe final y su party) tienen 10 s de prioridad
 * (TimeUntilDropIsFree de OpenMU); pasados, la caja es libre y gana el primero que la pide. Se espera
 * adyacente sin pedirla y se pide solo en la ventana [SNIPE_FROM_MS, SNIPE_TO_MS] desde que cayó, con el
 * ritmo de siempre (>= 0,6 s entre pedidos, con variación). Lógica pura (reloj por parámetro); MUBOT_SNIPE=0 la apaga.
 */
export const SNIPE_FROM_MS = 9500;
export const SNIPE_TO_MS = 14_000;
export const SNIPE_MIN_GAP_MS = 600;
export const SNIPE_JITTER_MS = 300;
export const snipeOn = () => process.env.MUBOT_SNIPE !== '0';
export type SnipeAction = 'hold' | 'pick' | 'giveup';
/** `ageMs`: desde que cayó la caja; `sinceLastPickMs`: desde el último pedido (null si no hubo); `rand` en [0,1). */
export function snipeAction(ageMs: number, sinceLastPickMs: number | null, rand: number): SnipeAction {
  if (ageMs > SNIPE_TO_MS) return 'giveup';
  if (ageMs < SNIPE_FROM_MS) return 'hold';
  return sinceLastPickMs == null || sinceLastPickMs >= SNIPE_MIN_GAP_MS + rand * SNIPE_JITTER_MS ? 'pick' : 'hold';
}
