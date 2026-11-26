from __future__ import annotations

from types import SimpleNamespace

import pytest

from ETL import multi_csv_worker
from ETL.multi_csv_import import MultiImportRowError
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
        assert arguments == {"p_job_id": int(arguments["p_job_id"])}
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


def test_worker_processes_a_dry_run_and_persists_its_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = RecordingWorker()
    staged: list[dict[str, object]] = []
    stored_errors: list[object] = []

    parsed = SimpleNamespace(
        total_rows=2,
        structure=SimpleNamespace(delimiter=",", encoding="UTF-8", ignored_columns=["Ignorada"]),
        rows=[
            {"source_row": 2, "raw_values": {}, "normalized_values": {}, "provided_fields": []},
            {"source_row": 3, "raw_values": {}, "normalized_values": {}, "provided_fields": []},
        ],
        errors=[],
    )
    comparison = SimpleNamespace(
        people_new=1,
        people_updated=0,
        debtor_new=1,
        debtor_updated=0,
        inserted=1,
        updated=0,
        unchanged=1,
        rejected=0,
        preview_rows=[
            {"source_row": 2, "comparison": "NEW"},
            {"source_row": 3, "comparison": "UNCHANGED"},
        ],
    )
    snapshot = {
        "mapping": {"debtor_external_reference": "Cuenta", "debt_external_reference": "Deuda"},
        "identity_fields": {"debtor": ["Cuenta"], "debt": ["Deuda"], "person": []},
        "identity_value_fields": {
            "debtor": "debtor_external_reference",
            "debt": "debt_external_reference",
            "person": None,
        },
        "identity_scheme_ids": {"debtor": 10, "debt": 20, "person": None},
    }
    monkeypatch.setattr(worker, "_download", lambda _path: b"csv")
    monkeypatch.setattr(worker, "_profile_snapshot", lambda _job: snapshot)
    monkeypatch.setattr(multi_csv_worker, "parse_multi_csv_bytes", lambda _content, _mapping: parsed)
    monkeypatch.setattr(
        MultiInstitutionCsvWorker,
        "_row_identity_hash",
        staticmethod(lambda row, _snapshot, kind: f"{kind}-{row['source_row']}"),
    )
    monkeypatch.setattr(worker, "_existing_rows", lambda *_args: ({}, {}, {}))
    monkeypatch.setattr(multi_csv_worker, "compare_multi_csv_rows", lambda *_args: comparison)
    monkeypatch.setattr(worker, "_clear_previous_result", lambda _job_id: None)
    monkeypatch.setattr(worker, "_insert_stage_rows", lambda _job, rows: staged.extend(rows))
    monkeypatch.setattr(worker, "_insert_errors", lambda _job, errors: stored_errors.extend(errors))

    worker.process_job(
        {
            "id": 81,
            "mode": "DRY_RUN",
            "storage_path": "institution-1/source.csv",
            "content_sha256": multi_csv_worker.sha256(b"csv").hexdigest(),
            "institution_id": 1,
            "profile_snapshot": snapshot,
        }
    )

    assert len(staged) == 2
    assert stored_errors == []
    final = worker.updates[-1]
    assert final[0] == 81
    assert final[1]["status"] == "DRY_RUN_COMPLETED"
    assert final[1]["inserted_rows"] == 1
    assert final[1]["unchanged_rows"] == 1
    assert final[1]["dry_run_summary"] == {
        "people_new": 1,
        "people_updated": 0,
        "debtors_new": 1,
        "debtors_updated": 0,
        "preview_rows": comparison.preview_rows,
        "mapping": snapshot["mapping"],
        "delimiter": ",",
        "encoding": "UTF-8",
    }


def test_worker_marks_dry_run_as_failed_when_the_private_file_hash_changes() -> None:
    class HashFailureWorker(RecordingWorker):
        def _download(self, _storage_path: str) -> bytes:
            return b"unexpected"

    worker = HashFailureWorker()
    with pytest.raises(RuntimeError, match="hash del archivo privado"):
        worker.process_job(
            {
                "id": 82,
                "mode": "DRY_RUN",
                "storage_path": "private.csv",
                "content_sha256": multi_csv_worker.sha256(b"expected").hexdigest(),
            }
        )

    assert worker.updates[-1][1]["status"] == "FAILED"
    assert worker.updates[-1][1]["error_message"] == "El hash del archivo privado no coincide con el trabajo registrado."


def test_profile_recalculation_failure_keeps_the_job_recoverable() -> None:
    class RecoveryWorker(ApplyWorker):
        def _run_rpc(self, name: str, arguments: dict[str, object]):
            super()._run_rpc(name, arguments)
            raise RuntimeError("perfil temporalmente no disponible")

    worker = RecoveryWorker()
    worker._recalculate_profiles_only({"id": 72})

    assert worker.calls == ["recalculate_multiinstitution_import_profiles"]
    assert worker.updates == [
        (
            72,
            {
                "status": "RECALCULATING_PROFILES",
                "profile_recalculation_error": "perfil temporalmente no disponible",
                "lock_expires_at": None,
            },
        )
    ]


