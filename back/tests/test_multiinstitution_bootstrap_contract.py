from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MULTI_ROOT = PROJECT_ROOT / "supabase" / "multiinstitution"
BOOTSTRAP_MIGRATION = MULTI_ROOT / "migrations" / "20261123091100_multi_bootstrap_first_platform_admin.sql"
INITIAL_PROVISION_MIGRATION = MULTI_ROOT / "migrations" / "20261123091200_multi_initial_institution_provisioning.sql"
MEMBER_ADMINISTRATION_MIGRATION = MULTI_ROOT / "migrations" / "20261123091300_multi_institution_member_administration.sql"
DRY_RUN_MIGRATION = MULTI_ROOT / "migrations" / "20261123091400_multi_import_dry_run.sql"
APPLY_MIGRATION = MULTI_ROOT / "migrations" / "20261123091600_multi_import_apply.sql"
IMPORT_CONFIGURATION_TRIGGER_FIX_MIGRATION = (
    MULTI_ROOT / "migrations" / "20261123091500_multi_import_configuration_trigger_fix.sql"
)
FIXTURE_SCRIPT = MULTI_ROOT / "testing" / "seed-multiinstitution-fixtures.sql"
ENABLE_APPLY_SCRIPT = MULTI_ROOT / "testing" / "enable-universidad-demo-apply.sql"
DISABLE_APPLY_SCRIPT = MULTI_ROOT / "testing" / "disable-universidad-demo-apply.sql"
RLS_SCRIPT = MULTI_ROOT / "testing" / "verify-multiinstitution-rls.sql"
PREFLIGHT_SCRIPT = MULTI_ROOT / "testing" / "verify-initial-provisioning-preflight.sql"
DIAGNOSTIC_SCRIPT = MULTI_ROOT / "testing" / "diagnose-university-demo-provisioning.sql"
PLATFORM_GUARD_MIGRATION = MULTI_ROOT / "migrations" / "20261123090000_multi_platform_guard.sql"
IMPORT_JOBS_MIGRATION = MULTI_ROOT / "migrations" / "20261123090700_multi_import_jobs.sql"
IMPORT_SECURITY_MIGRATION = MULTI_ROOT / "migrations" / "20261123090800_multi_import_security.sql"
MULTI_WORKER = PROJECT_ROOT / "back" / "ETL" / "multi_csv_worker.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_future_platform_admin_bootstrap_is_one_time_and_not_client_executable():
    sql = _read(BOOTSTRAP_MIGRATION)

    assert "select public.assert_multiinstitution_platform();" in sql
    assert "for update;" in sql
    assert "if exists (select 1 from public.platform_user_role) then" in sql
    assert "revoke all on function public.bootstrap_first_platform_admin(uuid, text) from public, anon, authenticated;" in sql
    assert "grant execute on function public.bootstrap_first_platform_admin(uuid, text) to service_role;" in sql
    assert "security definer" in sql
    assert "set search_path = public, pg_temp" in sql


def test_initial_institution_provision_creates_no_platform_role_and_is_service_only():
    sql = _read(INITIAL_PROVISION_MIGRATION)
    compact_sql = " ".join(sql.split())

    assert "create or replace function public.provision_initial_institution_admin(" in sql
    assert "if exists (select 1 from public.institution)" in sql
    assert "values (v_institution_id, p_auth_user_id, 'ACTIVE', null)" in sql
    assert "values ( v_institution_id, v_membership_id, true, false, true, null )" in compact_sql
    assert "insert into public.platform_user_role" not in sql
    assert "revoke all on function public.provision_initial_institution_admin" in sql


def test_multi_imports_are_blocked_at_database_level_until_the_apply_migration_is_installed():
    sql = _read(DRY_RUN_MIGRATION)

    assert "add column if not exists dry_run_summary" in sql
    assert "create trigger import_job_dry_run_only_trigger" in sql
    assert "if new.mode = 'APPLY' then" in sql
    assert "Las importaciones APPLY de Multiinstitucion no estan habilitadas." in sql

    apply_sql = _read(APPLY_MIGRATION)
    assert "drop trigger if exists import_job_dry_run_only_trigger" in apply_sql
    assert "control.apply_enabled" in apply_sql
    assert "authorization_row.can_apply" in apply_sql


def test_import_configuration_trigger_never_reads_columns_from_another_trigger_table():
    sql = _read(IMPORT_CONFIGURATION_TRIGGER_FIX_MIGRATION)

    assert "if tg_table_name = 'import_identity_scheme' then" in sql
    assert "if tg_table_name = 'import_profile_version' then" in sql
    assert "if tg_table_name = 'import_field_mapping' then" in sql
    assert "tg_table_name = 'import_identity_scheme' and" not in sql
    assert "tg_table_name = 'import_profile_version' and" not in sql
    assert "if tg_op = 'UPDATE' and" in sql
    assert "select public.assert_multiinstitution_platform();" in sql
    assert "to service_role;" in sql


