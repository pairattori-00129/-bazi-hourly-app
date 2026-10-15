create table public.prep_stations(id uuid primary key default gen_random_uuid(),name text not null check(length(name) between 1 and 100),is_default boolean not null default false,enabled boolean not null default true,screen_enabled boolean not null default true,printer_enabled boolean not null default false,printer_name text not null default '',paper text not null default '80' check(paper in ('58','80')),check(screen_enabled or printer_enabled));
create unique index prep_one_default on public.prep_stations(is_default) where is_default;
insert into public.prep_stations(name,is_default) values('จุดรวม / รายการยังไม่กำหนดสถานี',true);
insert into public.prep_stations(name) values('ครัวไทย'),('ครัวเบเกอรี่'),('โซนเครื่องดื่ม');
create table public.prep_routes(category_id uuid primary key references public.product_categories(id),station_id uuid not null references public.prep_stations(id));
alter table public.order_items add column prep_station_id uuid references public.prep_stations(id);
create index order_items_prep_station on public.order_items(prep_station_id,order_id);
create table public.prep_tickets(order_id uuid not null references public.orders(id) on delete cascade,station_id uuid not null references public.prep_stations(id),status text not null default 'waiting' check(status in ('waiting','preparing','ready')),updated_at timestamptz not null default now(),primary key(order_id,station_id));
alter table public.prep_stations enable row level security;alter table public.prep_routes enable row level security;alter table public.prep_tickets enable row level security;
revoke all on public.prep_stations,public.prep_routes,public.prep_tickets from anon,authenticated;
grant all on public.prep_stations,public.prep_routes,public.prep_tickets to service_role;
create function public.bb_assign_prep_station() returns trigger language plpgsql set search_path=public as $$
begin
 select r.station_id into new.prep_station_id from public.products p join public.prep_routes r on r.category_id=p.category_id join public.prep_stations s on s.id=r.station_id where p.id=new.product_id and s.enabled;
 if new.prep_station_id is null then select id into new.prep_station_id from public.prep_stations where is_default;end if;
 insert into public.prep_tickets(order_id,station_id) values(new.order_id,new.prep_station_id) on conflict do nothing;
 return new;
end $$;
revoke all on function public.bb_assign_prep_station() from public,anon,authenticated;
create trigger assign_prep_station before insert on public.order_items for each row execute function public.bb_assign_prep_station();
-- Existing active orders enter the common station; changing mappings affects new items only.
update public.order_items set prep_station_id=(select id from public.prep_stations where is_default) where prep_station_id is null and order_id in(select id from public.orders where status in('pending','confirmed','preparing','ready'));
insert into public.prep_tickets(order_id,station_id,status) select distinct i.order_id,i.prep_station_id,case when o.status='ready' then 'ready' when o.status='preparing' then 'preparing' else 'waiting' end from public.order_items i join public.orders o on o.id=i.order_id where i.prep_station_id is not null on conflict do nothing;
create function public.bb_save_prep_station(p jsonb) returns uuid language plpgsql set search_path=public as $$
declare sid uuid;cid uuid;begin
 perform pg_advisory_xact_lock(7162016);
 sid:=nullif(p->>'id','')::uuid;
 if sid is null then insert into public.prep_stations(name) values(p->>'name') returning id into sid;end if;
 if exists(select 1 from public.prep_stations where id=sid and is_default) then update public.prep_stations set name=p->>'name',screen_enabled=(p->>'screen_enabled')::boolean,printer_enabled=(p->>'printer_enabled')::boolean,printer_name=p->>'printer_name',paper=p->>'paper' where id=sid;
 else
 update public.prep_stations set name=p->>'name',enabled=(p->>'enabled')::boolean,screen_enabled=(p->>'screen_enabled')::boolean,printer_enabled=(p->>'printer_enabled')::boolean,printer_name=p->>'printer_name',paper=p->>'paper' where id=sid;
 if not found then raise exception 'station_not_found';end if;
 delete from public.prep_routes where station_id=sid;
 for cid in select jsonb_array_elements_text(p->'category_ids')::uuid loop
 if exists(select 1 from public.prep_routes where category_id=cid and station_id<>sid) then raise exception 'category_already_assigned';end if;
 insert into public.prep_routes(category_id,station_id) values(cid,sid) on conflict do nothing;
 end loop;
 end if;return sid;
end $$;
revoke all on function public.bb_save_prep_station(jsonb) from public,anon,authenticated;grant execute on function public.bb_save_prep_station(jsonb) to service_role;
create function public.bb_update_prep_ticket(oid uuid,sid uuid,next_status text) returns text language plpgsql set search_path=public as $$
declare parent_status text;current_status text;begin
 if next_status not in('preparing','ready') then raise exception 'invalid_status';end if;
 select status into parent_status from public.orders where id=oid for update;
 if parent_status not in('pending','confirmed','preparing','ready') or parent_status is null then raise exception 'order_not_active';end if;
 select status into current_status from public.prep_tickets where order_id=oid and station_id=sid for update;
 if current_status is null then raise exception 'ticket_not_found';end if;
 if current_status='ready' and next_status<>'ready' then raise exception 'station_already_ready';end if;
 update public.prep_tickets set status=next_status,updated_at=now() where order_id=oid and station_id=sid;
 if not exists(select 1 from public.prep_tickets where order_id=oid and status<>'ready') then parent_status:='ready';
 elsif parent_status<>'ready' then parent_status:='preparing';end if;
 update public.orders set status=parent_status,updated_at=now() where id=oid;
 return parent_status;
end $$;
revoke all on function public.bb_update_prep_ticket(uuid,uuid,text) from public,anon,authenticated;grant execute on function public.bb_update_prep_ticket(uuid,uuid,text) to service_role;
