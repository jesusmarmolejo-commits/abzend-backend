-- ═══════════════════════════════════════════════════════
-- ABZEND — Esquema de base de datos completo (Supabase/PostgreSQL)
-- Ejecuta esto en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════

-- Tabla de control de migraciones aplicadas
create table if not exists schema_migrations (
  version     text primary key,
  applied_at  timestamptz default now()
);
insert into schema_migrations (version) values ('001') on conflict do nothing;

-- ─────────────────────────────────────────────
-- 1. EXTENSIONES
-- ─────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "postgis";  -- para coordenadas GPS

-- ─────────────────────────────────────────────
-- 2. ENUM TYPES
-- ─────────────────────────────────────────────
create type user_role      as enum ('client', 'driver', 'admin');
create type order_status   as enum ('pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'cancelled');
create type service_type   as enum ('standard', 'express', 'same_day');
create type payment_status as enum ('pending', 'paid', 'refunded', 'failed');
create type driver_status  as enum ('online', 'offline', 'busy');

-- ─────────────────────────────────────────────
-- 3. USUARIOS (clientes, repartidores, admins)
-- ─────────────────────────────────────────────
create table users (
  id            uuid primary key default uuid_generate_v4(),
  auth_id       uuid unique,                        -- Supabase Auth UID
  email         text unique not null,
  full_name     text not null,
  phone         text,
  role          user_role not null default 'client',
  avatar_url    text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 4. REPARTIDORES (extiende users)
-- ─────────────────────────────────────────────
create table drivers (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid unique references users(id) on delete cascade,
  zone          text,
  vehicle_type  text default 'motorcycle',
  license_plate text,
  status        driver_status default 'offline',
  rating        numeric(3,2) default 5.0,
  total_deliveries int default 0,
  -- GPS en tiempo real
  last_lat      double precision,
  last_lng      double precision,
  last_seen_at  timestamptz,
  created_at    timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 5. ÓRDENES DE ENVÍO
-- ─────────────────────────────────────────────
create table orders (
  id              uuid primary key default uuid_generate_v4(),
  tracking_code   text unique not null,              -- ej. AB-1050
  client_id       uuid references users(id),
  driver_id       uuid references drivers(id),

  -- Remitente
  sender_name     text not null,
  sender_phone    text,
  origin_address  text not null,
  origin_lat      double precision,
  origin_lng      double precision,

  -- Destinatario
  recipient_name  text not null,
  recipient_phone text,
  dest_address    text not null,
  dest_lat        double precision,
  dest_lng        double precision,

  -- Paquete
  package_type    text default 'general',
  weight_kg       numeric(6,2),
  service         service_type default 'standard',
  instructions    text,
  has_insurance   boolean default false,

  -- Estado y fechas
  status          order_status default 'pending',
  status_updated_at timestamptz default now(),
  estimated_delivery_at timestamptz,
  delivered_at    timestamptz,

  -- Pago
  subtotal        numeric(10,2) not null,
  insurance_cost  numeric(10,2) default 0,
  tax             numeric(10,2) default 0,
  total           numeric(10,2) not null,
  payment_status  payment_status default 'pending',
  stripe_payment_intent_id text,

  -- QR
  qr_code         text unique,                       -- código para escaneo

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 6. HISTORIAL DE ESTADOS (timeline)
-- ─────────────────────────────────────────────
create table order_events (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid references orders(id) on delete cascade,
  status      order_status not null,
  note        text,
  lat         double precision,
  lng         double precision,
  created_by  uuid references users(id),
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 7. UBICACIONES GPS EN TIEMPO REAL
-- ─────────────────────────────────────────────
create table driver_locations (
  id          uuid primary key default uuid_generate_v4(),
  driver_id   uuid references drivers(id) on delete cascade,
  order_id    uuid references orders(id),
  lat         double precision not null,
  lng         double precision not null,
  recorded_at timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 8. CALIFICACIONES
-- ─────────────────────────────────────────────
create table ratings (
  id          uuid primary key default uuid_generate_v4(),
  order_id    uuid unique references orders(id),
  driver_id   uuid references drivers(id),
  client_id   uuid references users(id),
  score       smallint check (score between 1 and 5),
  comment     text,
  created_at  timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 9. ÍNDICES para rendimiento
-- ─────────────────────────────────────────────
create index idx_orders_client    on orders(client_id);
create index idx_orders_driver    on orders(driver_id);
create index idx_orders_status    on orders(status);
create index idx_orders_tracking  on orders(tracking_code);
create index idx_orders_qr        on orders(qr_code);
create index idx_events_order     on order_events(order_id);
create index idx_locations_driver on driver_locations(driver_id);

-- ─────────────────────────────────────────────
-- 10. FUNCIÓN: actualizar updated_at automáticamente
-- ─────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_orders_updated_at
  before update on orders
  for each row execute function update_updated_at();

create trigger trg_users_updated_at
  before update on users
  for each row execute function update_updated_at();

-- ─────────────────────────────────────────────
-- 11. FUNCIÓN: generar tracking code automático
-- ─────────────────────────────────────────────
create sequence order_seq start 1000;

create or replace function generate_tracking_code()
returns trigger as $$
begin
  if new.tracking_code is null then
    new.tracking_code := 'AB-' || nextval('order_seq');
  end if;
  if new.qr_code is null then
    new.qr_code := 'ABZEND-' || new.tracking_code || '-' || substr(md5(random()::text), 1, 6);
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_order_tracking
  before insert on orders
  for each row execute function generate_tracking_code();

-- ─────────────────────────────────────────────
-- 12. ROW LEVEL SECURITY (RLS)
-- ─────────────────────────────────────────────
alter table users   enable row level security;
alter table orders  enable row level security;
alter table drivers enable row level security;

-- Clientes solo ven sus propias órdenes
create policy "clients_own_orders" on orders
  for select using (auth.uid() = (select auth_id from users where id = client_id));

-- Repartidores ven órdenes asignadas a ellos
create policy "drivers_assigned_orders" on orders
  for select using (
    auth.uid() = (select u.auth_id from users u join drivers d on d.user_id = u.id where d.id = driver_id)
  );

-- Admins ven todo (via service_role key — sin restricción)

-- ─────────────────────────────────────────────
-- 13. REALTIME — activar para tracking en vivo
-- ─────────────────────────────────────────────
-- Ejecuta esto para habilitar Realtime en estas tablas:
-- Supabase Dashboard → Database → Replication → Tables
-- Activa: orders, driver_locations, order_events

-- ─────────────────────────────────────────────
-- 14. DATOS DE PRUEBA (demo)
-- ─────────────────────────────────────────────
insert into users (email, full_name, phone, role) values
  ('admin@abzend.mx',      'Admin ABZEND',   '+525500000001', 'admin'),
  ('cliente@ejemplo.com',  'Carlos Mendoza', '+525512345678', 'client'),
  ('repartidor@abzend.mx', 'Luis Herrera',   '+525587654321', 'driver');
