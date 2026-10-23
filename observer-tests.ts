import { ObserverTracker } from './observer';

const ok = (name: string, pass: boolean) => { if (!pass) throw new Error(name); console.log(`PASS  ${name}`); };
const p = (x: number, y: number) => [{ id: 1, name: 'CualquierJugador', x, y }];
{
  const t = new ObserverTracker();
  ok('un encuentro breve no se interpreta como observación', t.update(0, 0, { x: 10, y: 10 }, p(12, 10)) === null);
  t.update(15_000, 0, { x: 10, y: 10 }, p(12, 10));
  ok('quieto cerca durante 30 s se registra', t.update(30_000, 0, { x: 10, y: 10 }, p(12, 10))?.kind === 'quieto');
  ok('otro mapa borra la presencia anterior', t.update(31_000, 2, { x: 10, y: 10 }, p(12, 10)) === null);
}
{
  const t = new ObserverTracker();
  t.update(0, 0, { x: 10, y: 10 }, p(12, 10));
  t.update(25_000, 0, { x: 18, y: 10 }, p(20, 10)); // pasado el plazo: empieza de nuevo
  ok('una ausencia larga no acumula observación', t.update(30_000, 0, { x: 20, y: 10 }, p(22, 10)) === null);
}
{
  const t = new ObserverTracker();
  t.update(0, 0, { x: 10, y: 10 }, p(12, 10));
  t.update(15_000, 0, { x: 15, y: 10 }, p(17, 10));
  t.update(30_000, 0, { x: 20, y: 10 }, p(22, 10));
  ok('quien acompaña el recorrido largo aparece tras 45 s', t.update(45_000, 0, { x: 25, y: 10 }, p(27, 10))?.kind === 'acompaña');
}
