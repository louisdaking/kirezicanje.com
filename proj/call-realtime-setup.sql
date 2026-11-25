-- Run once in Supabase SQL Editor to enable private call signaling.
-- Realtime broadcast must be enabled for private channels in the Supabase project.
-- Only the addressed user can read an inbox channel. Node.js dispatches invites;
-- SDP and ICE are shared only inside rooms authorized for both call participants.

drop policy if exists "kc call inbox recipient reads" on realtime.messages;
create policy "kc call inbox recipient reads"
on realtime.messages
for select
to authenticated
using (
  split_part(realtime.topic(), ':', 1) = 'kc-call-inbox'
  and split_part(realtime.topic(), ':', 2) = auth.uid()::text
);

drop policy if exists "kc call participants read room" on realtime.messages;
create policy "kc call participants read room"
on realtime.messages
for select
to authenticated
using (
  split_part(realtime.topic(), ':', 1) = 'kc-call-room'
  and auth.uid()::text in (
    split_part(realtime.topic(), ':', 3),
    split_part(realtime.topic(), ':', 4)
  )
);

drop policy if exists "kc call participants publish room" on realtime.messages;
create policy "kc call participants publish room"
on realtime.messages
for insert
to authenticated
with check (
  split_part(realtime.topic(), ':', 1) = 'kc-call-room'
  and auth.uid()::text in (
    split_part(realtime.topic(), ':', 3),
    split_part(realtime.topic(), ':', 4)
  )
);
