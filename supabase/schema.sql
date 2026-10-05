-- Кафе «Улётное»: приём заказов с сайта.
-- Выполните этот файл целиком в Supabase → SQL Editor (можно запускать повторно).
-- В самом конце впишите e-mail сотрудников, которым можно видеть заказы.

create extension if not exists pgcrypto;

-- Заказы ---------------------------------------------------------------

create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  number        int  not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  status        text not null default 'new'
                check (status in ('new', 'cooking', 'ready', 'done', 'cancelled')),
  customer_name text check (char_length(customer_name) <= 60),
  phone         text not null check (phone ~ '^\+?[0-9]{10,15}$'),
  pickup_at     timestamptz,                 -- null = как можно скорее
  comment       text check (char_length(comment) <= 500),
  items         jsonb not null,              -- [{id, name, variant, price, qty}]
  total         int  not null check (total >= 0)
);

create index if not exists orders_created_at_idx on public.orders (created_at desc);

-- Сотрудники: только эти e-mail видят и меняют заказы.
create table if not exists public.staff_emails (
  email text primary key
);

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.staff_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.orders enable row level security;
alter table public.staff_emails enable row level security;

drop policy if exists "staff read orders" on public.orders;
create policy "staff read orders" on public.orders
  for select to authenticated using (public.is_staff());

drop policy if exists "staff update orders" on public.orders;
create policy "staff update orders" on public.orders
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

-- Гости не имеют прямого доступа к таблицам, только к двум функциям ниже.
revoke all on public.orders, public.staff_emails from anon;
revoke all on public.orders, public.staff_emails from authenticated;
grant select, update (status) on public.orders to authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- Оформление заказа с сайта ------------------------------------------------

create or replace function public.place_order(
  p_phone     text,
  p_items     jsonb,
  p_name      text default null,
  p_pickup_at timestamptz default null,
  p_comment   text default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_phone  text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_items  jsonb := '[]'::jsonb;
  v_item   jsonb;
  v_qty    int;
  v_price  int;
  v_total  int := 0;
  v_number int;
  v_id     uuid;
  v_day    timestamptz := date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow';
begin
  if v_phone !~ '^\+?[0-9]{10,15}$' then
    raise exception 'Проверьте номер телефона' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    raise exception 'Корзина пуста или слишком большая' using errcode = '22023';
  end if;
  if p_pickup_at is not null and (p_pickup_at < now() - interval '5 minutes' or p_pickup_at > now() + interval '24 hours') then
    raise exception 'Время самовывоза должно быть в ближайшие сутки' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty   := (v_item ->> 'qty')::int;
    v_price := (v_item ->> 'price')::int;
    if v_qty not between 1 and 20 or v_price not between 0 and 10000
       or coalesce(v_item ->> 'name', '') = '' then
      raise exception 'Некорректная позиция в заказе' using errcode = '22023';
    end if;
    v_items := v_items || jsonb_build_object(
      'id',      left(v_item ->> 'id', 60),
      'name',    left(v_item ->> 'name', 120),
      'variant', left(v_item ->> 'variant', 40),
      'price',   v_price,
      'qty',     v_qty
    );
    v_total := v_total + v_qty * v_price;
  end loop;

  -- Короткий номер заказа, с 1 каждый день.
  perform pg_advisory_xact_lock(hashtext('uletnoe_order_number'));
  select coalesce(max(number), 0) + 1 into v_number from public.orders where created_at >= v_day;

  insert into public.orders (number, phone, customer_name, pickup_at, comment, items, total)
  values (v_number, v_phone, nullif(left(trim(p_name), 60), ''), p_pickup_at,
          nullif(left(trim(p_comment), 500), ''), v_items, v_total)
  returning id into v_id;

  return json_build_object('id', v_id, 'number', v_number, 'total', v_total);
end;
$$;

-- Статус заказа для гостя: знает только тот, у кого есть id заказа.
create or replace function public.order_status(p_id uuid)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('number', number, 'status', status, 'pickup_at', pickup_at)
  from public.orders where id = p_id;
$$;

revoke all on function public.place_order(text, jsonb, text, timestamptz, text) from public;
revoke all on function public.order_status(uuid) from public;
grant execute on function public.place_order(text, jsonb, text, timestamptz, text) to anon, authenticated;
grant execute on function public.order_status(uuid) to anon, authenticated;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

-- Новые заказы приходят на экран кафе мгновенно (Realtime).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

-- Сотрудники ---------------------------------------------------------------
-- Впишите e-mail, под которыми кафе и управляющий входят в /admin/.
-- Сами аккаунты создаются в Supabase → Authentication → Users → Add user.
-- insert into public.staff_emails (email) values
--   ('kafe@example.com'),
--   ('manager@example.com')
-- on conflict do nothing;
