# @mubot/panel

El panel de Capitan: React 19, Vite 8 y Tailwind 4, con el sistema de diseño de sherpa (tokens, Geist, paleta oscura y clara) en `src/index.css` y
iconos de Lucide. Una sola pantalla: conexión y órdenes, vitales y stats, el radar del bot en tiempo real y el feed de decisiones con su motivo.

```bash
bun run panel:dev     # Vite con HMR de React; /api y /terrain van a la estación (127.0.0.1:8787)
bun run panel:build   # un solo HTML autocontenido en packages/panel/dist/estacion.html; la estación lo sirve en /
```

- `src/App.tsx` (pantalla), `components.tsx` (panel, etiqueta, badge, botón, barra), `Radar.tsx` y `Tactical.tsx` (mapa 2D en canvas), `radar-model.ts`
  (capas y marcadores), `station-data.tsx` (sondeo de `/api/state` cada 1 s y acciones).
- Los tipos del estado y de las órdenes vienen de `@mubot/protocol`. El panel no manda código al bot: solo órdenes de la lista cerrada, vía la estación.
- `dist/` es un artefacto generado (ignorado por git): sin compilar, la estación responde 503 con el aviso.
