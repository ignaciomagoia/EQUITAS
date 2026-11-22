"""Exporta una muestra real de deudas de La Falda para probar el dry-run.

El módulo solo ejecuta consultas ``select`` contra Supabase. No usa el worker,
Storage ni ninguna operación de inserción, actualización o eliminación.
"""

from __future__ import annotations

import argparse
import csv
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ETL.daily_csv_import import parse_daily_csv
from ETL.load import execute_supabase_operation, supabase

LAFALDA_TENANT_ID = 1
DEFAULT_SAMPLE_SIZE = 10_000
DEFAULT_OUTPUT_PATH = Path(__file__).parent / "test_data" / "lafalda_10000_prueba.csv"
DEFAULT_COMPLETE_OUTPUT_PATH = Path(__file__).parent / "test_data" / "lafalda_completo_prueba.csv"
CSV_COLUMNS = (
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
)
DEBT_SELECT_COLUMNS = (
    "id,external_id,debtor,type,description,original_amount,current_amount,"
    "currency,issue_date,due_date,last_collection_date,period,status"
)
DEBTOR_SELECT_COLUMNS = "id,type,external_id"


@dataclass(frozen=True)
class CsvExportResult:
    output_path: Path
    exported_rows: int
    database_debt_count: int | None
    source_debt_rows_read: int
    duplicate_keys_skipped: int
    invalid_rows_skipped: int
    file_size_bytes: int


def _chunks(values: Iterable[int], size: int) -> Iterable[list[int]]:
    chunk: list[int] = []

    for value in values:
        chunk.append(value)

        if len(chunk) == size:
            yield chunk
            chunk = []

    if chunk:
        yield chunk


def _response_rows(response: Any, operation_name: str) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)

    if not isinstance(data, list):
        raise TypeError(f"Respuesta invalida al {operation_name}: se esperaba una lista.")

    if not all(isinstance(row, dict) for row in data):
        raise RuntimeError(f"Respuesta invalida al {operation_name}: contiene filas no validas.")

    return data


