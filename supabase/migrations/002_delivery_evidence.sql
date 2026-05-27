-- ═══════════════════════════════════════════════════════
-- MIGRATION 002: Tabla de Evidencia de Entregas
-- Ejecuta en: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════

-- Actualizar tabla orders con campos de evidencia
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS has_evidence BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS evidence_id UUID REFERENCES delivery_evidence(id);

-- Crear tabla principal de evidencia
CREATE TABLE IF NOT EXISTS delivery_evidence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- Tipo de evidencia capturada
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo', 'signature', 'qr', 'note', 'complete')),

  -- Contenido y URLs
  qr_code TEXT,                     -- Código QR escaneado
  photo_image_url TEXT,             -- URL pública en Storage
  signature_image_url TEXT,         -- URL pública en Storage
  delivery_note TEXT,               -- Nota de repartidor

  -- Auditoría
  captured_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  captured_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índices para búsqueda rápida
CREATE INDEX IF NOT EXISTS idx_evidence_order ON delivery_evidence(order_id);
CREATE INDEX IF NOT EXISTS idx_evidence_qr ON delivery_evidence(qr_code);
CREATE INDEX IF NOT EXISTS idx_evidence_type ON delivery_evidence(evidence_type);
CREATE INDEX IF NOT EXISTS idx_evidence_driver ON delivery_evidence(captured_by);

-- Row Level Security (RLS)
ALTER TABLE delivery_evidence ENABLE ROW LEVEL SECURITY;

-- Drivers ven evidencia de sus propias órdenes
CREATE POLICY IF NOT EXISTS "drivers_own_evidence" ON delivery_evidence
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE driver_id = (
        SELECT id FROM drivers
        WHERE user_id = auth.uid()
      )
    )
  );

-- Clients ven evidencia de sus órdenes
CREATE POLICY IF NOT EXISTS "clients_own_evidence" ON delivery_evidence
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE client_id = (
        SELECT id FROM users
        WHERE auth_id = auth.uid()
      )
    )
  );

-- Admins ven todo (via service_role key)

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_evidence_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER IF NOT EXISTS trg_evidence_updated_at
  BEFORE UPDATE ON delivery_evidence
  FOR EACH ROW
  EXECUTE FUNCTION update_evidence_updated_at();

-- Trigger para actualizar orders.has_evidence cuando se agrega evidencia
CREATE OR REPLACE FUNCTION update_order_has_evidence()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE orders
  SET has_evidence = TRUE, evidence_id = NEW.id
  WHERE id = NEW.order_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER IF NOT EXISTS trg_update_order_evidence
  AFTER INSERT ON delivery_evidence
  FOR EACH ROW
  EXECUTE FUNCTION update_order_has_evidence();

-- ═══════════════════════════════════════════════════════
-- CONFIGURACIÓN DE STORAGE EN SUPABASE
-- ═══════════════════════════════════════════════════════

-- Ejecuta esto en Supabase Dashboard → Storage → Buckets:
-- CREATE BUCKET IF NOT EXISTS delivery-evidence WITH (public = true)

-- Para hacer público el bucket, usa:
-- ALTER BUCKET delivery-evidence SET PUBLIC
