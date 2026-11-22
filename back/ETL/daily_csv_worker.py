"""Worker persistente para la importaciÃ³n diaria de CSV de La Falda.

Se ejecuta fuera de Vercel y toma trabajos registrados en Supabase. El archivo
se conserva en Storage privado, por lo que refrescar la interfaz no interrumpe
el procesamiento.
"""

from __future__ import annotations

import argparse
import os
from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from socket import gethostname
from time import sleep
from typing import Any

import httpx
from postgrest.exceptions import APIError

from ETL.daily_csv_import import ImportRowError, parse_daily_csv_bytes
from ETL.load import (
    DEFAULT_BULK_BATCH_SIZE,
    chunk_list,
    execute_supabase_operation,
    supabase,
)
from ETL.transform import (
    build_debtor_profile_detail_payload,
    build_debtor_profile_payload,
    parse_decimal,
)

IMPORT_BUCKET = "lafalda-imports"
IMPORT_JOB_TABLE = "data_import_job"
IMPORT_STAGE_TABLE = "data_import_debt_stage"
IMPORT_ERROR_TABLE = "data_import_row_error"
LOCK_LEASE_DURATION = timedelta(minutes=30)
TERMINAL_JOB_STATUSES = {
    "DRY_RUN_COMPLETED",
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "FAILED",
    "CANCELLED",
}


def is_lafalda_import_apply_enabled(value: str | None = None) -> bool:
    """Habilita apply solo mediante el valor explicito ``true``."""

    configured_value = value if value is not None else os.getenv("LAFALDA_IMPORT_APPLY_ENABLED", "")
    return configured_value.strip().lower() == "true"


def _chunks(values: Iterable[int], size: int = DEFAULT_BULK_BATCH_SIZE) -> Iterable[list[int]]:
    current_chunk: list[int] = []

    for value in values:
        current_chunk.append(value)

        if len(current_chunk) >= size:
            yield current_chunk
            current_chunk = []

    if current_chunk:
        yield current_chunk


def _unwrap_rpc_data(data: Any) -> dict[str, Any]:
    if isinstance(data, dict):
        return data

    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]

    return {}