def test_worker_marks_unknown_import_modes_as_failed() -> None:
    worker = RecordingWorker()

    worker.process_job({"id": 83, "mode": "UNKNOWN"})

    assert worker.updates[0][0] == 83
    assert worker.updates[0][1]["status"] == "FAILED"
    assert worker.updates[0][1]["error_message"] == "El modo de importacion no es valido."


class PagingQuery:
    def __init__(self, pages: list[list[dict[str, object]]]) -> None:
        self.pages = pages
        self.ranges: list[tuple[int, int]] = []

    def select(self, _columns: str) -> PagingQuery:
        return self

    def eq(self, _column: str, _value: object) -> PagingQuery:
        return self

    def range(self, start: int, end: int) -> PagingQuery:
        self.ranges.append((start, end))
        return self

    def execute(self):
        return SimpleNamespace(data=self.pages.pop(0))


class PagingClient:
    def __init__(self, pages: list[list[dict[str, object]]]) -> None:
        self.query = PagingQuery(pages)

    def table(self, _name: str) -> PagingQuery:
        return self.query


def test_fetch_all_reads_all_pages_without_dropping_rows() -> None:
    client = PagingClient([[{"id": 1}] * 500, [{"id": 2}]])
    worker = MultiInstitutionCsvWorker(client=client)

    rows = worker._fetch_all("debt", 4, "id")

    assert len(rows) == 501
    assert client.query.ranges == [(0, 499), (500, 999)]


def test_response_rows_accepts_list_single_object_and_empty_response() -> None:
    assert multi_csv_worker._response_rows(SimpleNamespace(data=[{"id": 1}])) == [{"id": 1}]
    assert multi_csv_worker._response_rows(SimpleNamespace(data={"id": 2})) == [{"id": 2}]
    assert multi_csv_worker._response_rows(SimpleNamespace(data=None)) == []


def test_apply_runs_merge_once_then_recalculates_profiles() -> None:
    worker = ApplyWorker()

    worker.process_job({"id": 95, "mode": "APPLY"})

    assert worker.calls == [
        "apply_multiinstitution_import_stage",
        "recalculate_multiinstitution_import_profiles",
    ]
    assert [payload["status"] for _job_id, payload in worker.updates] == [
        "MERGING",
        "RECALCULATING_PROFILES",
    ]


class MutationQuery:
    def __init__(self, operations: list[tuple[str, object]]) -> None:
        self.operations = operations

    def update(self, payload: dict[str, object]) -> MutationQuery:
        self.operations.append(("update", payload))
        return self

    def insert(self, payload: list[dict[str, object]]) -> MutationQuery:
        self.operations.append(("insert", payload))
        return self

    def delete(self) -> MutationQuery:
        self.operations.append(("delete", None))
        return self

    def eq(self, column: str, value: object) -> MutationQuery:
        self.operations.append(("eq", (column, value)))
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(data=[])


class MutationClient:
    def __init__(self) -> None:
        self.operations: dict[str, list[tuple[str, object]]] = {}

    def table(self, name: str) -> MutationQuery:
        return MutationQuery(self.operations.setdefault(name, []))


def test_worker_persists_stage_errors_and_terminal_lock_consistently() -> None:
    client = MutationClient()
    worker = MultiInstitutionCsvWorker(client=client)
    job = {"id": 96, "institution_id": 7}

    worker._insert_stage_rows(
        job,
        [{
            "source_row": 2,
            "raw_values": {"Cuenta": "ALU-1"},
            "normalized_values": {"debtor_external_reference": "ALU-1"},
            "provided_fields": ["debtor_external_reference"],
            "debtor_identity_hash": "debtor", "debt_identity_hash": "debt",
        }],
    )
    worker._insert_errors(job, [MultiImportRowError(3, "INVALID_DATE", "Fecha invalida", "ALU-1")])
    worker._update_job(96, {"status": "DRY_RUN_COMPLETED"})

    staged = client.operations["import_stage_row"][0][1]
    errors = client.operations["import_row_error"][0][1]
    updates = [payload for action, payload in client.operations["import_job"] if action == "update"]
    assert staged[0]["institution_id"] == 7
    assert errors[0]["code"] == "INVALID_DATE"
    assert updates[-1]["lock_expires_at"] is None


def test_run_once_claims_and_processes_only_when_a_job_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    worker = RecordingWorker()
    processed: list[dict[str, object]] = []
    monkeypatch.setattr(worker, "_claim_next_job", lambda: {"id": 97})
    monkeypatch.setattr(worker, "process_job", lambda job: processed.append(job))

    assert worker.run_once() is True
    assert processed == [{"id": 97}]
    monkeypatch.setattr(worker, "_claim_next_job", lambda: None)
    assert worker.run_once() is False
