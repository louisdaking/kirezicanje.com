-- Run this once in the Supabase SQL editor.
-- It prevents direct API clients from bypassing the app's inbox policy.

create or replace function public.block_external_message_details()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sender_id is distinct from auth.uid() then
    raise exception 'Sender must be the authenticated user';
  end if;

  if new.content is not null then
    if new.content ~ '[0-9]' then
      raise exception 'Numbers are not allowed in messages';
    end if;

    if new.content ~* '(https?://|ftp://|www\.|(^|[^[:alnum:]-])([[:alnum:]-]+\.)+[[:alpha:]]{2,63}([^[:alnum:]-]|$))'
    then
      raise exception 'Links are not allowed in messages';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists block_external_message_details on public.message;

create trigger block_external_message_details
before insert or update of content on public.message
for each row
execute function public.block_external_message_details();
