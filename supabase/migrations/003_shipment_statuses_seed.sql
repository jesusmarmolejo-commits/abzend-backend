-- Migration: 003_shipment_statuses_seed.sql
-- Description: Insert missing status codes into shipment_statuses.
-- Already present in DB: ASC(26), PUP(4), INT(11), DLV(33)
-- Inserting only the 5 codes not yet in the table.
-- Idempotent: ON CONFLICT DO NOTHING (covers both PK and UNIQUE codigo)
-- Created: 2026-06-08

INSERT INTO shipment_statuses (id, estado_es, estado_en, categoria, codigo)
VALUES
  (52, 'Proximo a entregar',      'Near Delivery',         'transito',  'NRD'),
  (53, 'Intento fallido',         'Failed Attempt',        'fallo',     'FAL'),
  (54, 'Primer intento fallido',  'First Failed Attempt',  'fallo',     'ENT_F1'),
  (55, 'Segundo intento fallido', 'Second Failed Attempt', 'fallo',     'ENT_F2'),
  (56, 'Regreso a estacion',      'Return to Station',     'retorno',   'REG_EST')

ON CONFLICT DO NOTHING;
