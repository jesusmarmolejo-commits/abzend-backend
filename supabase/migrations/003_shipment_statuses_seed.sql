-- Migration: 003_shipment_statuses_seed.sql
-- Description: Seed initial status codes into shipment_statuses.
-- Idempotent: ON CONFLICT (codigo) DO NOTHING
-- Created: 2026-06-08

INSERT INTO shipment_statuses (id, estado_es, estado_en, categoria, codigo)
VALUES
  -- Asignacion
  (1, 'Asignado',                  'Assigned',              'asignacion',  'ASC'),

  -- Recoleccion
  (2, 'Recolectado',               'Picked Up',             'recoleccion', 'PUP'),

  -- Transito
  (3, 'En transito',               'In Transit',            'transito',    'INT'),
  (4, 'Proximo a entregar',        'Near Delivery',         'transito',    'NRD'),

  -- Entrega
  (5, 'Entregado',                 'Delivered',             'entrega',     'DLV'),

  -- Fallo
  (6, 'Intento fallido',           'Failed Attempt',        'fallo',       'FAL'),
  (7, 'Primer intento fallido',    'First Failed Attempt',  'fallo',       'ENT_F1'),
  (8, 'Segundo intento fallido',   'Second Failed Attempt', 'fallo',       'ENT_F2'),

  -- Retorno
  (9, 'Regreso a estacion',        'Return to Station',     'retorno',     'REG_EST')

ON CONFLICT (codigo) DO NOTHING;
