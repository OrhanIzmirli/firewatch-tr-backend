-- 012: tighten the ingest border gate from 5 km to 1.5 km.
--
-- 003 buffered Turkey's Natural Earth 1:50m outline outward by 5 km so a
-- coarse coastline would not reject detections on Turkish soil. In practice
-- the slack let in fires across the Syrian and Iraqi border strips (Mardin,
-- Şırnak, Şanlıurfa) and across the Meriç: of 58,722 detections stored by
-- 2026-11-07, 1,734 (3.0%) lie between 1.5 km and 5 km outside the outline,
-- 323 of them in the last 30 days. The gate is now 1.5 km.
--
-- Rows already stored are left as they are; the gate only decides what the
-- ingest accepts from now on. Re-run this file to rebuild the gate from the
-- stored outline (idempotent).

UPDATE country_borders
   SET geom_gate = ST_Multi(ST_Buffer(geom::geography, 1500)::geometry)
 WHERE iso_a3 = 'TUR';
