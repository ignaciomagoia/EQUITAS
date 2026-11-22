from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    PROJECT_ROOT
    / "supabase"
    / "migrations"
    / "20261122110000_lafalda_import_authorization_audit.sql"
)


def _migration_sql() -> str:
    return MIGRATION_PATH.read_text(encoding="utf-8")


def test_import_authorization_is_explicit_and_disabled_by_default():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "create table if not exists public.data_import_authorization" in sql
    assert "check (tenant = 1)" in sql
    assert "can_import boolean not null default false" in sql
    assert "can_apply boolean not null default false" in sql
    assert "check (not can_apply or can_import)" in sql
    assert "insert into public.data_import_authorization" not in sql


def test_authorization_table_is_not_available_to_authenticated_users():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "alter table public.data_import_authorization enable row level security" in sql
    assert "revoke all on public.data_import_authorization from public, anon, authenticated, service_role" in sql
    assert "grant select on public.data_import_authorization to service_role" in sql
    assert "grant all on public.data_import_authorization" not in sql


def test_worker_claim_and_apply_revalidate_the_requesting_user():
    # Arrange
    sql = _migration_sql()
    claim_function = sql[sql.index("create or replace function public.claim_lafalda_import_job") :]
    apply_function = sql[sql.index("create or replace function public.apply_lafalda_import_stage") :]

    # Act / Assert
    assert "authz.active" in claim_function
    assert "authz.can_import" in claim_function
    assert "La autorizacion del solicitante no esta vigente" in claim_function
    assert "perform public.assert_lafalda_import_requester_authorized(p_job_id, true)" in apply_function
    assert apply_function.index("assert_lafalda_import_requester_authorized") < apply_function.index(
        "update public.debt debt"
    )


def test_apply_audits_changes_without_recording_personal_data_in_event_log():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "create table if not exists public.data_import_audit_event" in sql
    assert "create table if not exists public.data_import_debt_change" in sql
    assert "create trigger data_import_job_audit_trigger" in sql
    assert "event_type in ('CREATED', 'STATUS_CHANGED')" in sql
    assert "if tg_op = 'INSERT' then" in sql
    assert "elsif old.status is distinct from new.status then" in sql
    assert "error_message" not in sql[sql.index("create table if not exists public.data_import_audit_event") : sql.index("create table if not exists public.data_import_debt_change")]
    assert "from public.debt debt" in sql
    assert "before_values" in sql
    assert "after_values" in sql


def test_apply_uses_job_scoped_snapshots_to_keep_retries_idempotent():
    # Arrange
    sql = _migration_sql()
    apply_function = sql[sql.index("create or replace function public.apply_lafalda_import_stage") :]

    # Act / Assert
    assert "on conflict (job, debtor, debt_external_id) do nothing" in apply_function
    assert "from public.data_import_debt_change debt_change" in apply_function
    assert "v_unchanged_rows := greatest(v_valid_rows - v_updated_rows - v_inserted_rows, 0)" in apply_function
    assert "on conflict (debtor, external_id) do nothing" in apply_function


def test_existing_database_gate_remains_required_before_any_debt_write():
    # Arrange
    sql = _migration_sql()
    apply_function = sql[sql.index("create or replace function public.apply_lafalda_import_stage") :]

    # Act / Assert
    gate = "if coalesce(v_apply_enabled, false) is not true then"
    assert gate in apply_function
    assert apply_function.index(gate) < apply_function.index("insert into public.data_import_debt_change")
    assert apply_function.index(gate) < apply_function.index("update public.debt debt")
