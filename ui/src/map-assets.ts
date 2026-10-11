import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// The server's custom arenas use Stadium, as do terrain.ts and the reference client.
export const mapWorld = (map: number) =>
  (({ 83: 7, 84: 7, 85: 7 }) as Record<number, number>)[map] ?? map + 1;
type PlacedObject = [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
type Manifest = {
  world: number;
  version: string;
  terrain: string;
  texture: string;
  heightScale: number;
  models: Record<string, string>;
  objects: PlacedObject[];
  missingObjectTypes: number[];
  sourceObjectCount: number;
};
export type RealMap = {
  group: T.Group;
  height: (x: number, y: number) => number;
  flags: Uint8Array;
  world: number;
  objectCount: number;
  missingTypes: number;
  bounds: [number, number, number, number];
  dispose: () => void;
  setObjects: (visible: boolean) => void;
};
let assetOrigin: string | undefined;
const candidates = () => {
  const all: string[] = [];
  try {
    const parent = new URL(document.referrer);
    if (["127.0.0.1", "localhost"].includes(parent.hostname))
      all.push(parent.origin);
  } catch {}
  all.push(location.origin, "http://127.0.0.1:8787");
  return [...new Set(all)];
};
async function getManifest(world: number, signal: AbortSignal) {
  for (const origin of assetOrigin
    ? [assetOrigin, ...candidates().filter((o) => o !== assetOrigin)]
    : candidates()) {
    try {
      const base = `${origin}/radar-assets/world${world}/`;
      const response = await fetch(base + "map.json", { signal });
      if (response.ok) {
        const manifest = (await response.json()) as Manifest;
        if (manifest.world !== world || !Array.isArray(manifest.objects))
          throw Error("Invalid map");
        assetOrigin = origin;
        return { manifest, base };
      }
    } catch (e) {
      if (signal.aborted) throw e;
    }
  }
  throw Error("No local map assets");
}
function disposeObject(root: T.Object3D) {
  const geoms = new Set<T.BufferGeometry>(),
    mats = new Set<T.Material>(),
    textures = new Set<T.Texture>();
  root.traverse((o) => {
    if (o instanceof T.Mesh || o instanceof T.Line) {
      geoms.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        mats.add(m);
        for (const value of Object.values(m))
          if (value instanceof T.Texture) textures.add(value);
      }
    }
  });
  geoms.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  textures.forEach((t) => {
    const image = t.source?.data;
    if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)
      image.close();
    t.dispose();
  });
}
export async function loadRealMap(
  map: number,
  signal: AbortSignal,
  onProgress: (s: string) => void,
): Promise<RealMap> {
  const world = mapWorld(map);
  const { manifest: m, base } = await getManifest(world, signal);
  onProgress("Cargando relieve y texturas…");
  const asset = (file: string) => base + file + "?v=" + m.version;
  const [buffer, blob] = await Promise.all([
    fetch(asset(m.terrain), { signal }).then((r) => {
      if (!r.ok) throw Error("height");
      return r.arrayBuffer();
    }),
    fetch(asset(m.texture), { signal }).then((r) => {
      if (!r.ok) throw Error("texture");
      return r.blob();
    }),
  ]);
  if (
    buffer.byteLength !== 131080 ||
    new TextDecoder().decode(buffer.slice(0, 4)) !== "MUR1"
  )
    throw Error("Invalid terrain");
  const heights = new Uint8Array(buffer, 8, 65536),
    flags = new Uint8Array(buffer, 65544, 65536);
  const height = (x: number, y: number) => {
    const fx = Math.max(0, Math.min(255, x)),
      fy = Math.max(0, Math.min(255, y)),
      ix = Math.floor(fx),
      iy = Math.floor(fy),
      xx = Math.min(255, ix + 1),
      yy = Math.min(255, iy + 1),
      dx = fx - ix,
      dy = fy - iy;
    return (
      ((1 - dx) * (1 - dy) * heights[iy * 256 + ix] +
        dx * (1 - dy) * heights[iy * 256 + xx] +
        dx * dy * heights[yy * 256 + xx] +
        (1 - dx) * dy * heights[yy * 256 + ix]) *
      m.heightScale
    );
  };
  const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
  const texture = new T.Texture(bitmap);
  texture.flipY = false;
  texture.colorSpace = T.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  const bounds: [number, number, number, number] = [256, 256, 0, 0];
  const positions = new Float32Array(257 * 257 * 3),
    uvs = new Float32Array(257 * 257 * 2),
    indices: number[] = [];
  for (let y = 0; y <= 256; y++)
    for (let x = 0; x <= 256; x++) {
      const i = y * 257 + x;
      positions.set([x, height(x, y), -y], i * 3);
      uvs.set([x / 256, y / 256], i * 2);
      // Suelo: los tiles con suelo y también los caminables marcados "sin suelo" (puentes y
      // pasarelas cuyo modelo puede faltar: sin esto los personajes quedaban flotando en el aire).
      if (x < 256 && y < 256 && (!(flags[y * 256 + x] & 8) || !(flags[y * 256 + x] & 4))) {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x + 1);
        bounds[3] = Math.max(bounds[3], y + 1);
        indices.push(i, i + 1, i + 258, i, i + 258, i + 257);
      }
    }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new T.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const ground = new T.Mesh(
    geometry,
    new T.MeshStandardMaterial({
      map: texture,
      roughness: 1,
      metalness: 0,
      side: T.FrontSide,
    }),
  );
  ground.name = "Original MU terrain";
  ground.receiveShadow = true;
  const group = new T.Group(),
    objects = new T.Group();
  group.add(ground, objects);
  let disposed = false,
    objectCount = 0,
    failed = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeObject(group);
    group.clear();
  };
  if (signal.aborted) {
    dispose();
    throw new DOMException("Aborted", "AbortError");
  }
  const byModel = new Map<string, PlacedObject[]>();
  for (const o of m.objects) {
    if (!byModel.has(o[0])) byModel.set(o[0], []);
    byModel.get(o[0])!.push(o);
  }
  const loader = new GLTFLoader();
  const entries = [...byModel.entries()];
  let next = 0,
    complete = 0;
  const modelRotation = new T.Matrix4().makeRotationX(-Math.PI / 2);
  const matrix = new T.Matrix4(),
    transform = new T.Object3D();
  async function worker() {
    while (next < entries.length && !signal.aborted && !disposed) {
      const [name, placements] = entries[next++];
      try {
        const response = await fetch(asset(m.models[name]), { signal });
        if (!response.ok) throw Error("Missing model");
        const bytes = await response.arrayBuffer();
        if (signal.aborted) break;
        if (bytes.byteLength < 20) throw Error("Empty model");
        const gltf = await loader.parseAsync(bytes, base);
        if (signal.aborted || disposed) {
          disposeObject(gltf.scene);
          break;
        }
        // Converted client GLBs contain Z-up MU geometry. Bind/first pose is baked once,
        // then objects are instanced with the exact positions, angles and scales from .obj.
        if (gltf.animations.length) {
          const mixer = new T.AnimationMixer(gltf.scene);
          mixer.clipAction(gltf.animations[0]).play();
          mixer.update(0);
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((o) => {
            if (o instanceof T.SkinnedMesh) o.skeleton.update();
          });
          mixer.stopAllAction();
          mixer.uncacheRoot(gltf.scene);
        }
        gltf.scene.updateMatrixWorld(true);
        const parts: T.Mesh[] = [];
        gltf.scene.traverse((o) => {
          if (o instanceof T.Mesh) parts.push(o);
        });
        for (const mesh of parts) {
          const geo = mesh.geometry.clone();
          if (mesh instanceof T.SkinnedMesh) {
            const pos = geo.getAttribute("position"),
              v = new T.Vector3();
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i);
              mesh.applyBoneTransform(i, v);
              pos.setXYZ(i, v.x, v.y, v.z);
            }
            geo.deleteAttribute("skinIndex");
            geo.deleteAttribute("skinWeight");
          }
          geo.applyMatrix4(mesh.matrixWorld);
          geo.computeVertexNormals();
          const originals = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          const materials = originals.map((mat) => {
            const original = mat as T.MeshStandardMaterial;
            const material = new T.MeshStandardMaterial({
              map: original.map,
              color: original.color ?? 0xffffff,
              roughness: 1,
              metalness: 0,
              side: T.DoubleSide,
              alphaTest:
                original.transparent || original.alphaTest > 0 ? 0.35 : 0,
            });
            if (material.map) material.map.anisotropy = 4;
            return material;
          });
          // Spatial batches keep frustum culling useful, even when viewing the entire map.
          const cells = new Map<string, PlacedObject[]>();
          for (const p of placements) {
            const key = `${Math.floor(p[1] / 32)}:${Math.floor(p[2] / 32)}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key)!.push(p);
          }
          for (const list of cells.values()) {
            const instanced = new T.InstancedMesh(
              geo,
              materials.length === 1 ? materials[0] : materials,
              list.length,
            );
            instanced.name = name;
            for (let i = 0; i < list.length; i++) {
              const [, x, y, z, rx, ry, rz, scale] = list[i];
              transform.position.set(x, z, -y);
              transform.rotation.set(
                -T.MathUtils.degToRad(rx),
                T.MathUtils.degToRad(rz),
                T.MathUtils.degToRad(ry),
                "YXZ",
              );
              transform.scale.setScalar(scale);
              transform.updateMatrix();
              matrix.copy(transform.matrix).multiply(modelRotation);
              instanced.setMatrixAt(i, matrix);
            }
            instanced.instanceMatrix.needsUpdate = true;
            instanced.computeBoundingSphere();
            objects.add(instanced);
          }
          mesh.geometry.dispose();
          for (const material of originals) material.dispose();
        }
        objectCount += placements.length;
      } catch (e) {
        if (signal.aborted) break;
        failed++;
      }
      complete++;
      if (!disposed && !signal.aborted)
        onProgress(
          `Cargando escenario · ${Math.round((complete / entries.length) * 100)}%`,
        );
    }
  }
  try {
    await Promise.all(Array.from({ length: 4 }, worker));
    if (signal.aborted) {
      dispose();
      throw new DOMException("Aborted", "AbortError");
    }
  } catch (e) {
    dispose();
    throw e;
  }
  onProgress(
    `Mapa original · ${objectCount.toLocaleString("es-AR")} objetos${failed || m.missingObjectTypes.length ? " · algunos objetos no disponibles" : ""}`,
  );
  return {
    group,
    height,
    flags,
    world,
    objectCount,
    bounds,
    missingTypes: m.missingObjectTypes.length + failed,
    dispose,
    setObjects(visible) {
      objects.visible = visible;
    },
  };
}
