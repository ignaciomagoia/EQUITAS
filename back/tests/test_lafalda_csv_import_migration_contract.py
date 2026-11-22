from pathlib import Path
from types import SimpleNamespace

import pytest
from postgrest.exceptions import APIError

import ETL.daily_csv_worker as worker_module

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = PROJECT_ROOT / "supabase" / "migrations" / "20261121190000_lafalda_csv_imports.sql"
SCHEMA_PATH = PROJECT_ROOT / "database" / "schema-observado-2026-10-21.json"


def _migration_sql() -> str:
    return MIGRATION_PATH.read_text(encoding="utf-8")


def test_migration_stages_missing_amounts_without_fallbacks():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "original_amount numeric check (original_amount >= 0)" in sql
    assert "current_amount numeric check (current_amount >= 0)" in sql
    assert "coalesce(stage.original_amount, 0)" not in sql
    assert "coalesce(stage.current_amount, 0)" not in sql
    assert "Deuda importada desde CSV" not in sql
    assert "stage.description," in sql
    assert SCHEMA_PATH.exists()


def test_migration_requires_amounts_only_for_new_debts():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "and not exists (" in sql
    assert "from public.debt debt" in sql
    assert "stage.original_amount is null" in sql
    assert "stage.current_amount is null" in sql
    assert "and stage.original_amount is not null" in sql
    assert "and stage.current_amount is not null" in sql


def test_migration_guards_apply_and_dry_run_paths():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "if v_tenant <> 1 then" in sql
    assert "if p_require_apply and v_mode <> 'apply' then" in sql
    assert "array['MERGING']" in sql
    assert "perform public.assert_lafalda_import_job(" in sql
    assert "array['STAGING', 'MERGING']" in sql


def test_migration_blocks_apply_by_default_at_database_level():
    # Arrange
    sql = _migration_sql()
    apply_function = sql[sql.index("create or replace function public.apply_lafalda_import_stage") :]

    # Act / Assert
    assert "create table if not exists public.lafalda_import_control" in sql
    assert "apply_enabled boolean not null default false" in sql
    assert "values (1, false)" in sql
    assert "revoke all on public.lafalda_import_control from public, anon, authenticated, service_role" in sql
    assert "from public.lafalda_import_control" in apply_function
    assert "if coalesce(v_apply_enabled, false) is not true then" in apply_function
    assert "La aplicacion de importaciones CSV esta bloqueada a nivel de base de datos." in apply_function
    assert apply_function.index("if coalesce(v_apply_enabled, false) is not true then") < apply_function.index(
        "update public.debt debt"
    )


def test_migration_recovers_expired_locks_and_allows_new_dry_run_history():
    # Arrange
    sql = _migration_sql()

    # Act / Assert
    assert "job.lock_expires_at <= now()" in sql
    assert "job.created_at <= now() - interval '2 hours'" in sql
    assert "data_import_job_tenant_hash_idx" in sql
    assert "unique (tenant, content_sha256)" not in sql


class _RecordingQuery:
    def __init__(self) -> None:
        self.payload: dict[str, object] | None = None

    def update(self, payload: dict[str, object]) -> "_RecordingQuery":
        self.payload = payload
        return self

    def eq(self, *_args: object) -> "_RecordingQuery":
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=None)


class _RecordingSupabase:
    def __init__(self) -> None:
        self.query = _RecordingQuery()

    def table(self, _table_name: str) -> _RecordingQuery:
        return self.query


def test_worker_renews_active_lock_and_releases_terminal_lock(monkeypatch):
    # Arrange
    recording_supabase = _RecordingSupabase()
    monkeypatch.setattr(worker_module, "supabase", recording_supabase)
    monkeypatch.setattr(
        worker_module,
        "execute_supabase_operation",
        lambda _operation_name, operation: operation(),
    )
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1)

    # Act
    worker._update_job(1, {"status": "STAGING"})
    active_payload = recording_supabase.query.payload
    worker._update_job(1, {"status": "DRY_RUN_COMPLETED"})
    terminal_payload = recording_supabase.query.payload

    # Assert
    assert active_payload is not None
    assert active_payload["lock_expires_at"] is not None
    assert terminal_payload is not None
    assert terminal_payload["lock_expires_at"] is None


def test_worker_records_a_supabase_api_error_without_masking_it(monkeypatch):
    # Arrange
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1)
    api_error = APIError(
        {
            "message": "No se pudo descargar el archivo privado.",
            "code": "storage_error",
            "hint": None,
            "details": None,
        }
    )
    updates: list[dict[str, object]] = []
    monkeypatch.setattr(
        worker,
        "_claim_next_job",
        lambda: {"id": 71, "tenant": 1, "storage_path": "tenant-1/prueba.csv"},
    )
    monkeypatch.setattr(worker, "_download_file", lambda _storage_path: (_ for _ in ()).throw(api_error))
    monkeypatch.setattr(worker, "_update_job", lambda _job_id, payload: updates.append(payload))

    # Act / Assert
    with pytest.raises(APIError, match="No se pudo descargar"):
        worker.process_once()

    assert updates[-1]["status"] == "FAILED"
    assert "No se pudo descargar" in str(updates[-1]["error_message"])
