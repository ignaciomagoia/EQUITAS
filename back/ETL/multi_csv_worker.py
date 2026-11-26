"""Worker seguro de importaciones CSV para EQUITAS Multiinstitucion.

Las simulaciones no modifican el dominio. ``APPLY`` solo se procesa cuando la
variable de worker es exactamente ``true`` y la base ya autorizo el trabajo.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from socket import gethostname
from time import sleep
from typing import Any
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
from postgrest.exceptions import APIError
from supabase import Client, create_client

from ETL.multi_csv_import import (
    MultiImportRowError,
    canonical_identity_hash,
    compare_multi_csv_rows,
    iter_chunks,
    parse_multi_csv_bytes,
)

IMPORT_BUCKET = "equitas-multi-imports"
MULTIINSTITUTION_PROJECT_REF = "iylwghgvtydpmwidojdo"
MULTI_PLATFORM_KEY = "EQUITAS_MULTIINSTITUTION"
LOCK_DURATION = timedelta(minutes=30)
TERMINAL_STATUSES = {"DRY_RUN_COMPLETED", "COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELLED"}
TRANSIENT_ERRORS = (
    httpx.RemoteProtocolError,
    httpx.ReadTimeout,
    httpx.ConnectTimeout,
    httpx.ConnectError,
)


def normalize_supabase_url(value: str) -> str:
    clean_url = value.strip().rstrip("/")
    return clean_url.removesuffix("/rest/v1")


def project_ref_from_url(value: str) -> str | None:
    hostname = urlparse(value).hostname
    if not hostname:
        return None
    return hostname.split(".", maxsplit=1)[0]


def create_multi_client() -> Client:
    back_dir = Path(__file__).resolve().parents[1]
    load_dotenv(os.getenv("EQUITAS_MULTI_ENV_FILE", back_dir / ".env"))
    url = normalize_supabase_url(os.getenv("MULTI_SUPABASE_URL", ""))
    service_role_key = os.getenv("MULTI_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    project_ref = os.getenv("MULTI_SUPABASE_PROJECT_REF", "").strip()
    if not url or not service_role_key or not project_ref:
        raise RuntimeError(
            "Faltan MULTI_SUPABASE_URL, MULTI_SUPABASE_PROJECT_REF o MULTI_SUPABASE_SERVICE_ROLE_KEY en back/.env."
        )
    if project_ref != MULTIINSTITUTION_PROJECT_REF:
        raise RuntimeError(
            "MULTI_SUPABASE_PROJECT_REF no corresponde al proyecto EQUITAS Multiinstitucion autorizado."
        )
    if project_ref_from_url(url) != project_ref:
        raise RuntimeError("MULTI_SUPABASE_URL no corresponde a MULTI_SUPABASE_PROJECT_REF.")
    return create_client(url, service_role_key)


def is_multi_apply_enabled(environment: dict[str, str] | None = None) -> bool:
    values = environment if environment is not None else os.environ
    return values.get("MULTI_IMPORT_APPLY_ENABLED") == "true"


def execute_operation(name: str, operation: Any) -> Any:
    for attempt, delay in enumerate((0, 1, 2, 4, 8), start=1):
        try:
            return operation()
        except TRANSIENT_ERRORS as error:
            if attempt == 5:
                raise
            print(f"[Multi retry] {name}: {error.__class__.__name__}; reintento en {delay or 1}s")
            sleep(delay or 1)
    raise RuntimeError(f"No se pudo ejecutar {name}.")


def _response_rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    return data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])


class MultiInstitutionCsvWorker:
    def __init__(self, client: Client | None = None, worker_id: str | None = None) -> None:
        self.client = client or create_multi_client()
        self.worker_id = worker_id or f"equitas-multi-csv-{gethostname()}"
        self.apply_enabled = is_multi_apply_enabled()
        if client is None:
            self._assert_multi_platform()

    def _assert_multi_platform(self) -> None:
        response = execute_operation(
            "verify multiinstitution platform",
            lambda: self.client.table("platform_installation")
            .select("singleton,platform_key,schema_version")
            .eq("singleton", True)
            .maybe_single()
            .execute(),
        )
        data = getattr(response, "data", None)
        if (
            not isinstance(data, dict)
            or data.get("singleton") is not True
            or data.get("platform_key") != MULTI_PLATFORM_KEY
            or not isinstance(data.get("schema_version"), int)
            or data["schema_version"] < 1
        ):
            raise RuntimeError("El worker Multi no apunta a una plataforma EQUITAS_MULTIINSTITUTION valida.")

    def _claim_next_job(self) -> dict[str, Any] | None:
        response = execute_operation(
            "claim multiinstitution import job",
            lambda: self.client.rpc(
                "claim_multiinstitution_import_job", {"p_worker_id": self.worker_id}
            ).execute(),
        )
        rows = _response_rows(response)
        return rows[0] if rows else None

    def _update_job(self, job_id: int, payload: dict[str, Any]) -> None:
        payload = dict(payload)
        payload["updated_at"] = datetime.now(UTC).isoformat()
        if "lock_expires_at" not in payload:
            payload["lock_expires_at"] = (
                None
                if payload.get("status") in TERMINAL_STATUSES
                else (datetime.now(UTC) + LOCK_DURATION).isoformat()
            )
        execute_operation(
            f"update multi import job {job_id}",
            lambda: self.client.table("import_job").update(payload).eq("id", job_id).execute(),
        )

    def _clear_previous_result(self, job_id: int) -> None:
        for table in ("import_stage_row", "import_row_error"):
            execute_operation(
                f"clear {table} for {job_id}",
                lambda table=table: self.client.table(table).delete().eq("job_id", job_id).execute(),
            )

    def _run_rpc(self, name: str, arguments: dict[str, Any]) -> Any:
        return execute_operation(name, lambda: self.client.rpc(name, arguments).execute())

    def _download(self, storage_path: str) -> bytes:
        return execute_operation(
            f"download multi import {storage_path}",
            lambda: self.client.storage.from_(IMPORT_BUCKET).download(storage_path),
        )

    def _fetch_all(self, table: str, institution_id: int, columns: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page_size = 500
        start = 0
        while True:
            response = execute_operation(
                f"read {table} page {start}",
                lambda start=start: self.client.table(table)
                .select(columns)
                .eq("institution_id", institution_id)
                .range(start, start + page_size - 1)
                .execute(),
            )
            page = _response_rows(response)
            rows.extend(page)
            if len(page) < page_size:
                return rows
            start += page_size

    def _insert_stage_rows(self, job: dict[str, Any], rows: Iterable[dict[str, Any]]) -> None:
        job_id = int(job["id"])
        institution_id = int(job["institution_id"])
        processed = 0
        for batch in iter_chunks(rows):
            payload = [
                {
                    "job_id": job_id,
                    "institution_id": institution_id,
                    "source_row": row["source_row"],
                    "raw_values": row["raw_values"],
                    "normalized_values": row["normalized_values"],
                    "provided_fields": row["provided_fields"],
                    "debtor_identity_hash": row["debtor_identity_hash"],
                    "debt_identity_hash": row["debt_identity_hash"],
                    "person_identity_hash": row.get("person_identity_hash"),
                    "validation_status": row.get("validation_status", "VALID"),
                }
                for row in batch
            ]
            execute_operation(
                f"stage {len(payload)} multi CSV rows",
                lambda payload=payload: self.client.table("import_stage_row").insert(payload).execute(),
            )
            processed += len(payload)
            self._update_job(job_id, {"status": "STAGING", "processed_rows": processed})

    def _insert_errors(
        self, job: dict[str, Any], errors: Iterable[MultiImportRowError]
    ) -> None:
        job_id = int(job["id"])
        institution_id = int(job["institution_id"])
        payloads = [
            {
                "job_id": job_id,
                "institution_id": institution_id,
                "source_row": error.source_row,
                "code": error.code,
                "message": error.message,
                "source_key": error.source_key,
            }
            for error in errors
        ]
        for batch in iter_chunks(payloads):
            execute_operation(
                f"store {len(batch)} multi CSV errors",
                lambda batch=batch: self.client.table("import_row_error").insert(batch).execute(),
            )

    def _profile_snapshot(self, job: dict[str, Any]) -> dict[str, Any]:
        snapshot = job.get("profile_snapshot")
        if not isinstance(snapshot, dict):
            raise TypeError("El trabajo no contiene un perfil de importacion valido.")
        mapping = snapshot.get("mapping")
        identity_fields = snapshot.get("identity_fields")
        identity_value_fields = snapshot.get("identity_value_fields")
        identity_scheme_ids = snapshot.get("identity_scheme_ids")
        if (
            not isinstance(mapping, dict)
            or not isinstance(identity_fields, dict)
            or not isinstance(identity_value_fields, dict)
            or not isinstance(identity_scheme_ids, dict)
            or not all(
                isinstance(identity_scheme_ids.get(kind), int)
                for kind in ("debtor", "debt")
            )
            or identity_value_fields.get("debtor") != "debtor_external_reference"
            or identity_value_fields.get("debt") != "debt_external_reference"
            or identity_value_fields.get("person") not in {
                None,
                "person_external_reference",
                "person_document_number",
            }
        ):
            raise ValueError("El perfil de importacion no contiene mapeo o identidades validas.")
        return snapshot

    @staticmethod
    def _row_identity_hash(row: dict[str, Any], snapshot: dict[str, Any], kind: str) -> str | None:
        value_key = snapshot["identity_value_fields"].get(kind.lower())
        if not isinstance(value_key, str):
            return None
        value = row["normalized_values"].get(value_key)
        fields = snapshot["identity_fields"].get(kind.lower())
        if not value or not isinstance(fields, list) or not fields:
            return None
        return canonical_identity_hash({str(field): str(value) for field in fields})

    def _existing_rows(
        self, institution_id: int, snapshot: dict[str, Any]
    ) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]], dict[str, dict[str, Any]]]:
        scheme_ids = snapshot["identity_scheme_ids"]
        debtor_scheme_id = int(scheme_ids["debtor"])
        debt_scheme_id = int(scheme_ids["debt"])
        person_scheme_id = scheme_ids.get("person")
        debtors = [
            row
            for row in self._fetch_all("debtor", institution_id, "id,identity_hash,identity_scheme_id,description")
            if int(row["identity_scheme_id"]) == debtor_scheme_id
        ]
        debts = self._fetch_all(
            "debt",
            institution_id,
            "debtor_id,identity_hash,identity_scheme_id,type,description,original_amount,current_amount,issue_date,due_date,status_id,period",
        )
        statuses = {
            int(row["id"]): str(row["code"])
            for row in self._fetch_all("institution_debt_status", institution_id, "id,code")
        }
        for debt in debts:
            status_id = debt.get("status_id")
            if status_id is not None:
                debt["status"] = statuses.get(int(status_id))
        people = self._fetch_all("person", institution_id, "identity_hash,identity_scheme_id,full_name")
        debtor_hash_by_id = {int(row["id"]): str(row["identity_hash"]) for row in debtors}
        debts_by_identity = {
            (debtor_hash_by_id[int(row["debtor_id"])], str(row["identity_hash"])): row
            for row in debts
            if int(row["debtor_id"]) in debtor_hash_by_id
            and int(row["identity_scheme_id"]) == debt_scheme_id
        }
        return (
            {str(row["identity_hash"]): row for row in debtors},
            debts_by_identity,
            {
                str(row["identity_hash"]): row
                for row in people
                if person_scheme_id is not None and int(row["identity_scheme_id"]) == int(person_scheme_id)
            },
        )

    def _process_apply_job(self, job: dict[str, Any]) -> None:
        job_id = int(job["id"])
        if not self.apply_enabled:
            self._update_job(
                job_id,
                {
                    "status": "FAILED",
                    "error_message": "La aplicacion real Multi esta bloqueada en el worker. MULTI_IMPORT_APPLY_ENABLED debe ser exactamente true.",
                    "completed_at": datetime.now(UTC).isoformat(),
                },
            )
            return

        if job.get("merge_completed_at"):
            self._recalculate_profiles_only(job)
            return

        self._update_job(job_id, {"status": "MERGING"})
        self._run_rpc("apply_multiinstitution_import_stage", {"p_job_id": job_id})
        self._update_job(job_id, {"status": "RECALCULATING_PROFILES"})
        self._recalculate_profiles_only(job)

    def _recalculate_profiles_only(self, job: dict[str, Any]) -> None:
        job_id = int(job["id"])
        try:
            self._run_rpc("recalculate_multiinstitution_import_profiles", {"p_job_id": job_id})
        except (APIError, RuntimeError, TypeError, ValueError) as error:
            # El merge ya quedo confirmado. Se conserva RECALCULATING_PROFILES
            # para que el proximo worker repita solo este paso.
            self._update_job(
                job_id,
                {
                    "status": "RECALCULATING_PROFILES",
                    "profile_recalculation_error": str(error),
                    "lock_expires_at": None,
                },
            )

    def process_job(self, job: dict[str, Any]) -> None:
        job_id = int(job["id"])
        if job.get("mode") == "APPLY":
            self._process_apply_job(job)
            return
        if job.get("mode") != "DRY_RUN":
            self._update_job(job_id, {"status": "FAILED", "error_message": "El modo de importacion no es valido.", "completed_at": datetime.now(UTC).isoformat()})
            return

        try:
            content = self._download(str(job["storage_path"]))
            if sha256(content).hexdigest() != job["content_sha256"]:
                raise RuntimeError("El hash del archivo privado no coincide con el trabajo registrado.")

            snapshot = self._profile_snapshot(job)
            parsed = parse_multi_csv_bytes(content, snapshot["mapping"])
            self._update_job(
                job_id,
                {
                    "status": "STAGING",
                    "total_rows": parsed.total_rows,
                    "processed_rows": 0,
                    "ignored_columns": parsed.structure.ignored_columns,
                },
            )
            self._clear_previous_result(job_id)

            for row in parsed.rows:
                row["debtor_identity_hash"] = self._row_identity_hash(row, snapshot, "DEBTOR")
                row["debt_identity_hash"] = self._row_identity_hash(row, snapshot, "DEBT")
                row["person_identity_hash"] = self._row_identity_hash(row, snapshot, "PERSON")
                if not row["debtor_identity_hash"] or not row["debt_identity_hash"]:
                    raise RuntimeError("El perfil no puede construir identidades estables para el CSV.")

            debtors, debts, people = self._existing_rows(int(job["institution_id"]), snapshot)
            comparison = compare_multi_csv_rows(parsed, debtors, debts, people)
            comparison_by_row = {item["source_row"]: item for item in comparison.preview_rows}
            for row in parsed.rows:
                preview = comparison_by_row.get(row["source_row"])
                if preview:
                    row["normalized_values"] = {
                        **row["normalized_values"],
                        "_dry_run": preview,
                    }
                    row["validation_status"] = (
                        "REJECTED" if preview["comparison"] == "REJECTED" else "VALID"
                    )

            self._insert_stage_rows(job, parsed.rows)
            self._insert_errors(job, parsed.errors)
            summary = {
                "people_new": comparison.people_new,
                "people_updated": comparison.people_updated,
                "debtors_new": comparison.debtor_new,
                "debtors_updated": comparison.debtor_updated,
                "preview_rows": comparison.preview_rows,
                "mapping": snapshot["mapping"],
                "delimiter": parsed.structure.delimiter,
                "encoding": parsed.structure.encoding,
            }
            self._update_job(
                job_id,
                {
                    "status": "DRY_RUN_COMPLETED",
                    "processed_rows": parsed.total_rows,
                    "inserted_rows": comparison.inserted,
                    "updated_rows": comparison.updated,
                    "unchanged_rows": comparison.unchanged,
                    "rejected_rows": comparison.rejected,
                    "dry_run_summary": summary,
                    "completed_at": datetime.now(UTC).isoformat(),
                },
            )
        except (APIError, RuntimeError, TypeError, ValueError) as error:
            self._update_job(
                job_id,
                {
                    "status": "FAILED",
                    "error_message": str(error),
                    "completed_at": datetime.now(UTC).isoformat(),
                },
            )
            raise

    def run_once(self) -> bool:
        job = self._claim_next_job()
        if not job:
            return False
        self.process_job(job)
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Procesa un trabajo CSV de EQUITAS Multiinstitucion.")
    parser.add_argument("--once", action="store_true", help="Procesa como maximo un trabajo encolado.")
    parser.add_argument("--interval", type=int, default=30, help="Segundos entre consultas del worker persistente.")
    arguments = parser.parse_args()
    worker = MultiInstitutionCsvWorker()
    if arguments.once:
        worker.run_once()
        return
    while True:
        worker.run_once()
        sleep(max(arguments.interval, 5))


if __name__ == "__main__":
    main()
