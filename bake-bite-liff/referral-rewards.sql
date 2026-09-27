-- A referral becomes eligible when a different LINE member opens the invite.
alter table public.members add column if not exists referral_code text;
update public.members set referral_code = upper(substr(md5(gen_random_uuid()::text), 1, 12)) where referral_code is null;
alter table public.members alter column referral_code set default upper(substr(md5(gen_random_uuid()::text), 1, 12));
alter table public.members alter column referral_code set not null;
create unique index if not exists members_referral_code_idx on public.members(referral_code);

create table if not exists public.member_referrals (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references public.members(id) on delete cascade,
  friend_id uuid not null unique references public.members(id) on delete cascade,
  first_purchase_order_id uuid unique references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  first_purchase_rewarded_at timestamptz,
  constraint member_referrals_not_self check (inviter_id <> friend_id)
);
create index if not exists member_referrals_inviter_idx on public.member_referrals(inviter_id);
alter table public.member_referrals enable row level security;

-- Callable only by the server with its service-role key, after verifying a LINE access token.
create or replace function public.accept_member_referral(p_friend_id uuid, p_code text)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_inviter uuid;
begin
  select id into v_inviter from public.members where referral_code = upper(p_code);
  if v_inviter is null then return 'invalid_code'; end if;
  if v_inviter = p_friend_id then return 'self_referral'; end if;
  if exists(select 1 from public.member_referrals where friend_id = p_friend_id) then return 'already_referred'; end if;
  if exists(select 1 from public.orders where member_id = p_friend_id) then return 'existing_customer'; end if;

  insert into public.member_referrals(inviter_id,friend_id) values(v_inviter,p_friend_id)
    on conflict(friend_id) do nothing;
  if not found then return 'already_referred'; end if;
  update public.members set points=points+1,updated_at=now() where id=v_inviter;
  insert into public.point_transactions(member_id,transaction_type,points,description)
    values(v_inviter,'earn',1,'แนะนำเพื่อนเปิดร้านผ่าน LINE');
  return 'rewarded';
end $$;
revoke all on function public.accept_member_referral(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_member_referral(uuid,text) to service_role;

-- Order completion and confirmed payment can arrive in either order.
create or replace function public.reward_first_referred_purchase()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_referral uuid; v_inviter uuid;
begin
  if new.member_id is null or new.status <> 'completed' or new.payment_status <> 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'completed' and old.payment_status = 'paid' then return new; end if;
  -- The earliest completed, paid order for this friend wins (one referral bonus).
  if exists(select 1 from public.orders o where o.member_id=new.member_id
    and o.id<>new.id and o.status='completed' and o.payment_status='paid'
    and (o.created_at,o.id)<(new.created_at,new.id)) then return new; end if;
  update public.member_referrals r
    set first_purchase_order_id=new.id,first_purchase_rewarded_at=now()
    where r.friend_id=new.member_id and r.first_purchase_rewarded_at is null
    returning r.id,r.inviter_id into v_referral,v_inviter;
  if v_referral is null then return new; end if;
  update public.members set points=points+5,updated_at=now() where id=v_inviter;
  insert into public.point_transactions(member_id,transaction_type,points,description)
    values(v_inviter,'earn',5,'เพื่อนที่แนะนำสั่งซื้อครั้งแรก: '||new.order_no);
  return new;
end $$;
revoke all on function public.reward_first_referred_purchase() from public,anon,authenticated;
drop trigger if exists reward_first_referred_purchase_trigger on public.orders;
create trigger reward_first_referred_purchase_trigger
  after insert or update of status,payment_status on public.orders
  for each row execute function public.reward_first_referred_purchase();
