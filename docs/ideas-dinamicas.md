# Ideas de dinámicas nuevas

Ordenadas por lo que más acerca a Hume a un buen set. Cada una dice qué hay que verificar en vivo antes de confiar.

1. **Hume cobrador, el resto ayuda.** La caja de un dorado es de quien más daño hizo, o se sortea entre los que la piden
   (HANDOFF). Con una escuadra, los ayudantes bajan la vida del dragón y Hume (o quien necesite el set) mete el golpe final y
   más daño. Verificar: cómo reparte el server exactamente (daño vs. sorteo) con una caja de prueba.
2. **Mulas.** Otros personajes levantan Cristales, cajas y talismanes y se los pasan a Hume (trade entre cuentas propias).
   Verificar: packets de trade 0.97d y si el server deja tradear cajas.
3. **Blood Castle en grupo.** Una caja +5 asegurada por hora (HANDOFF #6); la escuadra de 5 hace factible armar la capa,
   romper el portón y entregar el arma. Es la misión de escuadra con más retorno. Verificar: entrada, tickets y reglas en la
   guía de eventos (`/api/guides`, horarios).
4. **Reloj de eventos.** Planificar la hora: dorados a las :50, Blood Castle, Devil Square, Chaos Castle, según
   `docs/aprendizajes.md` y los horarios del server. Los bots llegan al mapa antes y no pierden minutos de búsqueda
   (hoy: 87 s hasta el primer dorado).
5. **Mapa de competencia.** Los exploradores publican jugadores y dorados vistos por mapa y hora; la estación arma un mapa de
   calor (UTC) y manda a cada cazador al campo con menos competencia. Ya existen `scouts` y `insights`.
6. **Seguro de vida.** Si un cazador baja de cierto HP real y no hay poción, se retira solo y avisa. Hoy Hume solo cree
   tener poco margen por el tope de 65.535 (ver `health.ts`). Con pociones (necesita tu autorización) deja de morir en Aida.
7. **Pruebas A/B de decisiones.** Usar `v_outcome` para comparar variantes (zona, skill, horario) entre bots con roles
   distintos y quedarse con la mejor, en vez de ajustar a mano.
8. **Reciclado.** Cristalizar la sobra del baúl (≈171 Cristales por tanda de 8, ver `docs/items-y-maquinas.md`) con
   confirmación tuya, y convertir los Cristales en cajas del Mercado.
