"""PreparaciÃ³n y comparaciÃ³n del CSV diario de deudas de La Falda.

Este mÃ³dulo no escribe en Supabase. El worker persistente usa sus filas de
staging y sus resultados de validaciÃ³n antes de decidir si ejecuta un dry-run
o una importaciÃ³n confirmada.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd

from ETL.extract import read_csv, read_csv_bytes
from ETL.load import debt_values_are_equal
from ETL.transform import (
    clean_text,
    parse_int,
)

DAILY_CSV_REQUIRED_COLUMNS = frozenset(
    {
        "Bien_Tipo_Id",
        "Cuenta",
        "DEUD_id",
    }
)

DAILY_CSV_OPTIONAL_COLUMNS = frozenset(
    {
        "NOTD_capital",
        "NOTD_totalActualizado",
        "tipo_deuda",
        "descripcion",
        "NOTD_vencimiento",
        "fecha_emision",
        "fecha_ultima_gestion",
        "periodo",
        "estado",
        "moneda",
    }
)

DAILY_CSV_KNOWN_COLUMNS = DAILY_CSV_REQUIRED_COLUMNS | DAILY_CSV_OPTIONAL_COLUMNS

# Alias explÃ­citos: los nombres originales siguen siendo la referencia y no se
# intenta inferir columnas que no estÃ©n listadas aquÃ­.
DAILY_CSV_COLUMN_ALIASES = {
    "Bien_Tipo_Id": {"Tipo_Bien_Id", "Id_Tipo_Bien"},
    "Cuenta": {"Cuenta_Id", "Numero_Cuenta", "Nro_Cuenta"},
    "DEUD_id": {"Deuda_Id", "Id_Deuda", "Numero_Deuda", "Nro_Deuda"},
    "NOTD_capital": {"Capital", "Importe_Original", "Monto_Original"},
    "NOTD_totalActualizado": {
        "Total_Actualizado",
        "Importe_Actualizado",
        "Monto_Actualizado",
        "Saldo_Actualizado",
    },
    "tipo_deuda": {"Tipo_Deuda"},
    "descripcion": {"Descripcion", "Detalle", "Concepto"},
    "NOTD_vencimiento": {"Vencimiento", "Fecha_Vencimiento"},
    "fecha_emision": {"Emision", "Fecha_Emision"},
    "fecha_ultima_gestion": {"Ultima_Gestion", "Fecha_Ultima_Gestion"},
    "periodo": {"Periodo_Deuda"},
    "estado": {"Estado_Deuda"},
    "moneda": {"Moneda_Id"},
}

STAGE_TO_DEBT_COLUMN = {
    "debt_type": "type",
    "description": "description",
    "original_amount": "original_amount",
    "current_amount": "current_amount",
    "currency": "currency",
    "issue_date": "issue_date",
    "due_date": "due_date",
    "last_collection_date": "last_collection_date",
    "period": "period",
    "status": "status",
}


@dataclass(frozen=True)
class ImportRowError:
    source_row: int
    code: str
    message: str
    source_key: dict[str, int | None]


@dataclass(frozen=True)
class DailyCsvParseResult:
    total_rows: int
    stage_rows: list[dict[str, Any]]
    errors: list[ImportRowError]
    ignored_columns: list[str]


@dataclass(frozen=True)
class DailyCsvComparison:
    total_rows: int
    inserted: int
    updated: int
    unchanged: int
    rejected: int
    unknown_debtors: int


def normalize_daily_csv_header(value: object) -> str:
    """Normaliza mayÃºsculas, espacios, guiones y acentos de una cabecera."""

    text = unicodedata.normalize("NFKD", str(value).strip().casefold())
    return "".join(
        character
        for character in text
        if unicodedata.category(character) != "Mn" and character.isalnum()
    )


def _build_header_aliases() -> dict[str, str]:
    aliases: dict[str, str] = {}

    for canonical_name in DAILY_CSV_KNOWN_COLUMNS:
        names = {canonical_name, *DAILY_CSV_COLUMN_ALIASES.get(canonical_name, set())}
        for name in names:
            normalized_name = normalize_daily_csv_header(name)
            previous_name = aliases.get(normalized_name)
            if previous_name is not None and previous_name != canonical_name:
                raise RuntimeError(
                    f"El alias de cabecera {name!r} coincide con {previous_name!r} y {canonical_name!r}."
                )
            aliases[normalized_name] = canonical_name

    return aliases


DAILY_CSV_HEADER_ALIASES = _build_header_aliases()


def _parse_identifier(value: Any, field_name: str) -> int:
    text = clean_text(value)

    if text is None or not re.fullmatch(r"\d+", text):
        raise ValueError(f"{field_name} debe ser un entero positivo.")

    parsed = int(text)

    if parsed <= 0:
        raise ValueError(f"{field_name} debe ser mayor a cero.")

    return parsed


def _parse_decimal_strict(value: Any, field_name: str) -> float:
    text = clean_text(value)

    if text is None:
        raise ValueError(f"{field_name} es obligatorio.")

    normalized = text.replace(" ", "")

    if normalized.startswith("-"):
        raise ValueError(f"{field_name} debe ser un importe no negativo.")

    if not re.fullmatch(r"[0-9.,]+", normalized):
        raise ValueError(f"{field_name} no es un importe valido.")

    if "," in normalized and "." in normalized:
        if re.fullmatch(r"\d{1,3}(?:\.\d{3})+,\d{1,2}", normalized):
            normalized = normalized.replace(".", "").replace(",", ".")
        elif re.fullmatch(r"\d{1,3}(?:,\d{3})+\.\d{1,2}", normalized):
            normalized = normalized.replace(",", "")
        else:
            raise ValueError(
                f"{field_name} tiene un formato de importe ambiguo: {text!r}. "
                "Use 1234,50 o 1.234,50."
            )
    elif "," in normalized:
        if re.fullmatch(r"\d+,\d{1,2}", normalized):
            normalized = normalized.replace(",", ".")
        elif re.fullmatch(r"\d{1,3}(?:,\d{3}){2,}", normalized):
            normalized = normalized.replace(",", "")
        else:
            raise ValueError(
                f"{field_name} tiene un formato de importe ambiguo: {text!r}. "
                "Use 1234,50 o 1.234,50."
            )
    elif "." in normalized:
        if re.fullmatch(r"\d+\.\d{1,2}", normalized):
            pass
        elif re.fullmatch(r"\d{1,3}(?:\.\d{3}){2,}", normalized):
            normalized = normalized.replace(".", "")
        else:
            raise ValueError(
                f"{field_name} tiene un formato de importe ambiguo: {text!r}. "
                "Use 1234,50 o 1.234,50."
            )

    try:
        parsed = Decimal(normalized)
    except InvalidOperation as error:
        raise ValueError(f"{field_name} no es un importe vÃ¡lido.") from error

    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{field_name} debe ser un importe no negativo.")

    return float(parsed)


def _parse_optional_decimal(value: Any, field_name: str) -> float | None:
    if clean_text(value) is None:
        return None

    return _parse_decimal_strict(value, field_name)


def _parse_optional_date(value: Any, field_name: str) -> str | None:
    text = clean_text(value)

    if text is None:
        return None

    formats = ("%Y-%m-%d", "%Y/%m/%d")
    for date_format in formats:
        try:
            return datetime.strptime(text, date_format).date().isoformat()
        except ValueError:
            continue

    match = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", text)
    if match is None:
        raise ValueError(f"{field_name} no es una fecha valida.")

    day, month, year = (int(part) for part in match.groups())
    if day <= 12 and month <= 12 and day != month:
        raise ValueError(
            f"{field_name} tiene una fecha ambigua: {text!r}. Use AAAA-MM-DD."
        )

    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError as error:
        raise ValueError(f"{field_name} no es una fecha valida.") from error


def _source_key(row: dict[str, Any]) -> dict[str, int | None]:
    return {
        "bien_tipo_id": parse_int(row.get("Bien_Tipo_Id")),
        "cuenta": parse_int(row.get("Cuenta")),
        "deud_id": parse_int(row.get("DEUD_id")),
    }


def normalize_daily_csv_columns(dataframe: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Convierte cabeceras compatibles al nombre canÃ³nico y rechaza ambigÃ¼edades."""

    source_headers = dataframe.attrs.get("equitas_csv_headers", list(dataframe.columns))
    if not isinstance(source_headers, list) or len(source_headers) != len(dataframe.columns):
        source_headers = list(dataframe.columns)

    canonical_sources: dict[str, list[str]] = {}
    normalized_columns: list[str] = []
    ignored_columns: list[str] = []

    for original_header in source_headers:
        source_name = str(original_header)
        canonical_name = DAILY_CSV_HEADER_ALIASES.get(normalize_daily_csv_header(source_name))

        if canonical_name is None:
            normalized_columns.append(source_name)
            ignored_columns.append(source_name)
            continue

        canonical_sources.setdefault(canonical_name, []).append(source_name)
        normalized_columns.append(canonical_name)

    ambiguous_headers = {
        canonical: source_names
        for canonical, source_names in canonical_sources.items()
        if len(source_names) > 1
    }
    if ambiguous_headers:
        formatted = "; ".join(
            f"{canonical}: {', '.join(source_names)}"
            for canonical, source_names in sorted(ambiguous_headers.items())
        )
        raise ValueError(f"El CSV tiene encabezados ambiguos: {formatted}.")

    normalized_dataframe = dataframe.copy()
    normalized_dataframe.columns = normalized_columns
    return normalized_dataframe, sorted(ignored_columns)


