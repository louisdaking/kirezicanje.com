-- Everybody follows the administrators automatically.
-- Admins = rows of public.monetization_admins(user_id). Run once in the Supabase SQL editor. Safe to run again.

-- 1) Everybody who exists now follows every admin (skips existing follows and an admin following himself)
insert into public.follows (follower_id, following_id)
select p.id, a.user_id
from public.profiles p
cross join public.monetization_admins a
where p.id <> a.user_id
  and not exists (select 1 from public.follows f where f.follower_id = p.id and f.following_id = a.user_id);

-- 2) Every NEW user follows all admins as soon as his profile is created
create or replace function public.kc_follow_admins_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.follows (follower_id, following_id)
  select new.id, a.user_id
  from public.monetization_admins a
  where a.user_id <> new.id
    and not exists (select 1 from public.follows f where f.follower_id = new.id and f.following_id = a.user_id);
  return new;
end $$;

drop trigger if exists kc_follow_admins_new_user on public.profiles;
create trigger kc_follow_admins_new_user after insert on public.profiles
  for each row execute function public.kc_follow_admins_new_user();

-- 3) When a NEW admin is added, everybody follows him
create or replace function public.kc_everyone_follows_new_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.follows (follower_id, following_id)
  select p.id, new.user_id
  from public.profiles p
  where p.id <> new.user_id
    and not exists (select 1 from public.follows f where f.follower_id = p.id and f.following_id = new.user_id);
  return new;
end $$;

drop trigger if exists kc_everyone_follows_new_admin on public.monetization_admins;
create trigger kc_everyone_follows_new_admin after insert on public.monetization_admins
  for each row execute function public.kc_everyone_follows_new_admin();