def _positive_integer(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{field_name} debe ser un entero positivo.")

    try:
        parsed = int(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field_name} debe ser un entero positivo.") from error

    if parsed <= 0 or str(parsed) != str(value).strip():
        raise ValueError(f"{field_name} debe ser un entero positivo.")

    return parsed


def _csv_value(value: Any) -> str:
    return "" if value is None else str(value)


def _build_csv_row(debt: dict[str, Any], debtor: dict[str, Any]) -> dict[str, str]:
    debtor_type = _positive_integer(debtor.get("type"), "Bien_Tipo_Id")
    account = _positive_integer(debtor.get("external_id"), "Cuenta")
    debt_external_id = _positive_integer(debt.get("external_id"), "DEUD_id")

    return {
        "Bien_Tipo_Id": str(debtor_type),
        "Cuenta": str(account),
        "DEUD_id": str(debt_external_id),
        "tipo_deuda": _csv_value(debt.get("type")),
        "descripcion": _csv_value(debt.get("description")),
        "NOTD_capital": _csv_value(debt.get("original_amount")),
        "NOTD_totalActualizado": _csv_value(debt.get("current_amount")),
        "NOTD_vencimiento": _csv_value(debt.get("due_date")),
        "fecha_emision": _csv_value(debt.get("issue_date")),
        "fecha_ultima_gestion": _csv_value(debt.get("last_collection_date")),
        "periodo": _csv_value(debt.get("period")),
        "estado": _csv_value(debt.get("status")),
        "moneda": _csv_value(debt.get("currency")),
    }


def _fetch_tenant_debtors(client: Any, tenant_id: int, page_size: int) -> dict[int, dict[str, Any]]:
    debtors: dict[int, dict[str, Any]] = {}
    offset = 0

    while True:
        response = execute_supabase_operation(
            f"select debtors del tenant {tenant_id}",
            lambda offset=offset: (
                client.table("debtor")
                .select(DEBTOR_SELECT_COLUMNS)
                .eq("tenant", tenant_id)
                .order("id")
                .range(offset, offset + page_size - 1)
                .execute()
            ),
        )
        rows = _response_rows(response, "consultar objetos")

        for row in rows:
            debtor_id = _positive_integer(row.get("id"), "debtor.id")
            if debtor_id in debtors:
                raise ValueError(f"El objeto interno {debtor_id} se recibio mas de una vez.")
            debtors[debtor_id] = row

        if len(rows) < page_size:
            return debtors

        offset += page_size


def _fetch_debts_for_debtors(
    client: Any,
    debtor_ids: Iterable[int],
    page_size: int,
    debtor_chunk_size: int,
) -> Iterable[dict[str, Any]]:
    for debtor_chunk in _chunks(sorted(debtor_ids), debtor_chunk_size):
        offset = 0

        while True:
            response = execute_supabase_operation(
                f"select deudas de {len(debtor_chunk)} objetos de La Falda",
                lambda debtor_chunk=debtor_chunk, offset=offset: (
                    client.table("debt")
                    .select(DEBT_SELECT_COLUMNS)
                    .in_("debtor", debtor_chunk)
                    .order("id")
                    .range(offset, offset + page_size - 1)
                    .execute()
                ),
            )
            rows = _response_rows(response, "consultar deudas")

            yield from rows

            if len(rows) < page_size:
                break

            offset += page_size


def _count_debts_for_debtors(
    client: Any,
    debtor_ids: Iterable[int],
    debtor_chunk_size: int,
) -> int:
    total = 0

    for debtor_chunk in _chunks(sorted(debtor_ids), debtor_chunk_size):
        response = execute_supabase_operation(
            f"count deudas de {len(debtor_chunk)} objetos de La Falda",
            lambda debtor_chunk=debtor_chunk: (
                client.table("debt")
                .select("id", count="exact", head=True)
                .in_("debtor", debtor_chunk)
                .execute()
            ),
        )
        count = getattr(response, "count", None)

        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise RuntimeError("Supabase no devolvio un conteo valido de deudas.")

        total += count

    return total


def _write_csv(output_path: Path, rows: list[dict[str, str]]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8-sig", newline="") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def _validate_export(output_path: Path, expected_rows: list[dict[str, str]]) -> None:
    with output_path.open("r", encoding="utf-8-sig", newline="") as input_file:
        reader = csv.DictReader(input_file)
        actual_rows = list(reader)

    if reader.fieldnames != list(CSV_COLUMNS):
        raise RuntimeError("El CSV generado no conserva las columnas esperadas por el importador.")

    if actual_rows != expected_rows:
        raise RuntimeError("El CSV generado no conserva los valores leidos desde Supabase.")

    keys = {
        (row["Bien_Tipo_Id"], row["Cuenta"], row["DEUD_id"])
        for row in actual_rows
    }

    if len(actual_rows) != len(keys):
        raise RuntimeError("El CSV generado contiene claves de deuda duplicadas.")

    parsed = parse_daily_csv(output_path)

    if parsed.total_rows != len(expected_rows) or parsed.errors:
        raise RuntimeError("El CSV generado no es valido para el importador diario.")


def export_lafalda_sample(
    client: Any,
    output_path: Path = DEFAULT_OUTPUT_PATH,
    sample_size: int | None = DEFAULT_SAMPLE_SIZE,
    debtor_page_size: int = 1_000,
    debt_page_size: int = 1_000,
    debtor_chunk_size: int = 250,
) -> CsvExportResult:
    """Exporta una muestra o todas las deudas existentes del tenant 1.

    Con ``sample_size=None`` se realiza primero un conteo independiente y se
    exige que el CSV contenga exactamente la totalidad de deudas de La Falda.
    """

    if sample_size is not None and sample_size <= 0:
        raise ValueError("sample_size debe ser mayor a cero.")

    debtors_by_id = _fetch_tenant_debtors(client, LAFALDA_TENANT_ID, debtor_page_size)
    if not debtors_by_id:
        raise RuntimeError("No se encontraron objetos para el tenant 1 de La Falda.")

    database_debt_count = (
        _count_debts_for_debtors(client, debtors_by_id, debtor_chunk_size)
        if sample_size is None
        else None
    )

    csv_rows: list[dict[str, str]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    source_debt_rows_read = 0
    duplicate_keys_skipped = 0
    invalid_rows_skipped = 0

    for debt in _fetch_debts_for_debtors(
        client,
        debtors_by_id,
        debt_page_size,
        debtor_chunk_size,
    ):
        source_debt_rows_read += 1

        try:
            debtor_id = _positive_integer(debt.get("debtor"), "debt.debtor")
            debtor = debtors_by_id[debtor_id]
            csv_row = _build_csv_row(debt, debtor)
        except (KeyError, TypeError, ValueError):
            invalid_rows_skipped += 1
            continue

        key = (csv_row["Bien_Tipo_Id"], csv_row["Cuenta"], csv_row["DEUD_id"])
        if key in seen_keys:
            duplicate_keys_skipped += 1
            continue

        seen_keys.add(key)
        csv_rows.append(csv_row)

        if sample_size is not None and len(csv_rows) == sample_size:
            break

    expected_rows = database_debt_count if sample_size is None else sample_size
    if len(csv_rows) != expected_rows:
        raise RuntimeError(
            "La exportacion no coincide con las deudas existentes: "
            f"CSV={len(csv_rows)}, base={expected_rows}, "
            f"claves_duplicadas={duplicate_keys_skipped}, "
            f"filas_no_representables={invalid_rows_skipped}."
        )

    _write_csv(output_path, csv_rows)
    _validate_export(output_path, csv_rows)

    return CsvExportResult(
        output_path=output_path,
        exported_rows=len(csv_rows),
        database_debt_count=database_debt_count,
        source_debt_rows_read=source_debt_rows_read,
        duplicate_keys_skipped=duplicate_keys_skipped,
        invalid_rows_skipped=invalid_rows_skipped,
        file_size_bytes=output_path.stat().st_size,
    )


def export_lafalda_complete(
    client: Any,
    output_path: Path = DEFAULT_COMPLETE_OUTPUT_PATH,
) -> CsvExportResult:
    """Exporta todas las deudas del tenant 1 y verifica el conteo en origen."""

    return export_lafalda_sample(
        client,
        output_path=output_path,
        sample_size=None,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Exporta una muestra o el padron completo de deudas de La Falda."
    )
    parser.add_argument(
        "--complete",
        action="store_true",
        help="Exporta todas las deudas y verifica el total con un conteo independiente.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Ruta local del CSV de salida.",
    )
    args = parser.parse_args()

    if args.complete:
        result = export_lafalda_complete(
            supabase,
            output_path=args.output or DEFAULT_COMPLETE_OUTPUT_PATH,
        )
    else:
        result = export_lafalda_sample(
            supabase,
            output_path=args.output or DEFAULT_OUTPUT_PATH,
        )

    print(f"CSV generado: {result.output_path}")
    print(f"Deudas exportadas: {result.exported_rows}")
    if result.database_debt_count is not None:
        print(f"Conteo independiente en Supabase: {result.database_debt_count}")
    print(f"Filas leidas desde Supabase: {result.source_debt_rows_read}")
    print(f"Claves duplicadas omitidas: {result.duplicate_keys_skipped}")
    print(f"Filas no representables omitidas: {result.invalid_rows_skipped}")
    print(f"Tamano del archivo: {result.file_size_bytes} bytes")


if __name__ == "__main__":
    main()
