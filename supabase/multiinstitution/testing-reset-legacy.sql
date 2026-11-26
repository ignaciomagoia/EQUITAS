-- PELIGRO: reinicializacion destructiva, exclusiva para EQUITAS-TP-TESTING.
-- No ejecutar en Produccion La Falda ni en ningun otro proyecto.
-- Antes de ejecutar, confirmar en el encabezado de Supabase:
--   nombre: EQUITAS-TP-TESTING
--   project ref esperado: iylwghgvtydpmwidojdo
--
-- El script exige la firma de fixtures sinteticos 910001 y 910002 y aborta
-- antes de borrar si falta. Esa proteccion complementa, pero no reemplaza,
-- la verificacion manual de proyecto en el navegador. Storage y Auth deben
-- vaciarse antes mediante las interfaces oficiales de Supabase.

set app.equitas_reset_confirmation = 'EQUITAS_TP_TESTING_DESTRUCTIVE_RESET_CONFIRMED';

begin;

do $$
declare
  v_fixture_count integer;
begin
  if current_setting('app.equitas_reset_confirmation', true)
       is distinct from 'EQUITAS_TP_TESTING_DESTRUCTIVE_RESET_CONFIRMED' then
    raise exception 'Reset bloqueado: falta la confirmacion explicita de EQUITAS-TP-TESTING.';
  end if;

  if to_regclass('public.platform_installation') is not null then
    raise exception 'Reset bloqueado: la base ya tiene un marcador multiinstitucion.';
  end if;

  if to_regclass('public.tenant') is null
     or to_regclass('public.debtor') is null
     or to_regclass('public.debt') is null then
    raise exception 'Reset bloqueado: no se encontro el esquema legado esperado de Testing.';
  end if;

  select count(*)
  into v_fixture_count
  from public.debt
  where id in (910001, 910002);

  if v_fixture_count <> 2 then
    raise exception 'Reset bloqueado: faltan los fixtures sinteticos esperados (debt.id 910001 y 910002).';
  end if;

  if exists (select 1 from storage.buckets)
     or exists (select 1 from storage.objects) then
    raise exception 'Reset bloqueado: Storage no esta vacio. Elimine objetos y buckets desde Supabase Storage antes de reintentar.';
  end if;
end;
$$;

-- El modelo legado, sus datos, funciones, politicas, triggers y permisos estan
-- en public y private. CASCADE evita dejar dependencias del esquema anterior.
drop schema if exists private cascade;
drop schema public cascade;
create schema public authorization postgres;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant create on schema public to postgres, service_role;

do $$
begin
  if to_regclass('public.tenant') is not null
     or to_regclass('public.debtor') is not null
     or to_regclass('public.debt') is not null
     or to_regclass('public.platform_installation') is not null
     or to_regnamespace('private') is not null then
    raise exception 'Reset incompleto: aun existen tablas de EQUITAS en public.';
  end if;

  if exists (select 1 from storage.buckets)
     or exists (select 1 from storage.objects) then
    raise exception 'Reset incompleto: aun existen buckets u objetos Storage.';
  end if;
end;
$$;

commit;

-- Despues del commit, eliminar las cuentas sinteticas desde Authentication >
-- Users y ejecutar testing-empty-verification.sql antes de las migraciones.
