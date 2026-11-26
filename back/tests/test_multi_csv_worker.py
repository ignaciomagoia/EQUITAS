from __future__ import annotations

import pytest

from ETL import multi_csv_worker
from ETL.multi_csv_worker import MultiInstitutionCsvWorker


class RecordingWorker(MultiInstitutionCsvWorker):
    def __init__(self) -> None:
        self.client = object()
        self.worker_id = "test-worker"
        self.updates: list[tuple[int, dict[str, object]]] = []

    def _update_job(self, job_id: int, payload: dict[str, object]) -> None:
        self.updates.append((job_id, payload))


class ExistingRowsWorker(RecordingWorker):
    def _fetch_all(self, table: str, institution_id: int, columns: str):
        del institution_id, columns
        fixtures = {
            "debtor": [
                {"id": 1, "identity_hash": "debtor-active", "identity_scheme_id": 10, "description": "Actual"},
                {"id": 2, "identity_hash": "debtor-retired", "identity_scheme_id": 99, "description": "Otro"},
            ],
            "debt": [
                {"debtor_id": 1, "identity_hash": "debt-active", "identity_scheme_id": 20},
                {"debtor_id": 1, "identity_hash": "debt-retired", "identity_scheme_id": 98},
            ],
            "person": [
                {"identity_hash": "person-active", "identity_scheme_id": 30, "full_name": "Persona"},
                {"identity_hash": "person-retired", "identity_scheme_id": 97, "full_name": "Otra"},
            ],
            "institution_debt_status": [],
        }
        return fixtures[table]


def test_worker_blocks_apply_when_the_explicit_worker_flag_is_not_enabled() -> None:
    worker = RecordingWorker()
    worker.apply_enabled = False

    worker.process_job({"id": 71, "mode": "APPLY", "storage_path": "unused.csv"})

    assert worker.updates == [
        (
            71,
            {
                "status": "FAILED",
                    "error_message": "La aplicacion real Multi esta bloqueada en el worker. MULTI_IMPORT_APPLY_ENABLED debe ser exactamente true.",
                "completed_at": worker.updates[0][1]["completed_at"],
            },
        )
    ]


def test_apply_flag_requires_the_exact_true_value() -> None:
    assert multi_csv_worker.is_multi_apply_enabled({"MULTI_IMPORT_APPLY_ENABLED": "true"})
    assert not multi_csv_worker.is_multi_apply_enabled({"MULTI_IMPORT_APPLY_ENABLED": "TRUE "})
    assert not multi_csv_worker.is_multi_apply_enabled({"MULTI_IMPORT_APPLY_ENABLED": "1"})
    assert not multi_csv_worker.is_multi_apply_enabled({})


class ApplyWorker(RecordingWorker):
    def __init__(self) -> None:
        super().__init__()
        self.apply_enabled = True
        self.calls: list[str] = []

    def _run_rpc(self, name: str, arguments: dict[str, object]):
        self.calls.append(name)
        assert arguments == {"p_job_id": 72}
        return object()


def test_profile_recovery_does_not_repeat_the_merge() -> None:
    worker = ApplyWorker()

    worker.process_job({"id": 72, "mode": "APPLY", "merge_completed_at": "2026-11-26T00:00:00Z"})

    assert worker.calls == ["recalculate_multiinstitution_import_profiles"]
    assert not any(payload.get("status") == "MERGING" for _job_id, payload in worker.updates)


def test_existing_comparison_only_reads_rows_matching_the_profile_identity_schemes() -> None:
    worker = ExistingRowsWorker()

    debtors, debts, people = worker._existing_rows(
        1,
        {"identity_scheme_ids": {"debtor": 10, "debt": 20, "person": 30}},
    )

    assert set(debtors) == {"debtor-active"}
    assert set(debts) == {("debtor-active", "debt-active")}
    assert set(people) == {"person-active"}


def test_person_identity_uses_document_when_the_profile_does_not_map_an_external_person_id() -> None:
    row = {"normalized_values": {"person_document_number": "90000001"}}
    snapshot = {
        "identity_fields": {"person": ["document_number"]},
        "identity_value_fields": {"person": "person_document_number"},
    }

    value = MultiInstitutionCsvWorker._row_identity_hash(row, snapshot, "PERSON")

    assert value is not None


def test_multi_client_rejects_a_url_that_does_not_match_its_declared_project_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MULTI_SUPABASE_URL", "https://legacy-project.supabase.co")
    monkeypatch.setenv("MULTI_SUPABASE_PROJECT_REF", "multi-project")
    monkeypatch.setenv("MULTI_SUPABASE_SERVICE_ROLE_KEY", "test-key")

    with pytest.raises(RuntimeError, match="no corresponde"):
        multi_csv_worker.create_multi_client()


def test_multi_client_rejects_any_project_ref_other_than_the_authorized_multi_project(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MULTI_SUPABASE_URL", "https://another-project.supabase.co")
    monkeypatch.setenv("MULTI_SUPABASE_PROJECT_REF", "another-project")
    monkeypatch.setenv("MULTI_SUPABASE_SERVICE_ROLE_KEY", "test-key")

    with pytest.raises(RuntimeError, match="Multiinstitucion autorizado"):
        multi_csv_worker.create_multi_client()


class PlatformQuery:
    def __init__(self) -> None:
        self.selected: str | None = None
        self.filters: list[tuple[str, object]] = []

    def select(self, columns: str) -> PlatformQuery:
        self.selected = columns
        return self

    def eq(self, column: str, value: object) -> PlatformQuery:
        self.filters.append((column, value))
        return self

    def maybe_single(self) -> PlatformQuery:
        return self

    def execute(self):
        return type(
            "Response",
            (),
            {
                "data": {
                    "singleton": True,
                    "platform_key": "EQUITAS_MULTIINSTITUTION",
                    "schema_version": 1,
                }
            },
        )()


class PlatformClient:
    def __init__(self) -> None:
        self.query = PlatformQuery()
        self.table_name: str | None = None

    def table(self, name: str) -> PlatformQuery:
        self.table_name = name
        return self.query


def test_platform_guard_queries_the_real_platform_installation_columns() -> None:
    client = PlatformClient()
    worker = MultiInstitutionCsvWorker(client=client)

    worker._assert_multi_platform()

    assert client.table_name == "platform_installation"
    assert client.query.selected == "singleton,platform_key,schema_version"
    assert client.query.filters == [("singleton", True)]
