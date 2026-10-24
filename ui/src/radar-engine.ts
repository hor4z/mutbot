import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { PanelState } from "../../panel-protocol";
import { tileKind, TILE_LABEL } from "./hud-logic";
import { getTerrain, loadRealMap, type RealMap } from "./map-assets";
import { KIND_COLOR, describe, entities, type Ent, type Info, type Layers } from "./radar-model";

export type RadarApi = {
  update: (s: PanelState) => void;
  setLayers: (l: Layers) => void;
  /** "cam" = cámara pegada al personaje, al ángulo del juego, con nombres; "40" / "90" / "256" = alcance en tiles */
  zoom: (v: string) => void;
  reset: () => void;
  setObjects: (visible: boolean) => void;
  setFollow: (on: boolean) => void;
  /** gira la cámara (radianes, suave) */
  rotate: (rad: number) => void;
  /** acerca (<1) o aleja (>1) la cámara, suave */
  dolly: (factor: number) => void;
  northUp: () => void;
  centerOn: (x: number, y: number) => void;
  dispose: () => void;
};
export type RadarCallbacks = {
  terrain: (s: string) => void;
  hover: (i: Info | null, px: number, py: number) => void;
  pick: (i: Info, px: number, py: number) => void;
  /** grados que gira la aguja del norte y tiles que abarca el ancho de la vista */
  view: (needleDeg: number, tiles: number) => void;
  /** el usuario movió la cámara a mano (paneo): el seguimiento se suelta */
  free: () => void;
};

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Radar 3D (Three.js): terreno real del cliente si hay assets, colisiones si no. Marcadores sobre el terreno. */
export function makeRadar(el: HTMLDivElement, cb: RadarCallbacks): RadarApi {
  const onTerrain = cb.terrain;
  const scene = new T.Scene();
  scene.background = new T.Color("#0f1417");
  scene.fog = new T.FogExp2("#0f1417", 0.002);
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.setClearColor("#0f1417");
  el.appendChild(renderer.domElement);
  // Nombres arriba de monstruos y jugadores (solo en modo cámara).
  const labels = new CSS2DRenderer();
  labels.domElement.className = "radar-labels";
  labels.domElement.style.display = "none";
  el.appendChild(labels.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Radar 3D. Arrastrá para girar, rueda para acercar. Flechas giran y elevan, más y menos acercan, Home centra.",
  );
  renderer.domElement.tabIndex = 0;
  const camera = new T.PerspectiveCamera(42, 1, 0.1, 2500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 10;
  controls.maxDistance = 1600;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minPolarAngle = 0.12;
  controls.enablePan = true;
  controls.target.set(0, 0, 0);
  camera.position.set(34, 39, 34);
  controls.update();
  scene.add(new T.HemisphereLight(0xe8f1ff, 0x4b5040, 1.7));
  const sun = new T.DirectionalLight(0xffefd5, 1.8);
  sun.position.set(-25, 60, 30);
  scene.add(sun);
  const fill = new T.DirectionalLight(0xb2d8f0, 0.5);
  fill.position.set(30, 10, -20);
  scene.add(fill);
  const ground = new T.Group(),
    entitiesGroup = new T.Group();
  scene.add(ground, entitiesGroup);
  let state: PanelState | null = null,
    layers: Layers | null = null,
    map = -1,
    span = 40,
    cam = false,
    follow = true,
    terrain: Uint8Array | null = null,
    terrainAbort: AbortController | null = null,
    disposed = false,
    frame = 0,
    visible = true,
    lastDraw = 0,
    lastNeedle = 999,
    lastTiles = 0,
    patchKey = "";
  let real: RealMap | null = null;
  let realAbort: AbortController | null = null;
  let objectsVisible = true;
  const elevation = (x: number, y: number) => real?.height(x, y) ?? 0;
  const matrix = new T.Object3D();
  const wallMat = new T.MeshStandardMaterial({ color: 0x58666b, roughness: 0.65, metalness: 0.15 });
  const floorMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.04 });
  const walls = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), wallMat, 65536);
  const floors = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), floorMat, 65536);
  walls.count = 0;
  floors.count = 0;
  walls.frustumCulled = false;
  floors.frustumCulled = false;
  ground.add(floors, walls);
  const base = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial({ color: 0x151f25, roughness: 0.7 }));
  ground.add(base);
  const grid = new T.GridHelper(256, 64, 0x405055, 0x26383e);
  grid.position.set(127.5, 0.04, -127.5);
  scene.add(grid);
  const lineMat = new T.LineBasicMaterial({ color: 0xd2b679, transparent: true, opacity: 0.75 });
  const trail = new T.Line(new T.BufferGeometry(), lineMat);
  entitiesGroup.add(trail);
  const pool = new Map<string, T.Group>();
  // Zonas de avistamiento de dragones (de la base) y celdas letales: discos en el piso.
  const zoneGroup = new T.Group();
  scene.add(zoneGroup);
  const zoneMat = new T.MeshBasicMaterial({ color: 0xffd361, transparent: true, opacity: 0.18, depthWrite: false, side: T.DoubleSide });
  const zoneRingMat = new T.MeshBasicMaterial({ color: 0xffd361, transparent: true, opacity: 0.55, depthWrite: false, side: T.DoubleSide });
  const hazMat = new T.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.22, depthWrite: false, side: T.DoubleSide });
  const hazRingMat = new T.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.8, depthWrite: false, side: T.DoubleSide });
  let zoneKey = "";
  function clearZones() {
    for (const c of [...zoneGroup.children]) {
      zoneGroup.remove(c);
      (c.getObjectByName("tag") as CSS2DObject | undefined)?.element.remove();
      c.traverse((o) => {
        if (o instanceof T.Mesh) o.geometry.dispose();
      });
    }
  }
  function drawZones(s: PanelState) {
    const L = layers;
    const key = `${s.where.map}:${L?.zones}:${L?.hazards}:${JSON.stringify(s.zones ?? [])}:${JSON.stringify(s.hazards ?? [])}:${!!real}`;
    if (key === zoneKey) return;
    zoneKey = key;
    clearZones();
    const add = (x: number, y: number, r: number, disc: T.Material, edge: T.Material, tag: string, label: string, cls: string) => {
      const g = new T.Group();
      const d = new T.Mesh(new T.CircleGeometry(r, 40), disc);
      const e = new T.Mesh(new T.RingGeometry(r - 0.25, r, 40), edge);
      d.rotation.x = e.rotation.x = -Math.PI / 2;
      g.add(d, e);
      const div = document.createElement("div");
      div.className = `radar-tag ${cls}`;
      div.textContent = tag;
      const t = new CSS2DObject(div);
      t.name = "tag";
      t.position.y = 1.2;
      g.add(t);
      g.position.set(x, elevation(x, y) + 0.12, -y);
      g.userData.zone = { x, y, label };
      zoneGroup.add(g);
    };
    if (L?.zones !== false)
      for (const z of s.zones ?? []) add(z.x, z.y, 6, zoneMat, zoneRingMat, `Dragones ×${z.n}`, `Zona de dragones · ${z.n} avistamientos`, "radar-tag-gold");
    if (L?.hazards !== false)
      for (const z of s.hazards ?? []) add(z.x, z.y, 2 + Math.min(z.n, 6) * 0.6, hazMat, hazRingMat, `Letal ×${z.n}`, `Celda letal · ${z.n} muertes`, "radar-tag-red");
  }
  // Lo que falta mover de la cámara para seguir al personaje (se aplica de a poco en animate).
  const followDelta = new T.Vector3();
  let spinLeft = 0,
    dollyLeft = 0;
  const sphere = new T.SphereGeometry(0.42, 12, 8),
    body = new T.CylinderGeometry(0.28, 0.45, 0.85, 8),
    cone = new T.ConeGeometry(0.6, 1.5, 6),
    gem = new T.OctahedronGeometry(0.7),
    ring = new T.TorusGeometry(0.85, 0.065, 6, 36);
  const materials = new Map<number, T.MeshStandardMaterial>();
  function material(color: number) {
    if (!materials.has(color))
      materials.set(
        color,
        new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, metalness: 0.35, roughness: 0.4, depthTest: true, depthWrite: true }),
      );
    return materials.get(color)!;
  }
  const haloMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
  const halo = new T.Mesh(new T.RingGeometry(0.8, 1.4, 48), haloMat);
  halo.rotation.x = -Math.PI / 2;
  scene.add(halo);
  function marker(e: Ent) {
    const kind = e.kind;
    let group = pool.get(e.key);
    if (!group) {
      group = new T.Group();
      const mat = material(KIND_COLOR[kind]);
      if (kind === "self" || kind === "player" || kind === "mate" || kind === "squad") {
        const b = new T.Mesh(body, mat);
        b.position.y = 0.425;
        const h = new T.Mesh(sphere, mat);
        h.position.y = 1.1;
        group.add(b, h);
      } else {
        const mesh = new T.Mesh(kind === "monster" ? cone : gem, mat);
        mesh.position.y = kind === "monster" ? 0.9 : 1;
        // Los dragones, más grandes: se ven de lejos; el loot común, chico.
        if (kind === "dragon" || kind === "red") mesh.scale.setScalar(1.7);
        if (kind === "dropdim") mesh.scale.setScalar(0.5);
        group.add(mesh);
      }
      const r = new T.Mesh(ring, mat);
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.07;
      r.name = "ring";
      group.add(r);
      const div = document.createElement("div");
      div.className = `radar-tag radar-tag-${kind}`;
      const t = new CSS2DObject(div);
      t.position.y = kind === "self" || kind === "player" ? 1.9 : 2;
      t.name = "tag";
      group.add(t);
      pool.set(e.key, group);
      entitiesGroup.add(group);
    }
    group.visible = true;
    // Destino: el animate lo desliza hasta ahí (la posición llega una vez por segundo).
    const to = new T.Vector3(e.x, elevation(e.x, e.y) + 0.02, -e.y);
    if (!group.userData.to) group.position.copy(to);
    group.userData.to = to;
    const scale = kind === "self" || kind === "player" || kind === "mate" || cam ? 1 : Math.max(1, span / 65);
    group.scale.setScalar(scale);
    group.userData.ent = e;
    const tagObj = group.getObjectByName("tag") as CSS2DObject;
    // En cámara, nombres solo cerca del personaje (a <= 9 tiles), el objetivo y los dorados.
    const me = state?.where;
    const near = !!me && Math.hypot(e.x - me.x, e.y - me.y) <= 9;
    tagObj.visible = cam && kind !== "dropdim" && kind !== "camp" && (kind === "self" || kind === "gold" || kind === "dragon" || kind === "red" || !!e.target || near);
    if (tagObj.element.textContent !== e.name) tagObj.element.textContent = e.name;
    tagObj.element.classList.toggle("is-target", !!e.target);
    group.userData.target = !!e.target;
    group.getObjectByName("ring")!.visible = kind === "self" || kind === "camp" || !!e.target;
  }
  function reset() {
    if (!state) return;
    const bounds = real?.bounds ?? [0, 0, 256, 256];
    const cx = (bounds[0] + bounds[2]) / 2,
      cy = (bounds[1] + bounds[3]) / 2;
    const fit = span >= 256 ? Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 1.05 : span;
    const target =
      span >= 256 ? new T.Vector3(cx, elevation(cx, cy), -cy) : new T.Vector3(state.where.x, elevation(state.where.x, state.where.y), -state.where.y);
    controls.target.copy(target);
    followDelta.set(0, 0, 0);
    spinLeft = dollyLeft = 0;
    // Cámara: más cerca y más baja, como se ve el personaje en el juego.
    const offset = cam ? new T.Vector3(8.5, 11, 8.5) : new T.Vector3(fit * 0.65, fit * 0.85, fit * 0.7);
    if (span >= 256) {
      const vertical = T.MathUtils.degToRad(camera.fov);
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
      const radius = Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2;
      offset.normalize().multiplyScalar((radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.06);
    }
    camera.position.copy(target).add(offset);
    controls.update();
  }
  function buildGround() {
    if (!state) return;
    ground.visible = !real;
    grid.visible = !real && !terrain;
    if (real) return;
    const radius = span >= 256 ? 256 : Math.ceil(span * 0.85);
    const x0 = span >= 256 ? 0 : Math.max(0, Math.floor(state.where.x - radius)),
      x1 = span >= 256 ? 256 : Math.min(256, Math.ceil(state.where.x + radius));
    const y0 = span >= 256 ? 0 : Math.max(0, Math.floor(state.where.y - radius)),
      y1 = span >= 256 ? 256 : Math.min(256, Math.ceil(state.where.y + radius));
    const key = `${map}:${x0 >> 2}:${y0 >> 2}:${span}:${!!terrain}`;
    if (patchKey === key) return;
    patchKey = key;
    let wi = 0,
      fi = 0;
    const color = new T.Color();
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = terrain?.[y * 256 + x] ?? 0;
        if (terrain && v & 12) {
          matrix.position.set(x, 0.8, -y);
          matrix.scale.set(1, 1.65, 1);
          matrix.updateMatrix();
          walls.setMatrixAt(wi++, matrix.matrix);
        } else {
          matrix.position.set(x, -0.15, -y);
          matrix.scale.set(0.985, 0.3, 0.985);
          matrix.updateMatrix();
          floors.setMatrixAt(fi, matrix.matrix);
          color.setHex(!terrain ? 0x1e3037 : v & 1 ? 0x294d43 : v & 16 ? 0x254957 : (x + y) % 2 ? 0x34454b : 0x314148);
          floors.setColorAt(fi++, color);
        }
      }
    walls.count = wi;
    walls.instanceMatrix.needsUpdate = true;
    floors.count = fi;
    floors.instanceMatrix.needsUpdate = true;
    if (floors.instanceColor) floors.instanceColor.needsUpdate = true;
    base.position.set((x0 + x1 - 1) / 2, -1, -(y0 + y1 - 1) / 2);
    base.scale.set(x1 - x0, 1.5, y1 - y0);
    grid.visible = !terrain;
  }
  function update(s: PanelState) {
    const previous = state;
    state = s;
    if (previous && previous.where.map === s.where.map && span < 256 && follow) {
      // La cámara sigue al personaje deslizándose (followDelta se aplica de a poco en animate).
      followDelta.add(
        new T.Vector3(
          s.where.x - previous.where.x,
          elevation(s.where.x, s.where.y) - elevation(previous.where.x, previous.where.y),
          previous.where.y - s.where.y,
        ),
      );
    }
    if (map !== s.where.map) {
      map = s.where.map;
      // Mapa nuevo: nada se desliza desde el mapa anterior (aparece directo en su lugar).
      pool.forEach((g) => delete g.userData.to);
      followDelta.set(0, 0, 0);
      realAbort?.abort();
      if (real) {
        scene.remove(real.group);
        real.dispose();
        real = null;
      }
      patchKey = "";
      terrain = null;
      reset();
      terrainAbort?.abort();
      terrainAbort = new AbortController();
      const thisMap = map;
      {
        realAbort = new AbortController();
        const controller = realAbort;
        onTerrain("Cargando mapa original…");
        loadRealMap(map, controller.signal, (text) => {
          if (!disposed && map === thisMap) onTerrain(text);
        })
          .then((loaded) => {
            if (disposed || controller.signal.aborted || map !== thisMap) {
              loaded.dispose();
              return;
            }
            real = loaded;
            real.setObjects(objectsVisible);
            scene.add(real.group);
            ground.visible = false;
            grid.visible = false;
            zoneKey = "";
            if (state) {
              update(state);
              reset();
            }
            onTerrain(`Mapa original · ${loaded.objectCount.toLocaleString("es-AR")} objetos${loaded.missingTypes ? " · escenario parcial" : ""}`);
          })
          .catch(() => {
            if (!disposed && !controller.signal.aborted && map === thisMap) onTerrain("Vista de colisiones · escenario original no disponible");
          });
      }
      getTerrain(map, terrainAbort.signal)
        .then((b) => {
          if (disposed || map !== thisMap || !b) return;
          terrain = b;
          patchKey = "";
          buildGround();
        })
        .catch(() => {});
    }
    buildGround();
    drawZones(s);
    pool.forEach((g) => (g.visible = false));
    const L = layers ?? undefined;
    for (const e of entities(s, L ?? { monsters: true, golds: true, players: true, squad: true, loot: true, route: true, zones: true, hazards: true, fog: true })) marker(e);
    halo.position.set(s.where.x, elevation(s.where.x, s.where.y) + 0.06, -s.where.y);
    halo.scale.setScalar(Math.max(1, span / 65));
    for (const [key, g] of pool)
      if (!g.visible) {
        entitiesGroup.remove(g);
        // El CSS2DRenderer no saca del DOM el cartel de un objeto que ya no está en la escena.
        (g.getObjectByName("tag") as CSS2DObject | undefined)?.element.remove();
        pool.delete(key);
      }
    trail.geometry.dispose();
    trail.geometry = new T.BufferGeometry().setFromPoints(
      layers?.route === false ? [] : (s.trail ?? []).map(([x, y]) => new T.Vector3(x, elevation(x, y) + 0.18, -y)),
    );
  }
  // ---- Puntero: hover con datos y clic con coordenadas -------------------------------------------
  const raycaster = new T.Raycaster();
  const pointer = new T.Vector2();
  const plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
  function probe(ev: PointerEvent): { info: Info | null; px: number; py: number; tile?: Info } {
    const rc = renderer.domElement.getBoundingClientRect();
    const px = ev.clientX - rc.left,
      py = ev.clientY - rc.top;
    pointer.set((px / rc.width) * 2 - 1, -(py / rc.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // Marcadores (con una tolerancia: se agrandan al apuntar) y zonas.
    const hit = raycaster.intersectObjects([...pool.values(), ...zoneGroup.children], true)[0];
    let o: T.Object3D | undefined = hit?.object;
    while (o && !o.userData.ent && !o.userData.zone) o = o.parent ?? undefined;
    let tile: Info | undefined;
    const point = real ? raycaster.intersectObject(real.group.children[0]!, false)[0]?.point : raycaster.ray.intersectPlane(plane, new T.Vector3()) ?? undefined;
    if (point) {
      const x = Math.floor(point.x),
        y = Math.floor(-point.z);
      if (x >= 0 && y >= 0 && x < 256 && y < 256) {
        const v = real ? real.flags[y * 256 + x]! : terrain?.[y * 256 + x];
        tile = {
          title: `Tile ${x}, ${y}`,
          kind: "tile",
          x,
          y,
          lines: [v == null ? "Terreno sin datos" : TILE_LABEL[tileKind(v)], ...(real ? [`Altura ${elevation(x, y).toFixed(1)}`] : [])],
        };
      }
    }
    if (o?.userData.ent && state) return { info: describe(o.userData.ent as Ent, state), px, py, tile };
    if (o?.userData.zone) {
      const z = o.userData.zone as { x: number; y: number; label: string };
      return { info: { title: z.label, kind: "zone", x: z.x, y: z.y, lines: [`Posición ${z.x}, ${z.y}`] }, px, py, tile };
    }
    return { info: tile ?? null, px, py, tile };
  }
  const onMove = (ev: PointerEvent) => {
    if (down) return;
    const p = probe(ev);
    cb.hover(p.info, p.px, p.py);
  };
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (ev: PointerEvent) => {
    down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    cb.hover(null, 0, 0);
  };
  const onUp = (ev: PointerEvent) => {
    const d = down;
    down = null;
    if (!d) return;
    const moved = Math.hypot(ev.clientX - d.x, ev.clientY - d.y);
    if (moved > 5 || performance.now() - d.t > 450) {
      // Arrastre: si fue paneo (botón derecho / shift) la cámara ya no sigue sola.
      if (ev.button === 2 || ev.shiftKey || ev.ctrlKey || ev.metaKey) cb.free();
      return;
    }
    const p = probe(ev);
    if (p.info) cb.pick(p.info, p.px, p.py);
  };
  const leave = () => cb.hover(null, 0, 0);
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointerleave", leave);
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  const keyboard = (e: KeyboardEvent) => {
    if (e.key === "Home") {
      e.preventDefault();
      reset();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") spinLeft += e.key === "ArrowLeft" ? 0.2 : -0.2;
      else {
        const offset = camera.position.clone().sub(controls.target);
        offset.y = Math.max(4, offset.y + (e.key === "ArrowUp" ? 4 : -4));
        camera.position.copy(controls.target).add(offset);
        controls.update();
      }
    }
  };
  renderer.domElement.addEventListener("keydown", keyboard);
  const resize = new ResizeObserver(() => {
    const w = el.clientWidth,
      h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (span >= 256) reset();
  });
  resize.observe(el);
  const intersection = new IntersectionObserver((entries) => (visible = entries[0]?.isIntersecting ?? true));
  intersection.observe(el);
  const tmp = new T.Vector3();
  function animate(t: number) {
    frame = requestAnimationFrame(animate);
    if (!visible || document.hidden || t - lastDraw < 32) return;
    const dt = Math.min(200, t - lastDraw);
    lastDraw = t;
    const snap = reduced();
    // Deslizar hacia el destino (~90 % en 0,7 s: llega antes de la próxima posición).
    const k = snap ? 1 : 1 - Math.exp(-dt / 300);
    for (const g of pool.values()) {
      const to = g.userData.to as T.Vector3 | undefined;
      if (to) g.position.lerp(to, k);
    }
    const self = pool.get("self");
    if (self) halo.position.set(self.position.x, self.position.y + 0.04, self.position.z);
    if (followDelta.lengthSq() > 1e-6) {
      const step = followDelta.clone().multiplyScalar(k);
      controls.target.add(step);
      camera.position.add(step);
      followDelta.sub(step);
    }
    const kc = snap ? 1 : 1 - Math.exp(-dt / 140);
    if (Math.abs(spinLeft) > 1e-3) {
      const step = spinLeft * kc;
      tmp.copy(camera.position).sub(controls.target).applyAxisAngle(new T.Vector3(0, 1, 0), step);
      camera.position.copy(controls.target).add(tmp);
      spinLeft -= step;
    }
    if (Math.abs(dollyLeft) > 1e-3) {
      const step = dollyLeft * kc;
      tmp.copy(camera.position).sub(controls.target).multiplyScalar(Math.exp(step));
      const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, tmp.length()));
      camera.position.copy(controls.target).add(tmp.setLength(len));
      dollyLeft -= step;
    }
    // El objetivo del personaje late (en cámara se ve a quién le está pegando).
    const pulse = snap ? 1 : 1 + 0.25 * Math.sin(t / 140);
    for (const g of pool.values()) if (g.userData.target) g.getObjectByName("ring")!.scale.setScalar(cam ? pulse : 1);
    controls.update();
    // Brújula y escala: solo se avisa si cambiaron.
    const off = tmp.copy(camera.position).sub(controls.target);
    const len = Math.hypot(off.x, off.z) || 1;
    const ux = -off.x / len,
      uz = -off.z / len;
    const needle = (Math.atan2(-ux, -uz) * 180) / Math.PI;
    const tiles = 2 * off.length() * Math.tan(T.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
    if (Math.abs(needle - lastNeedle) > 0.4 || Math.abs(tiles - lastTiles) > 0.5) {
      lastNeedle = needle;
      lastTiles = tiles;
      cb.view(needle, tiles);
    }
    renderer.render(scene, camera);
    if (cam) labels.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  return {
    update,
    setLayers(l) {
      layers = l;
      zoneKey = "";
      if (state) update(state);
    },
    setObjects(v) {
      objectsVisible = v;
      real?.setObjects(v);
    },
    setFollow(on) {
      follow = on;
      if (on && state) {
        const to = new T.Vector3(state.where.x, elevation(state.where.x, state.where.y), -state.where.y);
        followDelta.copy(to).sub(controls.target);
      } else followDelta.set(0, 0, 0);
    },
    rotate(rad) {
      spinLeft += rad;
    },
    dolly(f) {
      dollyLeft += Math.log(f);
    },
    northUp() {
      const off = camera.position.clone().sub(controls.target);
      spinLeft = -Math.atan2(off.x, off.z);
    },
    centerOn(x, y) {
      followDelta.set(x, elevation(x, y), -y).sub(controls.target);
      follow = false;
    },
    zoom(v) {
      cam = v === "cam";
      span = cam ? 16 : +v;
      labels.domElement.style.display = cam ? "" : "none";
      if (state) update(state);
      patchKey = "";
      buildGround();
      reset();
    },
    reset,
    dispose() {
      disposed = true;
      terrainAbort?.abort();
      realAbort?.abort();
      if (real) {
        scene.remove(real.group);
        real.dispose();
      }
      cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("keydown", keyboard);
      clearZones();
      const geometries = new Set<T.BufferGeometry>();
      const mats = new Set<T.Material>();
      scene.traverse((o) => {
        if (o instanceof T.Mesh || o instanceof T.Line) {
          geometries.add(o.geometry);
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
        }
      });
      geometries.forEach((g) => g.dispose());
      [sphere, body, cone, gem, ring].forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      mats.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.domElement.remove();
    },
  };
}