def validate_daily_csv_columns(dataframe: pd.DataFrame) -> list[str]:
    columns = {str(column) for column in dataframe.columns}
    missing_columns = sorted(DAILY_CSV_REQUIRED_COLUMNS - columns)

    if missing_columns:
        raise ValueError(
            "El CSV diario no contiene las columnas obligatorias: "
            + ", ".join(missing_columns)
        )

    return sorted(columns - DAILY_CSV_KNOWN_COLUMNS)


def build_daily_stage_rows(dataframe: pd.DataFrame) -> DailyCsvParseResult:
    """Valida y normaliza el formato diario sin resolver IDs internos."""

    normalized_dataframe, ignored_columns = normalize_daily_csv_columns(dataframe)
    validate_daily_csv_columns(normalized_dataframe)
    stage_rows: list[dict[str, Any]] = []
    errors: list[ImportRowError] = []
    seen_keys: set[tuple[int, int, int]] = set()

    for source_row, raw_row in enumerate(normalized_dataframe.to_dict(orient="records"), start=2):
        row = {str(key): value for key, value in raw_row.items()}
        source_key = _source_key(row)

        try:
            debtor_type = _parse_identifier(row.get("Bien_Tipo_Id"), "Bien_Tipo_Id")
            debtor_external_id = _parse_identifier(row.get("Cuenta"), "Cuenta")
            debt_external_id = _parse_identifier(row.get("DEUD_id"), "DEUD_id")
            original_amount = _parse_optional_decimal(row.get("NOTD_capital"), "NOTD_capital")
            current_amount = _parse_optional_decimal(
                row.get("NOTD_totalActualizado"),
                "NOTD_totalActualizado",
            )

            key = (debtor_type, debtor_external_id, debt_external_id)

            if key in seen_keys:
                raise ValueError("La deuda se repite dentro del mismo CSV.")

            seen_keys.add(key)
            # La importaciÃ³n diaria usa sus validadores estrictos para fechas e
            # importes; no reutiliza el parser permisivo del ETL histÃ³rico.
            debt_type = clean_text(row.get("tipo_deuda"))
            description = clean_text(row.get("descripcion"))
            period = clean_text(row.get("periodo"))
            provided_fields: list[str] = []

            if original_amount is not None:
                provided_fields.append("original_amount")

            if current_amount is not None:
                provided_fields.append("current_amount")

            for source_column, stage_column in (
                ("tipo_deuda", "debt_type"),
                ("descripcion", "description"),
                ("NOTD_vencimiento", "due_date"),
                ("fecha_emision", "issue_date"),
                ("fecha_ultima_gestion", "last_collection_date"),
                ("periodo", "period"),
                ("estado", "status"),
                ("moneda", "currency"),
            ):
                # Columna ausente y celda opcional vacÃ­a no representan una
                # actualizaciÃ³n. AsÃ­ el merge conserva el valor ya persistido.
                if source_column in row and clean_text(row[source_column]) is not None:
                    provided_fields.append(stage_column)

            due_date = _parse_optional_date(row.get("NOTD_vencimiento"), "NOTD_vencimiento")
            issue_date = _parse_optional_date(row.get("fecha_emision"), "fecha_emision")
            last_collection_date = _parse_optional_date(
                row.get("fecha_ultima_gestion"),
                "fecha_ultima_gestion",
            )
            status = parse_int(row.get("estado"))
            currency = parse_int(row.get("moneda"))

            if clean_text(row.get("estado")) is not None and status is None:
                raise ValueError("estado debe ser un entero vÃ¡lido.")

            if clean_text(row.get("moneda")) is not None and currency is None:
                raise ValueError("moneda debe ser un entero vÃ¡lido.")

            stage_rows.append(
                {
                    "source_row": source_row,
                    "debtor_type": debtor_type,
                    "debtor_external_id": debtor_external_id,
                    "debt_external_id": debt_external_id,
                    "debt_type": debt_type,
                    "description": description,
                    "original_amount": original_amount,
                    "current_amount": current_amount,
                    "currency": currency,
                    "issue_date": issue_date,
                    "due_date": due_date,
                    "last_collection_date": last_collection_date,
                    "period": period,
                    "status": status,
                    "provided_fields": provided_fields,
                }
            )
        except ValueError as error:
            errors.append(
                ImportRowError(
                    source_row=source_row,
                    code="INVALID_ROW",
                    message=str(error),
                    source_key=source_key,
                )
            )

    return DailyCsvParseResult(
        total_rows=len(dataframe.index),
        stage_rows=stage_rows,
        errors=errors,
        ignored_columns=ignored_columns,
    )


