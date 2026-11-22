from pathlib import Path
from types import SimpleNamespace

import pytest

import ETL.daily_csv_worker as worker_module

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    PROJECT_ROOT
    / "supabase"
    / "migrations"
    / "20261122120000_lafalda_apply_worker_recovery.sql"
)


def _apply_job(**overrides: object) -> dict[str, object]:
    job: dict[str, object] = {
        "id": 91,
        "tenant": 1,
        "mode": "apply",
        "storage_path": "tenant-1/import.csv",
        "content_sha256": "a" * 64,
        "profile_recalculation_attempt_count": 0,
        "inserted_rows": 1,
        "updated_rows": 2,
        "unchanged_rows": 3,
        "rejected_rows": 0,
    }
    job.update(overrides)
    return job


@pytest.mark.parametrize("value", [None, "", "false", "FALSE", "1", "yes"])
def test_apply_feature_flag_requires_exact_true(value: str | None) -> None:
    # Act / Assert
    assert worker_module.is_lafalda_import_apply_enabled(value) is False


def test_apply_feature_flag_accepts_explicit_true() -> None:
    # Act / Assert
    assert worker_module.is_lafalda_import_apply_enabled("true") is True
    assert worker_module.is_lafalda_import_apply_enabled(" TRUE ") is True


def test_worker_does_not_apply_a_claimed_job_when_apply_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1, apply_enabled=False)
    updates: list[dict[str, object]] = []
    monkeypatch.setattr(worker, "_claim_next_job", lambda: _apply_job())
    monkeypatch.setattr(worker, "_update_job", lambda _job_id, payload: updates.append(payload))
    monkeypatch.setattr(worker, "_run_rpc", lambda *_args: pytest.fail("No debe invocar apply."))
    monkeypatch.setattr(worker, "_download_file", lambda *_args: pytest.fail("No debe descargar el CSV."))

    # Act
    processed = worker.process_once()

    # Assert
    assert processed is True
    assert updates == [
        {
            "status": "QUEUED",
            "error_message": (
                "La aplicación está deshabilitada en este worker por "
                "LAFALDA_IMPORT_APPLY_ENABLED."
            ),
            "lock_expires_at": None,
        }
    ]


def test_profile_recalculation_failure_keeps_merge_completed_for_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1, apply_enabled=True)
    updates: list[dict[str, object]] = []
    job = _apply_job(merge_completed_at="2026-11-22T20:00:00+00:00")
    monkeypatch.setattr(worker, "_claim_next_job", lambda: job)
    monkeypatch.setattr(
        worker,
        "_recalculate_profiles",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("perfil no disponible")),
    )
    monkeypatch.setattr(worker, "_update_job", lambda _job_id, payload: updates.append(payload))
    monkeypatch.setattr(worker, "_run_rpc", lambda *_args: pytest.fail("No debe repetir el merge."))
    monkeypatch.setattr(worker, "_download_file", lambda *_args: pytest.fail("No debe releer el CSV."))

    # Act
    processed = worker.process_once()

    # Assert
    assert processed is True
    assert updates[-1]["status"] == "RECALCULATING_PROFILES"
    assert updates[-1]["profile_recalculation_error"] == "perfil no disponible"
    assert updates[-1]["lock_expires_at"] is None


def test_profile_recovery_recalculates_without_repeating_debt_merge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1, apply_enabled=True)
    updates: list[dict[str, object]] = []
    job = _apply_job(merge_completed_at="2026-11-22T20:00:00+00:00")
    monkeypatch.setattr(worker, "_claim_next_job", lambda: job)
    monkeypatch.setattr(worker, "_recalculate_profiles", lambda *_args: None)
    monkeypatch.setattr(worker, "_update_job", lambda _job_id, payload: updates.append(payload))
    monkeypatch.setattr(worker, "_run_rpc", lambda *_args: pytest.fail("No debe repetir el merge."))
    monkeypatch.setattr(worker, "_download_file", lambda *_args: pytest.fail("No debe releer el CSV."))

    # Act
    processed = worker.process_once()

    # Assert
    assert processed is True
    assert updates[-1]["status"] == "COMPLETED"
    assert updates[-1]["profiles_recalculated_at"] is not None
    assert updates[-1]["inserted_rows"] == 1
    assert updates[-1]["updated_rows"] == 2


def test_worker_claims_apply_only_when_explicitly_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange
    calls: list[tuple[str, dict[str, object]]] = []

    class FakeSupabase:
        def rpc(self, function_name: str, payload: dict[str, object]) -> SimpleNamespace:
            calls.append((function_name, payload))
            return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))

    monkeypatch.setattr(worker_module, "supabase", FakeSupabase())
    monkeypatch.setattr(worker_module, "execute_supabase_operation", lambda _name, operation: operation())
    worker = worker_module.LafaldaDailyCsvWorker(tenant_id=1, apply_enabled=False)

    # Act
    assert worker._claim_next_job() is None

    # Assert
    assert calls == [
        (
            "claim_lafalda_import_job_v2",
            {
                "p_worker_id": worker.worker_id,
                "p_tenant_id": 1,
                "p_allow_apply": False,
            },
        )
    ]


def test_recovery_migration_persists_merge_before_profiles_and_gates_claims() -> None:
    # Arrange
    sql = MIGRATION_PATH.read_text(encoding="utf-8")

    # Act / Assert
    assert "add column if not exists merge_completed_at" in sql
    assert "add column if not exists profiles_recalculated_at" in sql
    assert "profile_recalculation_attempt_count" in sql
    assert "create or replace function public.claim_lafalda_import_job_v2" in sql
    assert "and (job.mode = 'dry_run' or p_allow_apply)" in sql
    assert "merge_completed_at = coalesce(job.merge_completed_at, now())" in sql
    assert sql.index("merge_completed_at = coalesce(job.merge_completed_at, now())") < sql.index(
        "return jsonb_build_object"
    )
    assert "Las deudas no se volverán a aplicar." not in sql
