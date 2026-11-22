"""Prueba opt-in de apply real contra Supabase levantado localmente.

No se recolecta por defecto contra servicios externos: requiere una URL local,
una service role local y EQUITAS_RUN_LOCAL_APPLY_TESTS=true.
"""

from __future__ import annotations

import csv
import importlib
import os
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import StringIO
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from postgrest.exceptions import APIError
from supabase import create_client

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _require_local_apply_environment(monkeypatch: pytest.MonkeyPatch):
    if os.getenv("EQUITAS_RUN_LOCAL_APPLY_TESTS") != "true":
        pytest.skip("Prueba de apply local deshabilitada. Use EQUITAS_RUN_LOCAL_APPLY_TESTS=true.")

    url = os.getenv("EQUITAS_LOCAL_SUPABASE_URL", "").strip()
    service_role_key = os.getenv("EQUITAS_LOCAL_SUPABASE_SERVICE_ROLE_KEY", "").strip()
    host = urlparse(url).hostname

    if host not in LOCAL_HOSTS:
        pytest.fail("La prueba de apply solo permite Supabase local en localhost o 127.0.0.1.")

    if not service_role_key:
        pytest.fail("Falta EQUITAS_LOCAL_SUPABASE_SERVICE_ROLE_KEY para Supabase local.")

    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", service_role_key)
    return create_client(url, service_role_key)


def _csv_content() -> bytes:
    output = StringIO(newline="")
    writer = csv.DictWriter(
        output,
        fieldnames=[
            "Bien_Tipo_Id",
            "Cuenta",
            "DEUD_id",
            "tipo_deuda",
            "descripcion",
            "NOTD_capital",
            "NOTD_totalActualizado",
            "NOTD_vencimiento",
            "fecha_emision",
            "fecha_ultima_gestion",
            "periodo",
            "estado",
            "moneda",
        ],
    )
    writer.writeheader()
    writer.writerows(
        [
            {
                "Bien_Tipo_Id": 1,
                "Cuenta": 700001,
                "DEUD_id": 900001,
                "tipo_deuda": "inmuebles",
                "descripcion": "Deuda actualizada por prueba",
                "NOTD_capital": 80,
                "NOTD_totalActualizado": 125,
                "NOTD_vencimiento": "2025-02-01",
                "fecha_emision": "2025-01-01",
                "fecha_ultima_gestion": "2025-02-15",
                "periodo": "2025-01",
                "estado": 2,
                "moneda": 1,
            },
            {
                "Bien_Tipo_Id": 1,
                "Cuenta": 700001,
                "DEUD_id": 900002,
                "descripcion": "Solo se actualiza la descripcion",
            },
            {
                "Bien_Tipo_Id": 1,
                "Cuenta": 700001,
                "DEUD_id": 900004,
                "tipo_deuda": "inmuebles",
                "descripcion": "Deuda nueva sintetica",
                "NOTD_capital": 50,
                "NOTD_totalActualizado": 75,
                "NOTD_vencimiento": "2025-05-01",
                "fecha_emision": "2025-04-01",
                "fecha_ultima_gestion": "2025-04-15",
                "periodo": "2025-04",
                "estado": 2,
                "moneda": 1,
            },
        ]
    )
    return output.getvalue().encode("utf-8")


def _single(response: Any) -> dict[str, Any]:
    if not isinstance(response.data, dict):
        raise TypeError("La respuesta local no contiene una fila unica.")
    return response.data


@pytest.mark.local_supabase
def test_local_worker_applies_synthetic_insert_update_partial_and_keeps_absent_debt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Arrange
    client = _require_local_apply_environment(monkeypatch)
    worker_module = importlib.import_module("ETL.daily_csv_worker")
    monkeypatch.setattr(worker_module, "supabase", client)
    content = _csv_content()
    storage_path = f"integration/{uuid4()}.csv"
    job_id: int | None = None

    client.table("debt").delete().eq("debtor", 1001).eq("external_id", 900004).execute()
    client.table("debt").update(
        {"description": "Deuda base actualizable", "original_amount": 80, "current_amount": 100}
    ).eq("debtor", 1001).eq("external_id", 900001).execute()
    client.table("debt").update(
        {"description": "Deuda base parcial", "original_amount": 200, "current_amount": 250}
    ).eq("debtor", 1001).eq("external_id", 900002).execute()
    client.table("lafalda_import_control").update({"apply_enabled": False}).eq("tenant", 1).execute()

    try:
        upload = client.storage.from_("lafalda-imports").upload(
            storage_path,
            content,
            file_options={"content-type": "text/csv", "upsert": "false"},
        )
        assert upload.path == storage_path

        job_response = client.table("data_import_job").insert(
            {
                "tenant": 1,
                "requested_by": 1,
                "file_name": "apply_sintetico.csv",
                "storage_path": storage_path,
                "content_sha256": sha256(content).hexdigest(),
                "file_size_bytes": len(content),
                "mode": "apply",
                "status": "MERGING",
                "lock_expires_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
            }
        ).select("id").single().execute()
        job_id = int(_single(job_response)["id"])

        # Act / Assert: el freno de base de datos bloquea apply aun con service role local.
        with pytest.raises(APIError, match="bloqueada"):
            client.rpc("apply_lafalda_import_stage", {"p_job_id": job_id}).execute()

        client.table("data_import_job").update({"status": "QUEUED"}).eq("id", job_id).execute()
        client.table("lafalda_import_control").update({"apply_enabled": True}).eq("tenant", 1).execute()
        worker = worker_module.LafaldaDailyCsvWorker(worker_id="pytest-local-apply", tenant_id=1)

        # Act
        assert worker.process_once() is True

        # Assert
        completed_job = _single(
            client.table("data_import_job")
            .select("status,inserted_rows,updated_rows,unchanged_rows,rejected_rows")
            .eq("id", job_id)
            .single()
            .execute()
        )
        updated = _single(
            client.table("debt")
            .select("description,original_amount,current_amount")
            .eq("debtor", 1001)
            .eq("external_id", 900001)
            .single()
            .execute()
        )
        partial = _single(
            client.table("debt")
            .select("description,original_amount,current_amount")
            .eq("debtor", 1001)
            .eq("external_id", 900002)
            .single()
            .execute()
        )
        absent = _single(
            client.table("debt")
            .select("description,current_amount")
            .eq("debtor", 1001)
            .eq("external_id", 900003)
            .single()
            .execute()
        )
        created = _single(
            client.table("debt")
            .select("original_amount,current_amount")
            .eq("debtor", 1001)
            .eq("external_id", 900004)
            .single()
            .execute()
        )

        assert completed_job == {
            "status": "COMPLETED",
            "inserted_rows": 1,
            "updated_rows": 2,
            "unchanged_rows": 0,
            "rejected_rows": 0,
        }
        assert updated == {
            "description": "Deuda actualizada por prueba",
            "original_amount": 80,
            "current_amount": 125,
        }
        assert partial == {
            "description": "Solo se actualiza la descripcion",
            "original_amount": 200,
            "current_amount": 250,
        }
        assert absent == {"description": "Deuda que debe conservarse", "current_amount": 500}
        assert created == {"original_amount": 50, "current_amount": 75}
    finally:
        client.table("lafalda_import_control").update({"apply_enabled": False}).eq("tenant", 1).execute()
        client.table("debt").delete().eq("debtor", 1001).eq("external_id", 900004).execute()
        if job_id is not None:
            client.table("data_import_job").delete().eq("id", job_id).execute()
        client.storage.from_("lafalda-imports").remove([storage_path])