class LafaldaDailyCsvWorker:
    def __init__(
        self,
        worker_id: str | None = None,
        tenant_id: int | None = None,
        apply_enabled: bool | None = None,
    ) -> None:
        self.worker_id = worker_id or f"lafalda-csv-{gethostname()}"
        configured_tenant = tenant_id or int(os.getenv("LAFALDA_IMPORT_TENANT_ID", "0"))

        if configured_tenant <= 0:
            raise RuntimeError(
                "Falta configurar LAFALDA_IMPORT_TENANT_ID para ejecutar el worker."
            )

        self.tenant_id = configured_tenant
        self.apply_enabled = (
            is_lafalda_import_apply_enabled() if apply_enabled is None else apply_enabled
        )

    def _claim_next_job(self) -> dict[str, Any] | None:
        response = execute_supabase_operation(
            "claim La Falda CSV import job",
            lambda: supabase.rpc(
                "claim_lafalda_import_job_v2",
                {
                    "p_worker_id": self.worker_id,
                    "p_tenant_id": self.tenant_id,
                    "p_allow_apply": self.apply_enabled,
                },
            ).execute(),
        )

        if not response.data:
            return None

        if isinstance(response.data, list):
            return response.data[0] if response.data else None

        return response.data if isinstance(response.data, dict) else None

    def _update_job(self, job_id: int, payload: dict[str, Any]) -> None:
        now = datetime.now(UTC)
        payload["updated_at"] = now.isoformat()

        if "lock_expires_at" not in payload:
            payload["lock_expires_at"] = (
                None
                if payload.get("status") in TERMINAL_JOB_STATUSES
                else (now + LOCK_LEASE_DURATION).isoformat()
            )
        execute_supabase_operation(
            f"update import job {job_id}",
            lambda: supabase.table(IMPORT_JOB_TABLE).update(payload).eq("id", job_id).execute(),
        )

    def _clear_job_rows(self, job_id: int) -> None:
        for table_name in (IMPORT_STAGE_TABLE, IMPORT_ERROR_TABLE):
            execute_supabase_operation(
                f"clear {table_name} for import {job_id}",
                lambda table_name=table_name: (
                    supabase.table(table_name).delete().eq("job", job_id).execute()
                ),
            )

    def _insert_stage_rows(self, job_id: int, stage_rows: list[dict[str, Any]]) -> int:
        processed_rows = 0

        for batch in chunk_list(stage_rows, DEFAULT_BULK_BATCH_SIZE):
            payloads = [{"job": job_id, **row} for row in batch]
            execute_supabase_operation(
                f"stage {len(payloads)} CSV rows for import {job_id}",
                lambda payloads=payloads: supabase.table(IMPORT_STAGE_TABLE).insert(payloads).execute(),
            )

            processed_rows += len(payloads)
            self._update_job(job_id, {"processed_rows": processed_rows})

        return processed_rows

    def _insert_row_errors(self, job_id: int, errors: list[ImportRowError]) -> None:
        payloads = [
            {
                "job": job_id,
                "source_row": error.source_row,
                "code": error.code,
                "message": error.message,
                "source_key": error.source_key,
            }
            for error in errors
        ]

        for batch in chunk_list(payloads, DEFAULT_BULK_BATCH_SIZE):
            execute_supabase_operation(
                f"store {len(batch)} CSV errors for import {job_id}",
                lambda batch=batch: supabase.table(IMPORT_ERROR_TABLE).insert(batch).execute(),
            )

    def _download_file(self, storage_path: str) -> bytes:
        return execute_supabase_operation(
            f"download import file {storage_path}",
            lambda: supabase.storage.from_(IMPORT_BUCKET).download(storage_path),
        )

    def _run_rpc(self, function_name: str, job_id: int) -> dict[str, Any]:
        response = execute_supabase_operation(
            f"rpc {function_name} for import {job_id}",
            lambda: supabase.rpc(function_name, {"p_job_id": job_id}).execute(),
        )

        return _unwrap_rpc_data(response.data)

    def _fetch_rows_by_ids(
        self,
        table_name: str,
        columns: str,
        column_name: str,
        values: Iterable[int],
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []

        for identifier_chunk in _chunks(sorted(set(values)), 250):
            offset = 0

            while True:
                response = execute_supabase_operation(
                    f"select {table_name} for import profiles",
                    lambda identifier_chunk=identifier_chunk, offset=offset: (
                        supabase.table(table_name)
                        .select(columns)
                        .in_(column_name, identifier_chunk)
                        .range(offset, offset + 999)
                        .execute()
                    ),
                )

                batch = response.data if isinstance(response.data, list) else []
                rows.extend(row for row in batch if isinstance(row, dict))

                if len(batch) < 1000:
                    break

                offset += 1000

        return rows

    def _fetch_tenant_debtor_ids(self, tenant_id: int) -> list[int]:
        rows: list[dict[str, Any]] = []
        offset = 0

        while True:
            response = execute_supabase_operation(
                f"select tenant {tenant_id} debtors",
                lambda offset=offset: (
                    supabase.table("debtor")
                    .select("id")
                    .eq("tenant", tenant_id)
                    .range(offset, offset + 999)
                    .execute()
                ),
            )

            batch = response.data if isinstance(response.data, list) else []
            rows.extend(row for row in batch if isinstance(row, dict))

            if len(batch) < 1000:
                break

            offset += 1000

        return [int(row["id"]) for row in rows if row.get("id") is not None]

    def _fetch_affected_debtor_ids(self, job_id: int) -> list[int]:
        rows: list[dict[str, Any]] = []
        offset = 0

        while True:
            response = execute_supabase_operation(
                f"select affected debtors for import {job_id}",
                lambda offset=offset: (
                    supabase.table(IMPORT_STAGE_TABLE)
                    .select("debtor_id")
                    .eq("job", job_id)
                    .eq("is_valid", True)
                    .not_.is_("debtor_id", "null")
                    .range(offset, offset + 999)
                    .execute()
                ),
            )

            batch = response.data if isinstance(response.data, list) else []
            rows.extend(row for row in batch if isinstance(row, dict))

            if len(batch) < 1000:
                break

            offset += 1000

        return sorted({int(row["debtor_id"]) for row in rows if row.get("debtor_id") is not None})

    def _bulk_upsert(self, table_name: str, payloads: list[dict[str, Any]], on_conflict: str) -> None:
        for batch in chunk_list(payloads, DEFAULT_BULK_BATCH_SIZE):
            execute_supabase_operation(
                f"bulk upsert {table_name} ({len(batch)} rows)",
                lambda batch=batch: supabase.table(table_name)
                .upsert(batch, on_conflict=on_conflict)
                .execute(),
            )

    def _recalculate_profiles(self, job_id: int, tenant_id: int) -> None:
        affected_debtor_ids = self._fetch_affected_debtor_ids(job_id)

        if not affected_debtor_ids:
            return

        tenant_debtor_ids = self._fetch_tenant_debtor_ids(tenant_id)
        all_profiles = self._fetch_rows_by_ids(
            "debtor_profile",
            "id,debtor,total_debt_amount",
            "debtor",
            tenant_debtor_ids,
        )
        debt_rows = self._fetch_rows_by_ids(
            "debt",
            "debtor,current_amount,due_date,status",
            "debtor",
            affected_debtor_ids,
        )
        relation_rows = self._fetch_rows_by_ids(
            "debtor_person",
            "debtor,person,priority,role,active",
            "debtor",
            affected_debtor_ids,
        )

        debt_rows_by_debtor: dict[int, list[dict[str, Any]]] = defaultdict(list)
        relation_rows_by_debtor: dict[int, list[dict[str, Any]]] = defaultdict(list)
        affected_person_ids: set[int] = set()

        for row in debt_rows:
            if row.get("debtor") is not None:
                debt_rows_by_debtor[int(row["debtor"])].append(row)

        for row in relation_rows:
            if (
                row.get("debtor") is None
                or row.get("person") is None
                or row.get("active") is False
            ):
                continue

            debtor_id = int(row["debtor"])
            person_id = int(row["person"])
            relation_rows_by_debtor[debtor_id].append(row)
            affected_person_ids.add(person_id)

        contact_rows = self._fetch_rows_by_ids(
            "debtor_contact",
            "person,id,active",
            "person",
            affected_person_ids,
        )
        contacts_by_person: dict[int, int] = defaultdict(int)

        for row in contact_rows:
            if row.get("person") is not None and row.get("active") is not False:
                contacts_by_person[int(row["person"])] += 1

        total_by_debtor = {
            int(row["debtor"]): parse_decimal(row.get("total_debt_amount"))
            for row in all_profiles
            if row.get("debtor") is not None
        }
        profile_ids_by_debtor = {
            int(row["debtor"]): int(row["id"])
            for row in all_profiles
            if row.get("debtor") is not None and row.get("id") is not None
        }

        for debtor_id in affected_debtor_ids:
            total_by_debtor[debtor_id] = sum(
                parse_decimal(row.get("current_amount"))
                for row in debt_rows_by_debtor.get(debtor_id, [])
            )

        positive_totals = [value for value in total_by_debtor.values() if value > 0]
        average_total_debt_amount = (
            sum(positive_totals) / len(positive_totals) if positive_totals else 0.0
        )

        profile_payloads: list[dict[str, Any]] = []

        for debtor_id in affected_debtor_ids:
            relations = relation_rows_by_debtor.get(debtor_id, [])
            person_ids = {int(row["person"]) for row in relations if row.get("person") is not None}
            available_contact_count = sum(contacts_by_person[person_id] for person_id in person_ids)

            profile_payload = build_debtor_profile_payload(
                debtor_id=debtor_id,
                debt_rows=debt_rows_by_debtor.get(debtor_id, []),
                active_person_count=len(person_ids),
                available_contact_count=available_contact_count,
                average_total_debt_amount=average_total_debt_amount,
            )
            existing_profile_id = profile_ids_by_debtor.get(debtor_id)
            if existing_profile_id is not None:
                profile_payload["id"] = existing_profile_id
            profile_payloads.append(profile_payload)

        self._bulk_upsert("debtor_profile", profile_payloads, "debtor")
        refreshed_profiles = self._fetch_rows_by_ids(
            "debtor_profile",
            "id,debtor,socioeconomic_risk_level",
            "debtor",
            affected_debtor_ids,
        )
        profile_by_debtor = {
            int(row["debtor"]): row
            for row in refreshed_profiles
            if row.get("debtor") is not None and row.get("id") is not None
        }
        profile_detail_payloads: list[dict[str, Any]] = []
        existing_profile_detail_rows = self._fetch_rows_by_ids(
            "debtor_profile_detail",
            "id,debtor_profile,person",
            "debtor_profile",
            [int(profile["id"]) for profile in profile_by_debtor.values() if profile.get("id") is not None],
        )
        profile_detail_ids_by_key = {
            (int(row["debtor_profile"]), int(row["person"])): int(row["id"])
            for row in existing_profile_detail_rows
            if row.get("id") is not None
            and row.get("debtor_profile") is not None
            and row.get("person") is not None
        }

        for debtor_id, relations in relation_rows_by_debtor.items():
            profile = profile_by_debtor.get(debtor_id)

            if profile is None:
                continue

            for relation in relations:
                if relation.get("person") is None:
                    continue

                person_id = int(relation["person"])
                profile_id = int(profile["id"])
                profile_detail_payload = build_debtor_profile_detail_payload(
                    debtor_profile_id=profile_id,
                    person_id=person_id,
                    profile_risk_level=int(profile["socioeconomic_risk_level"]),
                    person_contact_count=contacts_by_person[person_id],
                    role=str(relation["role"]) if relation.get("role") else None,
                    priority=parse_decimal(relation.get("priority")),
                )
                existing_profile_detail_id = profile_detail_ids_by_key.get((profile_id, person_id))
                if existing_profile_detail_id is not None:
                    profile_detail_payload["id"] = existing_profile_detail_id
                profile_detail_payloads.append(profile_detail_payload)

        self._bulk_upsert(
            "debtor_profile_detail",
            profile_detail_payloads,
            "debtor_profile,person",
        )

    @staticmethod
    def _completion_status(summary: dict[str, Any]) -> str:
        return (
            "COMPLETED_WITH_ERRORS"
            if int(summary.get("rejected_rows", 0)) > 0
            else "COMPLETED"
        )

    @staticmethod
    def _summary_from_job(job: dict[str, Any]) -> dict[str, int]:
        return {
            "inserted_rows": int(job.get("inserted_rows", 0)),
            "updated_rows": int(job.get("updated_rows", 0)),
            "unchanged_rows": int(job.get("unchanged_rows", 0)),
            "rejected_rows": int(job.get("rejected_rows", 0)),
        }

    def _complete_profile_recalculation(self, job_id: int, summary: dict[str, Any]) -> None:
        self._update_job(
            job_id,
            {
                "status": self._completion_status(summary),
                "inserted_rows": int(summary.get("inserted_rows", 0)),
                "updated_rows": int(summary.get("updated_rows", 0)),
                "unchanged_rows": int(summary.get("unchanged_rows", 0)),
                "rejected_rows": int(summary.get("rejected_rows", 0)),
                "profiles_recalculated_at": datetime.now(UTC).isoformat(),
                "profile_recalculation_error": None,
                "error_message": None,
                "completed_at": datetime.now(UTC).isoformat(),
                "lock_expires_at": None,
            },
        )

    def _record_profile_recalculation_failure(self, job_id: int, error: Exception) -> None:
        message = str(error)
        self._update_job(
            job_id,
            {
                "status": "RECALCULATING_PROFILES",
                "profile_recalculation_error": message,
                "error_message": (
                    "Las deudas ya fueron aplicadas. El recálculo de perfiles quedó pendiente "
                    "y se reintentará sin volver a modificar deudas."
                ),
                "lock_expires_at": None,
            },
        )

    def _recalculate_profiles_only(self, job: dict[str, Any]) -> bool:
        job_id = int(job["id"])
        summary = self._summary_from_job(job)

        try:
            self._recalculate_profiles(job_id, int(job["tenant"]))
        except Exception as error:  # noqa: BLE001
            self._record_profile_recalculation_failure(job_id, error)
            print(
                f"El recálculo de perfiles del trabajo {job_id} quedó pendiente: {error}. "
                "Las deudas no se volverán a aplicar."
            )
            return True

        self._complete_profile_recalculation(job_id, summary)
        return True

    @staticmethod
    def _requires_profile_recalculation_only(job: dict[str, Any]) -> bool:
        return (
            job.get("mode") == "apply"
            and job.get("merge_completed_at") is not None
            and job.get("profiles_recalculated_at") is None
        )

    def process_once(self) -> bool:
        job = self._claim_next_job()

        if job is None:
            return False

        job_id = int(job["id"])

        if int(job["tenant"]) != self.tenant_id:
            raise RuntimeError("El worker recibio un trabajo de un tenant no autorizado.")

        if self._requires_profile_recalculation_only(job):
            if not self.apply_enabled:
                self._update_job(
                    job_id,
                    {
                        "status": "RECALCULATING_PROFILES",
                        "error_message": (
                            "El recálculo pendiente requiere que "
                            "LAFALDA_IMPORT_APPLY_ENABLED sea true."
                        ),
                        "lock_expires_at": None,
                    },
                )
                return True

            return self._recalculate_profiles_only(job)

        if job.get("mode") == "apply" and not self.apply_enabled:
            self._update_job(
                job_id,
                {
                    "status": "QUEUED",
                    "error_message": (
                        "La aplicación está deshabilitada en este worker por "
                        "LAFALDA_IMPORT_APPLY_ENABLED."
                    ),
                    "lock_expires_at": None,
                },
            )
            return True

        try:
            file_content = self._download_file(str(job["storage_path"]))
            content_hash = sha256(file_content).hexdigest()

            if content_hash != job["content_sha256"]:
                raise RuntimeError("El hash del archivo almacenado no coincide con el trabajo creado.")

            parsed = parse_daily_csv_bytes(file_content)
            self._update_job(
                job_id,
                {
                    "status": "STAGING",
                    "total_rows": parsed.total_rows,
                    "processed_rows": 0,
                    "ignored_columns": parsed.ignored_columns,
                },
            )
            self._clear_job_rows(job_id)
            staged_rows = self._insert_stage_rows(job_id, parsed.stage_rows)
            self._insert_row_errors(job_id, parsed.errors)
            self._update_job(
                job_id,
                {
                    "processed_rows": staged_rows + len(parsed.errors),
                    "rejected_rows": len(parsed.errors),
                },
            )
            preparation = self._run_rpc("prepare_lafalda_import_stage", job_id)
            summary = self._run_rpc("summarize_lafalda_import_stage", job_id)
            summary["rejected_rows"] = preparation.get(
                "rejected_rows",
                summary.get("rejected_rows", len(parsed.errors)),
            )

            if job["mode"] == "dry_run":
                self._update_job(
                    job_id,
                    {
                        "status": "DRY_RUN_COMPLETED",
                        "inserted_rows": int(summary.get("inserted_rows", 0)),
                        "updated_rows": int(summary.get("updated_rows", 0)),
                        "unchanged_rows": int(summary.get("unchanged_rows", 0)),
                        "rejected_rows": int(summary.get("rejected_rows", 0)),
                        "completed_at": datetime.now(UTC).isoformat(),
                    },
                )
                return True

            if job["mode"] != "apply":
                raise RuntimeError("El trabajo no tiene un modo de importacion valido.")

            self._update_job(job_id, {"status": "MERGING"})
            applied_summary = self._run_rpc("apply_lafalda_import_stage", job_id)
            self._update_job(
                job_id,
                {
                    "status": "RECALCULATING_PROFILES",
                    "profile_recalculation_attempt_count": int(
                        job.get("profile_recalculation_attempt_count", 0)
                    )
                    + 1,
                    "profile_recalculation_error": None,
                },
            )
            return self._recalculate_profiles_only(
                {
                    **job,
                    **applied_summary,
                    "merge_completed_at": datetime.now(UTC).isoformat(),
                }
            )
        except Exception as error:
            try:
                self._update_job(
                    job_id,
                    {
                        "status": "FAILED",
                        "error_message": str(error),
                        "completed_at": datetime.now(UTC).isoformat(),
                        "lock_expires_at": None,
                    },
                )
            except (APIError, httpx.HTTPError, RuntimeError) as status_error:
                raise RuntimeError(
                    f"El trabajo {job_id} fallo: {error}. "
                    f"Tambien fallo el registro del estado FAILED: {status_error}"
                ) from error
            raise


def main() -> None:
    parser = argparse.ArgumentParser(description="Worker de importaciÃ³n CSV diaria de La Falda.")
    parser.add_argument("--once", action="store_true", help="Procesa como mÃ¡ximo un trabajo y finaliza.")
    parser.add_argument(
        "--poll-seconds",
        type=int,
        default=5,
        help="Segundos de espera sin trabajos pendientes. Por defecto: 5.",
    )
    args = parser.parse_args()

    if args.poll_seconds <= 0:
        raise ValueError("--poll-seconds debe ser mayor a cero.")

    worker = LafaldaDailyCsvWorker()

    while True:
        processed = worker.process_once()

        if args.once:
            return

        if not processed:
            sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
