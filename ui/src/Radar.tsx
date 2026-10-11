import { useEffect, useRef, useState } from "react";
import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Crosshair, RotateCcw, Move3d, Trees, Maximize } from "lucide-react";
import type { PanelState } from "../../panel-protocol";
import { Action, Segments } from "./components";
import { loadRealMap, type RealMap } from "./map-assets";

type RadarApi = {
  update: (s: PanelState) => void;
  zoom: (span: number) => void;
  reset: () => void;
  setObjects: (visible: boolean) => void;
  dispose: () => void;
};
const colors = {
  self: 0xf4d28e,
  monster: 0xe86d7b,
  gold: 0xffd361,
  player: 0x77c6f1,
  drop: 0xc6a0ff,
  camp: 0x6ad7b0,
};
function makeRadar(
  el: HTMLDivElement,
  onTerrain: (s: string) => void,
  onHover: (s: string) => void,
): RadarApi {
  const scene = new T.Scene();
  scene.background = new T.Color("#111619");
  scene.fog = new T.FogExp2("#111619", 0.002);
  const renderer = new T.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.setClearColor("#111619");
  el.appendChild(renderer.domElement);
  renderer.domElement.setAttribute(
    "aria-label",
    "Radar 3D. Arrastrá para girar, usá la rueda para acercar y el botón Centrar para volver al personaje.",
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
    entities = new T.Group();
  scene.add(ground, entities);
  let state: PanelState | null = null,
    map = -1,
    span = 40,
    terrain: Uint8Array | null = null,
    terrainAbort: AbortController | null = null,
    disposed = false,
    frame = 0,
    visible = true,
    lastDraw = 0,
    patchKey = "";
  let real: RealMap | null = null;
  let realAbort: AbortController | null = null;
  let objectsVisible = true;
  const elevation = (x: number, y: number) => real?.height(x, y) ?? 0;
  const cache = new Map<number, Uint8Array | null>();
  const matrix = new T.Object3D();
  const wallMat = new T.MeshStandardMaterial({
    color: 0x58666b,
    roughness: 0.65,
    metalness: 0.15,
  });
  const floorMat = new T.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    metalness: 0.04,
  });
  const walls = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), wallMat, 65536);
  const floors = new T.InstancedMesh(
    new T.BoxGeometry(1, 1, 1),
    floorMat,
    65536,
  );
  walls.count = 0;
  floors.count = 0;
  walls.frustumCulled = false;
  floors.frustumCulled = false;
  ground.add(floors, walls);
  const base = new T.Mesh(
    new T.BoxGeometry(1, 1, 1),
    new T.MeshStandardMaterial({ color: 0x151f25, roughness: 0.7 }),
  );
  ground.add(base);
  const grid = new T.GridHelper(256, 64, 0x405055, 0x26383e);
  grid.position.set(127.5, 0.04, -127.5);
  scene.add(grid);
  const lineMat = new T.LineBasicMaterial({
    color: 0xd2b679,
    transparent: true,
    opacity: 0.75,
  });
  let trail = new T.Line(new T.BufferGeometry(), lineMat);
  entities.add(trail);
  const pool = new Map<string, T.Group>();
  // Lo que falta mover de la cámara para seguir al personaje (se aplica de a poco en animate).
  const follow = new T.Vector3();
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
        new T.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.3,
          metalness: 0.35,
          roughness: 0.4,
          depthTest: true,
          depthWrite: true,
        }),
      );
    return materials.get(color)!;
  }
  const haloMat = new T.MeshBasicMaterial({
    color: 0xf4d28e,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  const halo = new T.Mesh(new T.RingGeometry(0.8, 1.4, 48), haloMat);
  halo.rotation.x = -Math.PI / 2;
  scene.add(halo);
  function marker(
    key: string,
    kind: keyof typeof colors,
    x: number,
    y: number,
    label: string,
    target = false,
  ) {
    let group = pool.get(key);
    if (!group) {
      group = new T.Group();
      const mat = material(colors[kind]);
      if (kind === "self" || kind === "player") {
        const b = new T.Mesh(body, mat);
        b.position.y = 0.425;
        const h = new T.Mesh(sphere, mat);
        h.position.y = 1.1;
        group.add(b, h);
      } else {
        const mesh = new T.Mesh(kind === "monster" ? cone : gem, mat);
        mesh.position.y = kind === "monster" ? 0.9 : 1;
        group.add(mesh);
      }
      const r = new T.Mesh(ring, mat);
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.07;
      r.name = "ring";
      group.add(r);
      pool.set(key, group);
      entities.add(group);
    }
    group.visible = true;
    // Destino: el animate lo desliza hasta ahí (la posición llega una vez por segundo; sin esto los
    // personajes saltaban de tile en tile). Uno nuevo aparece directo en su lugar.
    const to = new T.Vector3(x, elevation(x, y) + 0.02, -y);
    if (!group.userData.to) group.position.copy(to);
    group.userData.to = to;
    // Characters keep their world size and are occluded by the actual scenery.
    const scale = kind === "self" || kind === "player" ? 1 : Math.max(1, span / 65);
    group.scale.setScalar(scale);
    group.userData.label = label;
    group.getObjectByName("ring")!.visible =
      kind === "self" || kind === "camp" || target;
  }
  function reset() {
    if (!state) return;
    const bounds = real?.bounds ?? [0, 0, 256, 256];
    const cx = (bounds[0] + bounds[2]) / 2,
      cy = (bounds[1] + bounds[3]) / 2;
    const fit =
      span >= 256
        ? Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 1.05
        : span;
    const target =
      span >= 256
        ? new T.Vector3(cx, elevation(cx, cy), -cy)
        : new T.Vector3(
            state.where.x,
            elevation(state.where.x, state.where.y),
            -state.where.y,
          );
    controls.target.copy(target);
    const offset = new T.Vector3(fit * 0.65, fit * 0.85, fit * 0.7);
    if (span >= 256) {
      const vertical = T.MathUtils.degToRad(camera.fov);
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
      const radius =
        Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]) / 2;
      offset
        .normalize()
        .multiplyScalar(
          (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.06,
        );
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
    const x0 =
        span >= 256 ? 0 : Math.max(0, Math.floor(state.where.x - radius)),
      x1 = span >= 256 ? 256 : Math.min(256, Math.ceil(state.where.x + radius));
    const y0 =
        span >= 256 ? 0 : Math.max(0, Math.floor(state.where.y - radius)),
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
          color.setHex(
            !terrain
              ? 0x1e3037
              : v & 1
                ? 0x294d43
                : v & 16
                  ? 0x254957
                  : (x + y) % 2
                    ? 0x34454b
                    : 0x314148,
          );
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
    if (previous && previous.where.map === s.where.map && span < 256) {
      const delta = new T.Vector3(
        s.where.x - previous.where.x,
        elevation(s.where.x, s.where.y) -
          elevation(previous.where.x, previous.where.y),
        previous.where.y - s.where.y,
      );
      // La cámara sigue al personaje deslizándose (follow se aplica de a poco en animate).
      follow.add(delta);
    }
    if (map !== s.where.map) {
      map = s.where.map;
      // Mapa nuevo: nada se desliza desde el mapa anterior (aparece directo en su lugar).
      pool.forEach((g) => delete g.userData.to);
      follow.set(0, 0, 0);
      realAbort?.abort();
      if (real) {
        scene.remove(real.group);
        real.dispose();
        real = null;
      }
      realAbort = new AbortController();
      const controller = realAbort;
      const requestedMap = map;
      loadRealMap(map, controller.signal, (text) => {
        if (!disposed && map === requestedMap) onTerrain(text);
      })
        .then((loaded) => {
          if (disposed || controller.signal.aborted || map !== requestedMap) {
            loaded.dispose();
            return;
          }
          real = loaded;
          real.setObjects(objectsVisible);
          scene.add(real.group);
          ground.visible = false;
          grid.visible = false;
          if (state) {
            update(state);
            reset();
          }
          onTerrain(
            `Mapa original · ${loaded.objectCount.toLocaleString("es-AR")} objetos${loaded.missingTypes ? " · escenario parcial" : ""}`,
          );
        })
        .catch((error) => {
          if (!disposed && !controller.signal.aborted && map === requestedMap)
            onTerrain("Vista de colisiones · escenario original no disponible");
        });
      patchKey = "";
      terrain = cache.get(map) ?? null;
      reset();
      onTerrain("Cargando mapa original…");
      terrainAbort?.abort();
      terrainAbort = new AbortController();
      const thisMap = map;
      if (cache.has(map)) {
        if (!real) onTerrain("Cargando escenario original…");
      } else {
        fetch(`/terrain/${map}`, { signal: terrainAbort.signal })
          .then(async (r) => {
            if (!r.ok) throw Error();
            const b = new Uint8Array(await r.arrayBuffer());
            if (b.length !== 65536) throw Error();
            return b;
          })
          .then((b) => {
            if (disposed || map !== thisMap) return;
            cache.set(map, b);
            terrain = b;
            patchKey = "";
            buildGround();
            if (!real) onTerrain("Cargando escenario original…");
          })
          .catch((e) => {
            if (disposed || e.name === "AbortError" || map !== thisMap) return;
            cache.set(map, null);
            if (!real) onTerrain("Cargando escenario original…");
          });
      }
    }
    buildGround();
    pool.forEach((g) => (g.visible = false));
    marker(
      "self",
      "self",
      s.where.x,
      s.where.y,
      `${s.char.name} · ${s.where.x}, ${s.where.y}`,
    );
    halo.position.set(
      s.where.x,
      elevation(s.where.x, s.where.y) + 0.06,
      -s.where.y,
    );
    halo.scale.setScalar(Math.max(1, span / 65));
    for (const m of s.entities?.monsters ?? [])
      marker(
        `m${m.id}`,
        m.gold ? "gold" : "monster",
        m.x,
        m.y,
        `${m.name} · ${m.x}, ${m.y}${m.target ? " · Objetivo" : ""}`,
        m.target,
      );
    for (const p of s.entities?.players ?? [])
      marker(`p${p.id}`, "player", p.x, p.y, `Jugador · ${p.x}, ${p.y}`);
    for (const [i, d] of (s.entities?.drops ?? []).entries())
      if (d.valuable)
        marker(`d${i}`, "drop", d.x, d.y, `${d.name} · ${d.x}, ${d.y}`);
    if (s.camp) marker("camp", "camp", ...s.camp, "Destino del personaje");
    for (const [key, g] of pool)
      if (!g.visible) {
        entities.remove(g);
        pool.delete(key);
      }
    trail.geometry.dispose();
    trail.geometry = new T.BufferGeometry().setFromPoints(
      (s.trail ?? []).map(
        ([x, y]) => new T.Vector3(x, elevation(x, y) + 0.18, -y),
      ),
    );
  }
  const raycaster = new T.Raycaster();
  const pointer = new T.Vector2();
  function hover(ev: PointerEvent) {
    const rc = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((ev.clientX - rc.left) / rc.width) * 2 - 1,
      (-(ev.clientY - rc.top) / rc.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...pool.values()], true)[0];
    let o: T.Object3D | undefined = hit?.object;
    while (o && !o.userData.label) o = o.parent ?? undefined;
    if (o?.userData.label) onHover(o.userData.label);
    else if (real) {
      const tile = raycaster.intersectObject(real.group.children[0], false)[0];
      if (tile) {
        const x = Math.floor(tile.point.x),
          y = Math.floor(-tile.point.z);
        const flag = real.flags[Math.max(0, Math.min(65535, y * 256 + x))];
        onHover(
          `${x}, ${y} · ${flag & 1 ? "Zona segura" : flag & 4 ? "No transitable" : "Terreno"} · altura ${elevation(x, y).toFixed(2)}`,
        );
      } else onHover("");
    } else onHover("");
  }
  const leave = () => onHover("");
  renderer.domElement.addEventListener("pointermove", hover);
  renderer.domElement.addEventListener("pointerleave", leave);
  const keyboard = (e: KeyboardEvent) => {
    if (e.key === "Home") {
      e.preventDefault();
      reset();
    } else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-"].includes(
        e.key,
      )
    ) {
      e.preventDefault();
      const offset = camera.position.clone().sub(controls.target);
      if (e.key === "+" || e.key === "-")
        offset.multiplyScalar(e.key === "+" ? 0.9 : 1.1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight")
        offset.applyAxisAngle(
          new T.Vector3(0, 1, 0),
          e.key === "ArrowLeft" ? 0.12 : -0.12,
        );
      else offset.y = Math.max(4, offset.y + (e.key === "ArrowUp" ? 4 : -4));
      camera.position.copy(controls.target).add(offset);
      controls.update();
    }
  };
  renderer.domElement.addEventListener("keydown", keyboard);
  const resize = new ResizeObserver(() => {
    const w = el.clientWidth,
      h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (span >= 256) reset();
  });
  resize.observe(el);
  const intersection = new IntersectionObserver(
    (entries) => (visible = entries[0]?.isIntersecting ?? true),
  );
  intersection.observe(el);
  function animate(t: number) {
    frame = requestAnimationFrame(animate);
    if (!visible || document.hidden || t - lastDraw < 32) return;
    const dt = Math.min(200, t - lastDraw);
    lastDraw = t;
    // Deslizar hacia el destino (~90 % en 0,7 s: llega antes de la próxima posición).
    const k = 1 - Math.exp(-dt / 300);
    for (const g of pool.values()) {
      const to = g.userData.to as T.Vector3 | undefined;
      if (to) g.position.lerp(to, k);
    }
    const self = pool.get("self");
    if (self) halo.position.set(self.position.x, self.position.y + 0.04, self.position.z);
    if (follow.lengthSq() > 1e-6) {
      const step = follow.clone().multiplyScalar(k);
      controls.target.add(step);
      camera.position.add(step);
      follow.sub(step);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  return {
    update,
    setObjects(visible) {
      objectsVisible = visible;
      real?.setObjects(visible);
    },
    zoom(v) {
      span = v;
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
      renderer.domElement.removeEventListener("pointermove", hover);
      renderer.domElement.removeEventListener("pointerleave", leave);
      renderer.domElement.removeEventListener("keydown", keyboard);
      const geometries = new Set<T.BufferGeometry>();
      const mats = new Set<T.Material>();
      scene.traverse((o) => {
        if (o instanceof T.Mesh || o instanceof T.Line) {
          geometries.add(o.geometry);
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            mats.add(m);
        }
      });
      geometries.forEach((g) => g.dispose());
      [sphere, body, cone, gem, ring].forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      mats.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
export function Radar({ state }: { state: PanelState | null }) {
  const host = useRef<HTMLDivElement>(null),
    api = useRef<RadarApi | null>(null),
    latest = useRef(state);
  latest.current = state;
  const [zoom, setZoom] = useState("40"),
    [terrain, setTerrain] = useState("Esperando posición"),
    [hover, setHover] = useState(""),
    [error, setError] = useState(false),
    [showObjects, setShowObjects] = useState(true);
  useEffect(() => {
    try {
      api.current = makeRadar(host.current!, setTerrain, setHover);
      if (latest.current) api.current.update(latest.current);
    } catch {
      setError(true);
    }
    return () => {
      api.current?.dispose();
      api.current = null;
    };
  }, []);
  useEffect(() => {
    if (state) api.current?.update(state);
  }, [state]);
  return (
    <section className="radar surface">
      <div className="radar-heading">
        <div>
          <h2>
            <Move3d size={17} />
            Radar 3D
          </h2>
          <span>
            {state?.where.mapName ?? "Esperando al personaje"}{" "}
            <span className="coordinates">
              {state ? `${state.where.x}, ${state.where.y}` : ""}
            </span>
          </span>
        </div>
        <Segments
          value={zoom}
          onChange={(v) => {
            setZoom(v);
            api.current?.zoom(+v);
          }}
          label="Alcance del radar"
          items={[
            { value: "40", label: "Cerca" },
            { value: "90", label: "Zona" },
            { value: "256", label: "Mapa" },
          ]}
        />
      </div>
      <div className="radar-stage">
        <div ref={host} className="three-host" />
        {!state && !error && (
          <div className="radar-loading">Esperando datos del mundo…</div>
        )}
        {error && (
          <div className="radar-loading">
            No se pudo iniciar el radar 3D.
            <br />
            <small>
              Activá la aceleración gráfica del navegador y recargá.
            </small>
          </div>
        )}
        <div className="radar-caption">
          <span className="live-dot" />
          {terrain}
        </div>
        <div className="radar-actions">
          <Action
            className="map-button"
            aria-pressed={showObjects}
            onClick={() => {
              setShowObjects(!showObjects);
              api.current?.setObjects(!showObjects);
            }}
            title="Mostrar u ocultar edificios, árboles y objetos originales"
          >
            <Trees size={14} />
            {showObjects ? "Escenario" : "Solo terreno"}
          </Action>
          <Action
            className="map-button"
            aria-label="Ampliar radar"
            onClick={() => {
              const stage = host.current?.parentElement;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void stage?.requestFullscreen().catch(() => {});
            }}
          >
            <Maximize size={14} />
          </Action>
          <Action className="map-button" onClick={() => api.current?.reset()}>
            <Crosshair size={14} />
            Centrar
          </Action>
        </div>
        {hover && <div className="map-tooltip">{hover}</div>}
      </div>
      <div className="radar-footer">
        <div className="map-legend">
          {[
            ["self", "Vos"],
            ["monster", "Monstruos"],
            ["gold", "Dorados"],
            ["player", "Jugadores"],
            ["drop", "Objetos"],
          ].map(([key, label]) => (
            <span key={key}>
              <i
                style={{
                  background:
                    "#" + colors[key as keyof typeof colors].toString(16),
                }}
              />
              {label}
            </span>
          ))}
        </div>
        <span className="map-help">
          <RotateCcw size={12} />
          Arrastrá para girar · rueda para zoom
        </span>
      </div>
    </section>
  );
}