def parse_daily_csv(path: Path) -> DailyCsvParseResult:
    return build_daily_stage_rows(read_csv(path))


def parse_daily_csv_bytes(content: bytes) -> DailyCsvParseResult:
    return build_daily_stage_rows(read_csv_bytes(content))


def stage_row_to_debt_payload(stage_row: dict[str, Any], debtor_id: int) -> dict[str, Any]:
    return {
        "external_id": int(stage_row["debt_external_id"]),
        "debtor": debtor_id,
        "type": stage_row.get("debt_type"),
        "description": stage_row.get("description"),
        "original_amount": stage_row.get("original_amount"),
        "current_amount": stage_row.get("current_amount"),
        "currency": stage_row.get("currency"),
        "issue_date": stage_row.get("issue_date"),
        "due_date": stage_row.get("due_date"),
        "last_collection_date": stage_row.get("last_collection_date"),
        "period": stage_row.get("period"),
        "status": stage_row.get("status"),
    }


def debt_payload_differs(
    stage_row: dict[str, Any],
    existing_debt: dict[str, Any],
    debtor_id: int,
) -> bool:
    payload = stage_row_to_debt_payload(stage_row, debtor_id)

    for stage_column in stage_row["provided_fields"]:
        debt_column = STAGE_TO_DEBT_COLUMN[stage_column]

        if not debt_values_are_equal(
            debt_column,
            existing_debt.get(debt_column),
            payload.get(debt_column),
        ):
            return True

    return False


