-- v10: 내 데이터 삭제 (구글 플레이 정책: 앱 안에서 계정과 데이터를 지울 수 있어야 함)
-- v6~v9를 실행한 뒤 실행. 여러 번 실행해도 안전함.

-- 탐험가(기기 열쇠) 데이터 전부 삭제. 본인 열쇠가 맞아야 한다
create or replace function delete_my_data(p_user text, p_secret text) returns json
language plpgsql security definer set search_path = public as $$
declare n_msg int; n_vis int; n_rep int; n_toi int; n_pho int;
begin
  perform check_key(p_user, p_secret);
  delete from messages where user_id = p_user; get diagnostics n_msg = row_count;
  delete from visits where user_id = p_user; get diagnostics n_vis = row_count;
  delete from reports where user_id = p_user; get diagnostics n_rep = row_count;
  delete from toilets where user_id = p_user; get diagnostics n_toi = row_count;
  delete from photos where user_id = p_user; get diagnostics n_pho = row_count;
  delete from photo_reports where user_id = p_user;
  delete from feedback where user_id = p_user;
  delete from claims where user_id = p_user;
  delete from purchases where user_id = p_user;
  delete from profiles where user_id = p_user;  -- 열쇠도 함께 사라진다
  return json_build_object('messages', n_msg, 'visits', n_vis, 'reports', n_rep, 'toilets', n_toi, 'photos', n_pho);
end $$;

-- 구글 로그인 계정 삭제: 로그인한 본인만. 계정 저장소(accounts)는 auth.users 삭제와 함께 지워진다
create or replace function delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  delete from public.accounts where auth_uid = auth.uid();
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.delete_my_data(text, text) from public;
grant execute on function public.delete_my_data(text, text) to anon, authenticated;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

select 'v10 ready' as result;
