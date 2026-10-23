# Rastrillaje de terreno y movimiento: qué dice la literatura y cómo se aplica al bot

Búsqueda web del 2026-10-23. Lo citado viene de resúmenes de papers y libros, no de haberlos leído completos. Lo marcado
**(propuesta)** es mi traducción al bot, no algo medido.

## 1. Cobertura de un área (coverage path planning)

- **Boustrophedon** (Choset y Pignon, 1997): se parte el mapa en celdas donde se barre con idas y vueltas simples, y
  se recorre el grafo de celdas vecinas. Es completo y sirve para áreas simples y convexas.
  [CMU](https://www.ri.cmu.edu/publications/coverage-path-planning-the-boustrophedon-decomposition)
- Una comparación de 2025 reporta que un recorrido en espiral fue en promedio 45 % más eficiente que el boustrophedon en
  sus experimentos. Es un solo estudio: no lo tomo como regla.
  [eudl.eu](https://eudl.eu/pdf/10.4108/eetiot.5433)
- Para cobertura de varios robots con árboles de expansión (STC) la búsqueda no trajo una fuente directa. Pendiente de
  buscar "spanning tree coverage Gabriely Rimon" y el survey de Choset (2001).

**(propuesta)** El bot ya parte los mapas en celdas de 25×25 y usa el terreno caminable. Dentro de una celda, un barrido
en serpentina cubre más con menos giros que ir a puntos sueltos. Entre celdas conviene el vecino más cercano
ponderado por valor (ver 2 y 3), no el orden fijo.

## 2. Exploración con varios robots (frontier-based)

- El método clásico (Burgard et al.) puntúa cada objetivo con **utilidad menos costo**: la utilidad es la información que
  se espera ganar y baja si otros robots van al mismo lugar o cerca; el costo crece con la distancia. Se asigna de a uno,
  de forma voraz. [Burgard 2005](https://www.ipb.uni-bonn.de/wp-content/papercite-data/pdf/burgard05tro.pdf)
- Variantes: repulsión explícita entre robots que se acercan al mismo sector
  ([arXiv 2603.07973](https://arxiv.org/pdf/2603.07973)); partición del mapa con un grafo de Voronoi (Wurm), que puede
  repartir desparejo; elegir candidatos independientes de la distancia mejora el resultado
  ([Faigl 2013](https://imr.ciirc.cvut.cz/uploads/Papers-pdfs/Faigl13ecmr.pdf)); y un asignador que pesa costo, ganancia
  de información y exploración contra explotación
  ([CMU MRSD](https://mrsdprojects.ri.cmu.edu/2022teamf/2022/12/09/task-allocation)). El survey más reciente:
  [arXiv 2503.07278](https://arxiv.org/pdf/2503.07278).

**(propuesta)** La estación ya junta los `scouts` de todos los exploradores (`/api/team`). Con eso puede asignar a cada
explorador la celda con mayor `valor − λ·distancia − repulsión por celdas ya asignadas o recién visitadas`, en vez de que
cada uno elija solo. Nada del reparto cambia el ritmo de movimiento de cada bot.

## 3. Teoría de la búsqueda (qué celda mirar primero)

- Búsqueda bayesiana: hay una distribución previa de dónde está el objetivo, un presupuesto de esfuerzo y una probabilidad
  de detección por esfuerzo. Se reparte el esfuerzo para maximizar la probabilidad de encontrarlo. Para objetivos que se
  mueven el problema se reduce a una secuencia de problemas estáticos
  ([Stone, Royset, Washburn](https://www.informs.org/ORMS-Today/ORMS-Today-Current-Issue/Search-Theory-Search-research)).
  La Guardia Costera de EE. UU. la usa para buscar gente en el mar.
- Los resultados clásicos suponen que el esfuerzo se reparte a voluntad; con restricciones de camino (el "constrained
  searcher path problem") es más difícil.

**(propuesta)** Para los dorados: el previo sale de la base (`v_dragon_zones`, `golden_seen` con posiciones y hora). Cada
celda tiene una probabilidad. Cuando el bot la recorre y no ve nada, su probabilidad baja por un factor (1 − p_detección),
y las demás suben en proporción. El orden de visita sale de `probabilidad ÷ costo de llegar`. Con pocos datos el previo
tiene que ser blando (mezcla con uniforme), porque hoy hay menos de 20 muertes de dorados medidas.

## 4. Caminar mejor

- A* con 8 vecinos solo mira ángulos de 45° y agrega en promedio un 8 % de camino en 2D. Theta* y Lazy Theta* encuentran
  caminos de cualquier ángulo con chequeos de línea de vista ([Any-angle path planning](https://en.wikipedia.org/wiki/Any-angle_path_planning)).
  Jump Point Search acelera A* sobre la grilla pero devuelve caminos pegados a ella; híbridos como AP-JPS buscan las dos
  cosas ([Harabor y Grastien](https://users.cecs.anu.edu.au/%7Edharabor/data/papers/harabor-grastien-icaps13.pdf)).

**(propuesta)** El mapa es 256×256: A* ya es barato, así que JPS no aporta. Lo que sí sirve es **suavizar el camino con
línea de vista** sobre el terreno caminable (menos zigzag, hasta ~8 % menos pasos). El bot camina a 380 ms por paso y ese
ritmo humano no se baja: la ganancia es solo de trayectoria, no de velocidad.

## 5. Qué NO sacar de acá

Nada de esto cambia los ritmos humanos ni los límites de AGENTS.md. Son formas de elegir adónde ir y en qué orden.
