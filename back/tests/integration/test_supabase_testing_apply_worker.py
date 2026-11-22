"""Prueba de apply real, exclusiva para el proyecto EQUITAS-TP-TESTING.

No se recolecta contra produccion: requiere habilitacion explicita, una URL cuyo
project ref coincida con el esperado y las RPC de fixture que solo existen en
el proyecto de testing.
"""

from __future__ import annotations

import importlib
import os
from contextlib import suppress
from decimal import Decimal
from hashlib import sha256
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from storage3.exceptions import StorageApiError
from supabase import create_client


def _require_testing_environment(monkeypatch: pytest.MonkeyPatch):
    if os.getenv("EQUITAS_RUN_TESTING_APPLY_TESTS") != "true":
        pytest.skip(
            "Prueba de apply de EQUITAS-TP-TESTING deshabilitada. "
            "Use EQUITAS_RUN_TESTING_APPLY_TESTS=true."
        )

    url = os.getenv("EQUITAS_TESTING_SUPABASE_URL", "").strip().rstrip("/")
    service_role_key = os.getenv("EQUITAS_TESTING_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    expected_project_ref = os.getenv("EQUITAS_TESTING_SUPABASE_PROJECT_REF", "").strip()
    host = urlparse(url).hostname or ""

    if not url or not service_role_key or not expected_project_ref:
        pytest.fail("Faltan las credenciales o el project ref exclusivos de EQUITAS-TP-TESTING.")

    if host.lower() != f"{expected_project_ref.lower()}.supabase.co":
        pytest.fail("La URL no coincide exactamente con el project ref de testing esperado.")

    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", service_role_key)
    monkeypatch.setenv("LAFALDA_IMPORT_TENANT_ID", "1")
    monkeypatch.setenv("LAFALDA_IMPORT_APPLY_ENABLED", "true")

    return create_client(url, service_role_key)


def _fixture_int(fixture: dict[str, Any], key: str) -> int:
    value = fixture.get(key)
    if value is None:
        raise KeyError(f"El fixture remoto no devolvio {key}.")
    return int(value)


def _csv_content(fixture: dict[str, Any]) -> bytes:
    debtor_type_id = _fixture_int(fixture, "debtor_type_id")
    account = _fixture_int(fixture, "fixture_account")
    currency_id = _fixture_int(fixture, "currency_id")
    debt_status_id = _fixture_int(fixture, "debt_status_id")
    debt_one_id = _fixture_int(fixture, "debt_one_external_id")
    debt_two_id = _fixture_int(fixture, "debt_two_external_id")
    new_debt_id = _fixture_int(fixture, "debt_new_external_id")

    rows = [
        "Bien_Tipo_Id,Cuenta,DEUD_id,tipo_deuda,descripcion,NOTD_capital,NOTD_totalActualizado,NOTD_vencimiento,fecha_emision,fecha_ultima_gestion,periodo,estado,moneda",
        f"{debtor_type_id},{account},{debt_one_id},inmueble,Deuda actualizada,80,125,2025-02-01,2025-01-01,2025-02-15,2025-01,{debt_status_id},{currency_id}",
        f"{debtor_type_id},{account},{debt_two_id},inmueble,Solo descripcion actualizada,,,,,,,,",
        f"{debtor_type_id},{account},{new_debt_id},inmueble,Deuda nueva sintetica,50,75,2025-05-01,2025-04-01,2025-04-15,2025-04,{debt_status_id},{currency_id}",
    ]
    return "\n".join(rows).encode()


def _single(response: Any) -> dict[str, Any]:
    if not isinstance(response.data, dict):
        raise TypeError("La respuesta de testing no contiene una fila unica.")
    return response.data


def _queue_job(client: Any, content: bytes, storage_path: str, requested_by: int) -> int:
    upload = client.storage.from_("lafalda-imports").upload(
        storage_path,
        content,
        file_options={"content-type": "text/csv", "upsert": "false"},
    )
    assert upload.path == storage_path

    response = (
        client.table("data_import_job")
        .insert(
            {
                "tenant": 1,
                "requested_by": requested_by,
                "file_name": "apply_sintetico.csv",
                "storage_path": storage_path,
                "content_sha256": sha256(content).hexdigest(),
                "file_size_bytes": len(content),
                "mode": "apply",
                "status": "QUEUED",
            }
        )
        .select("id")
        .single()
        .execute()
    )
    return int(_single(response)["id"])


@pytest.mark.testing_supabase
def test_testing_worker_applies_changes_idempotently_and_recalculates_profiles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Valida un ciclo completo contra datos estrictamente sinteticos."""

    client = _require_testing_environment(monkeypatch)
    first_storage_path = f"integration-testing/{uuid4()}.csv"
    second_storage_path = f"integration-testing/{uuid4()}.csv"
    storage_paths = [first_storage_path, second_storage_path]
    prepared = False

    try:
        fixture = _single(client.rpc("testing_prepare_lafalda_apply_fixture").execute())
        prepared = True
        worker_module = importlib.import_module("ETL.daily_csv_worker")
        monkeypatch.setattr(worker_module, "supabase", client)
        worker = worker_module.LafaldaDailyCsvWorker(
            worker_id="pytest-equitas-tp-testing",
            tenant_id=1,
        )
        content = _csv_content(fixture)
        fixture_user_id = _fixture_int(fixture, "fixture_user_id")
        fixture_person_id = _fixture_int(fixture, "fixture_person_id")
        fixture_debtor_id = _fixture_int(fixture, "fixture_debtor_id")
        debt_one_id = _fixture_int(fixture, "debt_one_external_id")
        debt_two_id = _fixture_int(fixture, "debt_two_external_id")
        absent_debt_id = _fixture_int(fixture, "debt_absent_external_id")
        new_debt_id = _fixture_int(fixture, "debt_new_external_id")

        first_job_id = _queue_job(client, content, first_storage_path, fixture_user_id)
        recalculate_profiles = worker._recalculate_profiles
        monkeypatch.setattr(
            worker,
            "_recalculate_profiles",
            lambda *_args: (_ for _ in ()).throw(RuntimeError("fallo simulado de perfiles")),
        )

        assert worker.process_once() is True

        pending_profile_recalculation = _single(
            client.table("data_import_job")
            .select(
                "status,inserted_rows,updated_rows,unchanged_rows,rejected_rows,"
                "merge_completed_at,profiles_recalculated_at,profile_recalculation_error"
            )
            .eq("id", first_job_id)
            .single()
            .execute()
        )
        assert pending_profile_recalculation["status"] == "RECALCULATING_PROFILES"
        assert pending_profile_recalculation["inserted_rows"] == 1
        assert pending_profile_recalculation["updated_rows"] == 2
        assert pending_profile_recalculation["unchanged_rows"] == 0
        assert pending_profile_recalculation["rejected_rows"] == 0
        assert pending_profile_recalculation["merge_completed_at"] is not None
        assert pending_profile_recalculation["profiles_recalculated_at"] is None
        assert pending_profile_recalculation["profile_recalculation_error"] == "fallo simulado de perfiles"

        monkeypatch.setattr(worker, "_recalculate_profiles", recalculate_profiles)

        assert worker.process_once() is True

        first_job = _single(
            client.table("data_import_job")
            .select(
                "status,inserted_rows,updated_rows,unchanged_rows,rejected_rows,"
                "merge_completed_at,profiles_recalculated_at,profile_recalculation_error"
            )
            .eq("id", first_job_id)
            .single()
            .execute()
        )
        updated = _single(
            client.table("debt")
            .select("description,original_amount,current_amount")
            .eq("debtor", fixture_debtor_id)
            .eq("external_id", debt_one_id)
            .single()
            .execute()
        )
        partial = _single(
            client.table("debt")
            .select("description,original_amount,current_amount")
            .eq("debtor", fixture_debtor_id)
            .eq("external_id", debt_two_id)
            .single()
            .execute()
        )
        absent = _single(
            client.table("debt")
            .select("description,current_amount")
            .eq("debtor", fixture_debtor_id)
            .eq("external_id", absent_debt_id)
            .single()
            .execute()
        )
        profile = _single(
            client.table("debtor_profile")
            .select("total_debt_amount,debt_count,profile_generated_at")
            .eq("debtor", fixture_debtor_id)
            .single()
            .execute()
        )
        detail = _single(
            client.table("debtor_profile_detail")
            .select("risk_value,reason")
            .eq("debtor_profile", fixture_debtor_id)
            .eq("person", fixture_person_id)
            .single()
            .execute()
        )
        change_rows = (
            client.table("data_import_debt_change")
            .select("change_type")
            .eq("job", first_job_id)
            .execute()
            .data
        )
        audit_statuses = (
            client.table("data_import_audit_event")
            .select("status")
            .eq("job", first_job_id)
            .execute()
            .data
        )

        assert first_job["status"] == "COMPLETED"
        assert first_job["inserted_rows"] == 1
        assert first_job["updated_rows"] == 2
        assert first_job["unchanged_rows"] == 0
        assert first_job["rejected_rows"] == 0
        assert first_job["merge_completed_at"] is not None
        assert first_job["profiles_recalculated_at"] is not None
        assert first_job["profile_recalculation_error"] is None
        assert updated == {
            "description": "Deuda actualizada",
            "original_amount": 80,
            "current_amount": 125,
        }
        assert partial == {
            "description": "Solo descripcion actualizada",
            "original_amount": 200,
            "current_amount": 250,
        }
        assert absent == {"description": "Deuda ausente que se conserva", "current_amount": 500}
        assert Decimal(str(profile["total_debt_amount"])) == Decimal(950)
        assert profile["debt_count"] == 4
        assert profile["profile_generated_at"] is not None
        assert 0 <= Decimal(str(detail["risk_value"])) <= 100
        assert "Riesgo base del objeto" in str(detail["reason"])
        assert sorted(row["change_type"] for row in change_rows) == ["INSERTED", "UPDATED", "UPDATED"]
        assert "COMPLETED" in [row["status"] for row in audit_statuses]

        second_job_id = _queue_job(client, content, second_storage_path, fixture_user_id)

        assert worker.process_once() is True

        second_job = _single(
            client.table("data_import_job")
            .select("status,inserted_rows,updated_rows,unchanged_rows,rejected_rows")
            .eq("id", second_job_id)
            .single()
            .execute()
        )
        duplicate_count = (
            client.table("debt")
            .select("id", count="exact")
            .eq("debtor", fixture_debtor_id)
            .eq("external_id", new_debt_id)
            .execute()
            .count
        )

        assert second_job == {
            "status": "COMPLETED",
            "inserted_rows": 0,
            "updated_rows": 0,
            "unchanged_rows": 3,
            "rejected_rows": 0,
        }
        assert duplicate_count == 1
    finally:
        for storage_path in storage_paths:
            with suppress(StorageApiError):
                client.storage.from_("lafalda-imports").remove([storage_path])
        if prepared:
            client.rpc("testing_cleanup_lafalda_apply_fixture").execute()
