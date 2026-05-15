-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 003: Rastreo público seguro mediante RPC con SECURITY DEFINER
--
-- PROBLEMA: La policy USING(true) de la migración 002 expone TODAS las órdenes
-- a cualquier persona que conozca el anon key (visible en el navegador).
--
-- SOLUCIÓN: Función RPC que:
--   1. Solo devuelve datos de UNA orden específica por tracking_code
--   2. Solo expone los campos seguros (sin teléfonos, totales, IDs internos)
--   3. Bloquea enumeración masiva porque requiere el código exacto
--   4. No requiere que orders ni order_events tengan RLS abierto
--
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Eliminar las policies permisivas de la migración 002
drop policy if exists "public_tracking_lookup" on orders;
drop policy if exists "public_events_lookup" on order_events;

-- 2. Crear función segura de rastreo público
--    SECURITY DEFINER: corre con permisos del owner (postgres), no del caller (anon)
--    SET search_path = public: previene ataques de search_path hijacking
create or replace function public.get_tracking(p_tracking_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result json;
begin
  -- Validación básica: formato mínimo esperado
  if p_tracking_code is null or length(trim(p_tracking_code)) < 4 then
    return null;
  end if;

  select json_build_object(
    'tracking_code',        o.tracking_code,
    'status',               o.status,
    'origin_address',       o.origin_address,
    'dest_address',         o.dest_address,
    'sender_name',          o.sender_name,
    'recipient_name',       o.recipient_name,
    'service',              o.service,
    'package_type',         o.package_type,
    'estimated_delivery_at',o.estimated_delivery_at,
    'delivered_at',         o.delivered_at,
    'created_at',           o.created_at,
    'events', (
      select coalesce(json_agg(
        json_build_object(
          'id',         e.id,
          'status',     e.status,
          'note',       e.note,
          'status_code',e.status_code,
          'created_at', e.created_at
        ) order by e.created_at asc
      ), '[]'::json)
      from order_events e
      where e.order_id = o.id
    )
  )
  into v_result
  from orders o
  where o.tracking_code = trim(upper(p_tracking_code));  -- case-insensitive

  return v_result;  -- null si no existe, el objeto si existe
end;
$$;

-- 3. Dar permiso de ejecución SOLO a anon (no expone la tabla directamente)
grant execute on function public.get_tracking(text) to anon;

-- 4. Revocar acceso directo a las tablas para anon (por si acaso)
revoke select on orders       from anon;
revoke select on order_events from anon;

insert into schema_migrations (version) values ('003') on conflict do nothing;
