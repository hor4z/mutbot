-- Configuración y estado del bot y la estación, en la base (nada vive en archivos locales). Son tablas de pocas filas con la última versión
-- de cada clave: ReplacingMergeTree por `updated_at`; se leen con argMax (sin FINAL) y un borrado es una fila con `deleted = 1`.

-- Perillas en caliente (directivas.ts): el valor va como texto JSON (`true`, `90`).
CREATE TABLE IF NOT EXISTS directives (
  key String,
  value String,
  deleted UInt8 DEFAULT 0,
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key;

-- El personaje que juega (una fila, id = 1). La clave va en texto plano (decisión del usuario: la base está en su red).
CREATE TABLE IF NOT EXISTS character (
  id UInt8 DEFAULT 1,
  user String,
  pass String,
  char String,
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id;

-- Ajustes sueltos de la estación: `proxy_token`, `worker_url`, `wanted` ("1" si el personaje tiene que estar conectado).
CREATE TABLE IF NOT EXISTS settings (
  key String,
  value String,
  deleted UInt8 DEFAULT 0,
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key;
