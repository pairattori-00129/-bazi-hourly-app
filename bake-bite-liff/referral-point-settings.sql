-- Editable reward values. Existing awards and balances are never recalculated.
create table if not exists public.referral_point_settings (
  id integer primary key default 1 check (id = 1),
  share_points integer not null default 1 check (share_points between 0 and 100),
  first_purchase_points integer not null default 5 check (first_purchase_points between 0 and 100),
  updated_at timestamptz not null default now()
);
insert into public.referral_point_settings(id) values(1) on conflict(id) do nothing;
alter table public.referral_point_settings enable row level security;
revoke all on public.referral_point_settings from public,anon,authenticated;

create or replace function public.accept_member_referral(p_friend_id uuid, p_code text)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_inviter uuid; v_points integer;
begin
  select id into v_inviter from public.members where referral_code = upper(p_code);
  if v_inviter is null then return 'invalid_code'; end if;
  if v_inviter = p_friend_id then return 'self_referral'; end if;
  if exists(select 1 from public.member_referrals where friend_id = p_friend_id) then return 'already_referred'; end if;
  if exists(select 1 from public.orders where member_id = p_friend_id) then return 'existing_customer'; end if;

  insert into public.member_referrals(inviter_id,friend_id) values(v_inviter,p_friend_id)
    on conflict(friend_id) do nothing;
  if not found then return 'already_referred'; end if;
  select share_points into v_points from public.referral_point_settings where id=1;
  if v_points > 0 then
    update public.members set points=points+v_points,updated_at=now() where id=v_inviter;
    insert into public.point_transactions(member_id,transaction_type,points,description)
      values(v_inviter,'earn',v_points,'แนะนำเพื่อนเปิดร้านผ่าน LINE');
  end if;
  return 'rewarded';
end $$;
revoke all on function public.accept_member_referral(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_member_referral(uuid,text) to service_role;

create or replace function public.reward_first_referred_purchase()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_referral uuid; v_inviter uuid; v_points integer;
begin
  if new.member_id is null or new.status <> 'completed' or new.payment_status <> 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'completed' and old.payment_status = 'paid' then return new; end if;
  if exists(select 1 from public.orders o where o.member_id=new.member_id
    and o.id<>new.id and o.status='completed' and o.payment_status='paid'
    and (o.created_at,o.id)<(new.created_at,new.id)) then return new; end if;
  update public.member_referrals r
    set first_purchase_order_id=new.id,first_purchase_rewarded_at=now()
    where r.friend_id=new.member_id and r.first_purchase_rewarded_at is null
    returning r.id,r.inviter_id into v_referral,v_inviter;
  if v_referral is null then return new; end if;
  select first_purchase_points into v_points from public.referral_point_settings where id=1;
  if v_points > 0 then
    update public.members set points=points+v_points,updated_at=now() where id=v_inviter;
    insert into public.point_transactions(member_id,transaction_type,points,description)
      values(v_inviter,'earn',v_points,'เพื่อนที่แนะนำสั่งซื้อครั้งแรก: '||new.order_no);
  end if;
  return new;
end $$;
revoke all on function public.reward_first_referred_purchase() from public,anon,authenticated;
