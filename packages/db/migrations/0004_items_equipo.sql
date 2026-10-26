-- Datos de equipo de cada ítem (para decidir qué botín mejora el set): slot donde se usa, nivel requerido, clases que lo pueden usar (máscara:
-- 1 caballero, 2 mago, 4 elfo, 8 gladiador), defensa, daño y poder mágico. Se llenan con `bun run db:seed` (seed `items`).
ALTER TABLE items ADD COLUMN IF NOT EXISTS equip_slot Int64 DEFAULT -1;
ALTER TABLE items ADD COLUMN IF NOT EXISTS req_level Int64 DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS cls Int64 DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS def Int64 DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS dmg Int64 DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS mag Int64 DEFAULT 0;