def test_multi_csv_worker_matches_the_installed_multiinstitution_schema_contract():
    platform_sql = _read(PLATFORM_GUARD_MIGRATION)
    jobs_sql = _read(IMPORT_JOBS_MIGRATION)
    security_sql = _read(IMPORT_SECURITY_MIGRATION)
    dry_run_sql = _read(DRY_RUN_MIGRATION)
    worker = _read(MULTI_WORKER)

    assert "platform_key text not null" in platform_sql
    assert "schema_version integer not null" in platform_sql
    assert 'select("singleton,platform_key,schema_version")' in worker
    assert '.eq("singleton", True)' in worker
    assert 'MULTIINSTITUTION_PROJECT_REF = "iylwghgvtydpmwidojdo"' in worker

    for table_name in ("import_job", "import_stage_row", "import_row_error", "debtor", "debt", "person"):
        assert f'"{table_name}"' in worker
    for job_column in (
        "profile_snapshot",
        "ignored_columns",
        "lock_expires_at",
    ):
        assert job_column in jobs_sql
        assert f'"{job_column}"' in worker
    assert "dry_run_summary" in dry_run_sql
    assert '"dry_run_summary"' in worker
    assert "claim_multiinstitution_import_job(p_worker_id text)" in security_sql
    assert '"claim_multiinstitution_import_job"' in worker
    assert "DRY_RUN_COMPLETED" in jobs_sql
    assert "DRY_RUN_COMPLETED" in worker


def test_institution_member_administration_stays_within_institution():
    sql = _read(MEMBER_ADMINISTRATION_MIGRATION)

    assert "institution.members.manage" in sql
    assert "private.has_institution_permission(p_institution_id, 'institution.members.manage')" in sql
    assert "from public.institution_role" in sql
    assert "from public.platform_role" not in sql
    assert "create or replace function public.ensure_active_institution()" in sql
    assert "if v_membership_count = 1 then" in sql
    assert "return null;" in sql


def test_synthetic_fixture_uses_one_university_and_disables_apply():
    sql = _read(FIXTURE_SCRIPT)

    assert "universidad-demo" in sql
    assert "provision_initial_institution_admin" in sql
    assert "on conflict (institution_id, identity_scheme_id, identity_hash)" in sql
    assert "apply_enabled = false" in sql
    assert "not authorization_record.can_apply" in sql
    assert "@example.test" in sql
    assert "platform_user_role" not in sql


def test_university_demo_apply_scripts_use_the_real_institution_columns():
    enable_sql = _read(ENABLE_APPLY_SCRIPT)
    disable_sql = _read(DISABLE_APPLY_SCRIPT)

    assert "slug = 'universidad-demo'" in enable_sql
    assert "status = 'ACTIVE'" in enable_sql
    assert "institution.code" not in enable_sql
    assert "and active" not in enable_sql
    assert "slug = 'universidad-demo'" in disable_sql
    assert "import_authorization authorization" not in enable_sql
    assert "import_authorization authorization" not in disable_sql
    assert "authorization." not in enable_sql
    assert "authorization." not in disable_sql


def test_rls_verification_uses_only_transactional_cross_institution_fixtures():
    sql = _read(RLS_SCRIPT)

    assert "set local role authenticated;" in sql
    assert "request.jwt.claim.sub" in sql
    assert "rls-temporal-aislamiento" in sql
    assert "other_institution_debts_visible" in sql
    assert "No tiene permiso para administrar usuarios de esta institucion." in sql
    assert "Solo un administrador de EQUITAS puede crear instituciones." in sql
    assert "insert into auth.users" not in sql
    assert "rls_enabled" in sql
    assert sql.rstrip().endswith("rollback;")


def test_initial_provision_preflight_requires_a_clean_multiinstitution_platform():
    sql = _read(PREFLIGHT_SCRIPT)

    assert "platform_key" in sql
    assert "institutions" in sql
    assert "memberships" in sql
    assert "platform_role_assignments" in sql


def test_provision_diagnostic_checks_each_security_condition_individually():
    sql = _read(DIAGNOSTIC_SCRIPT)

    assert "active_membership_id" in sql
    assert "has_institution_admin_role" in sql
    assert "university_is_selected" in sql
    assert "apply_is_disabled" in sql
    assert "import_is_dry_run_only" in sql
    assert "has_platform_role" in sql
