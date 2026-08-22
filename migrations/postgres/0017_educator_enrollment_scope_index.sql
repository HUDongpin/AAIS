create index if not exists aais_enrollments_user_scope_idx
  on public.aais_enrollments (user_id, role, status, course_id, cohort);