def new_debt_has_required_values(stage_row: dict[str, Any]) -> bool:
    required_fields = {"original_amount", "current_amount"}
    provided_fields = set(stage_row["provided_fields"])

    return (
        required_fields.issubset(provided_fields)
        and stage_row.get("original_amount") is not None
        and stage_row.get("current_amount") is not None
    )


def compare_daily_csv_rows(
    parsed: DailyCsvParseResult,
    debtor_ids_by_key: dict[tuple[int, int], int],
    existing_debts_by_key: dict[tuple[int, int], dict[str, Any]],
) -> DailyCsvComparison:
    inserted = 0
    updated = 0
    unchanged = 0
    unknown_debtors = 0
    incomplete_new_debts = 0

    for stage_row in parsed.stage_rows:
        debtor_id = debtor_ids_by_key.get(
            (int(stage_row["debtor_type"]), int(stage_row["debtor_external_id"]))
        )

        if debtor_id is None:
            unknown_debtors += 1
            continue

        existing_debt = existing_debts_by_key.get(
            (debtor_id, int(stage_row["debt_external_id"]))
        )

        if existing_debt is None and not new_debt_has_required_values(stage_row):
            incomplete_new_debts += 1
            continue

        if existing_debt is None:
            inserted += 1
        elif debt_payload_differs(stage_row, existing_debt, debtor_id):
            updated += 1
        else:
            unchanged += 1

    return DailyCsvComparison(
        total_rows=parsed.total_rows,
        inserted=inserted,
        updated=updated,
        unchanged=unchanged,
        rejected=len(parsed.errors) + unknown_debtors + incomplete_new_debts,
        unknown_debtors=unknown_debtors,
    )
