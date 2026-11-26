"""Lectura y validacion segura de CSV para EQUITAS Multiinstitucion.

Este modulo no conoce credenciales ni escribe en Supabase. El worker Multi lo
usa para preparar filas de staging y comparar una importacion con los datos de
una institucion. La ausencia de una columna se conserva separada de una celda
presente pero vacia mediante ``provided_fields``.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

MAX_PREVIEW_SAMPLE_ROWS = 25


@dataclass(frozen=True)
class MultiImportRowError:
    source_row: int
    code: str
    message: str
    source_key: dict[str, str | None]


@dataclass(frozen=True)
class MultiCsvStructure:
    encoding: str
    delimiter: str
    headers: list[str]
    mapping: dict[str, str]
    ignored_columns: list[str]
    ambiguous_headers: dict[str, list[str]]


@dataclass(frozen=True)
class MultiCsvParseResult:
    structure: MultiCsvStructure
    total_rows: int
    rows: list[dict[str, Any]]
    errors: list[MultiImportRowError]


@dataclass(frozen=True)
class MultiCsvComparison:
    inserted: int
    updated: int
    unchanged: int
    rejected: int
    people_new: int
    people_updated: int
    debtor_new: int
    debtor_updated: int
    preview_rows: list[dict[str, Any]]


# El orden refleja los datos que pueden asociarse sin suposiciones. Los aliases
# son solo sugerencias de encabezado: nunca se deduce una identidad por nombre.
FIELD_DEFINITIONS: dict[str, dict[str, Any]] = {
    "debtor_external_reference": {
        "target": "DEBTOR",
        "type": "IDENTIFIER",
        "aliases": {
            "cuenta", "cuenta_id", "numero_cuenta", "nro_cuenta", "codigo_cuenta",
            "legajo", "objeto_id", "id_objeto", "debtor_id", "external_debtor_id",
            "cuenta_universitaria", "referencia_objeto",
        },
    },
    "debtor_identifier": {
        "target": "DEBTOR",
        "type": "IDENTIFIER",
        "aliases": {"identificador", "identificador_objeto", "codigo_objeto"},
    },
    "debtor_description": {
        "target": "DEBTOR",
        "type": "TEXT",
        "aliases": {"bien_descripcion", "descripcion_objeto", "detalle_objeto", "nombre_objeto"},
    },
    "object_type": {
        "target": "DEBTOR",
        "type": "TEXT",
        "aliases": {"bien_tipo_id", "tipo_bien", "tipo_objeto", "object_type", "categoria_objeto"},
    },
    "person_external_reference": {
        "target": "PERSON",
        "type": "IDENTIFIER",
        "aliases": {"destinatario_id", "persona_id", "cliente_id", "deudor_id", "external_person_id"},
    },
    "person_full_name": {
        "target": "PERSON",
        "type": "TEXT",
        "aliases": {"destinatario", "nombre", "nombre_apellido", "nombre_completo", "razon_social", "titular", "persona"},
    },
    "person_document_number": {
        "target": "PERSON",
        "type": "IDENTIFIER",
        "aliases": {"dni", "cuit", "cuil", "documento", "destinatario_cuit", "numero_documento"},
    },
    "person_email": {
        "target": "CONTACT",
        "type": "TEXT",
        "aliases": {"email", "correo", "correo_electronico", "correo_institucional", "destinatario_email", "mail"},
    },
    "person_phone": {
        "target": "CONTACT",
        "type": "TEXT",
        "aliases": {"telefono", "celular", "movil", "destinatario_telefono", "destinatario_celular"},
    },
    "debt_external_reference": {
        "target": "DEBT",
        "type": "IDENTIFIER",
        "aliases": {"deud_id", "deuda_id", "id_deuda", "numero_deuda", "nro_deuda", "external_debt_id", "comprobante_de_deuda"},
    },
    "debt_type": {
        "target": "DEBT",
        "type": "TEXT",
        "aliases": {"tipo_deuda", "tipo_ingreso", "concepto_tipo", "debt_type"},
    },
    "debt_description": {
        "target": "DEBT",
        "type": "TEXT",
        "aliases": {"descripcion", "detalle", "concepto", "descripcion_deuda", "debt_description"},
    },
    "original_amount": {
        "target": "DEBT",
        "type": "DECIMAL",
        "aliases": {"notd_capital", "capital", "importe_original", "monto_original", "saldo_original"},
    },
    "current_amount": {
        "target": "DEBT",
        "type": "DECIMAL",
        "aliases": {"notd_totalactualizado", "total_actualizado", "importe_actual", "importe_actualizado", "monto_actualizado", "saldo", "saldo_actualizado", "importe", "monto", "current_amount"},
    },
    "issue_date": {
        "target": "DEBT",
        "type": "DATE",
        "aliases": {"fecha_emision", "emision", "issue_date"},
    },
    "due_date": {
        "target": "DEBT",
        "type": "DATE",
        "aliases": {"notd_vencimiento", "vencimiento", "fecha_vencimiento", "fecha_de_vencimiento", "due_date"},
    },
    "status": {
        "target": "DEBT",
        "type": "TEXT",
        "aliases": {"estado", "estado_deuda", "debt_status"},
    },
    "period": {
        "target": "DEBT",
        "type": "TEXT",
        "aliases": {"periodo", "periodo_deuda", "period"},
    },
}

REQUIRED_IDENTITY_FIELDS = frozenset({"debtor_external_reference", "debt_external_reference"})
REQUIRED_NEW_DEBT_FIELDS = frozenset({"original_amount", "current_amount"})
DEBT_STORAGE_FIELD = {
    "debt_type": "type",
    "debt_description": "description",
    "original_amount": "original_amount",
    "current_amount": "current_amount",
    "issue_date": "issue_date",
    "due_date": "due_date",
    "status": "status",
    "period": "period",
}


def normalize_multi_csv_header(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value).strip().casefold())
    return "".join(
        character
        for character in text
        if unicodedata.category(character) != "Mn" and character.isalnum()
    )


def _clean_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _alias_index() -> dict[str, set[str]]:
    index: dict[str, set[str]] = {}
    for canonical, definition in FIELD_DEFINITIONS.items():
        for alias in {canonical, *definition["aliases"]}:
            index.setdefault(normalize_multi_csv_header(alias), set()).add(canonical)
    return index


HEADER_ALIASES = _alias_index()


def _decode_csv_content(content: bytes) -> tuple[str, str]:
    for encoding, label in (("utf-8-sig", "UTF-8-SIG"), ("cp1252", "WINDOWS-1252")):
        try:
            return content.decode(encoding), label
        except UnicodeDecodeError:
            continue
    raise ValueError("El archivo no usa UTF-8, UTF-8 con BOM ni Windows-1252.")


def _detect_delimiter(decoded_content: str) -> str:
    sample = "\n".join(line for line in decoded_content.splitlines() if line.strip())[:8192]
    if not sample:
        raise ValueError("El CSV esta vacio.")
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error as error:
        raise ValueError("No se pudo identificar el separador del CSV.") from error
    return dialect.delimiter


def _read_csv_matrix(content: bytes) -> tuple[list[str], list[list[str]], str, str]:
    decoded, encoding = _decode_csv_content(content)
    delimiter = _detect_delimiter(decoded)
    rows = list(csv.reader(io.StringIO(decoded), delimiter=delimiter))
    if not rows or not rows[0]:
        raise ValueError("El CSV no contiene encabezados.")
    headers = [header.strip() for header in rows[0]]
    if any(not header for header in headers):
        raise ValueError("El CSV contiene un encabezado vacio.")
    if len({normalize_multi_csv_header(header) for header in headers}) != len(headers):
        raise ValueError("El CSV contiene encabezados repetidos o indistinguibles.")
    return headers, rows[1:], encoding, delimiter


def detect_multi_csv_structure(
    content: bytes,
    overrides: dict[str, str] | None = None,
) -> MultiCsvStructure:
    headers, _rows, encoding, delimiter = _read_csv_matrix(content)
    matches: dict[str, list[str]] = {}
    mapping: dict[str, str] = {}
    ambiguous: dict[str, list[str]] = {}

    for header in headers:
        candidates = HEADER_ALIASES.get(normalize_multi_csv_header(header), set())
        if len(candidates) > 1:
            ambiguous[header] = sorted(candidates)
            continue
        if len(candidates) == 1:
            canonical = next(iter(candidates))
            matches.setdefault(canonical, []).append(header)

    for canonical, sources in matches.items():
        if len(sources) > 1:
            ambiguous[canonical] = sources
        else:
            mapping[canonical] = sources[0]

    if overrides:
        used_headers: set[str] = set()
        for canonical, header in overrides.items():
            if canonical not in FIELD_DEFINITIONS:
                raise ValueError(f"El campo de mapeo {canonical!r} no existe.")
            if header not in headers:
                raise ValueError(f"La columna seleccionada {header!r} no existe en el CSV.")
            if header in used_headers:
                raise ValueError(f"La columna {header!r} se asigno a mas de un campo.")
            used_headers.add(header)
            mapping[canonical] = header

    missing_identity = sorted(REQUIRED_IDENTITY_FIELDS - set(mapping))
    if missing_identity:
        raise ValueError(
            "No se pudieron identificar las columnas de identidad requeridas: "
            + ", ".join(missing_identity)
            + ". Revise el mapeo antes de continuar."
        )

    ignored = sorted(header for header in headers if header not in set(mapping.values()))
    return MultiCsvStructure(
        encoding=encoding,
        delimiter=delimiter,
        headers=headers,
        mapping=mapping,
        ignored_columns=ignored,
        ambiguous_headers=ambiguous,
    )


def _parse_decimal(value: object, field_name: str) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    normalized = text.replace(" ", "")
    if normalized.startswith("-") or not re.fullmatch(r"[0-9.,]+", normalized):
        raise ValueError(f"{field_name} debe ser un importe no negativo.")
    if "," in normalized and "." in normalized:
        if re.fullmatch(r"\d{1,3}(?:\.\d{3})+,\d{1,2}", normalized):
            normalized = normalized.replace(".", "").replace(",", ".")
        elif re.fullmatch(r"\d{1,3}(?:,\d{3})+\.\d{1,2}", normalized):
            normalized = normalized.replace(",", "")
        else:
            raise ValueError(f"{field_name} tiene un formato de importe ambiguo: {text!r}.")
    elif "," in normalized:
        if re.fullmatch(r"\d+,\d{1,2}", normalized):
            normalized = normalized.replace(",", ".")
        elif re.fullmatch(r"\d{1,3}(?:,\d{3}){2,}", normalized):
            normalized = normalized.replace(",", "")
        else:
            raise ValueError(f"{field_name} tiene un formato de importe ambiguo: {text!r}.")
    elif "." in normalized:
        if re.fullmatch(r"\d+\.\d{1,2}", normalized):
            pass
        elif re.fullmatch(r"\d{1,3}(?:\.\d{3}){2,}", normalized):
            normalized = normalized.replace(".", "")
        else:
            raise ValueError(f"{field_name} tiene un formato de importe ambiguo: {text!r}.")
    try:
        amount = Decimal(normalized)
    except InvalidOperation as error:
        raise ValueError(f"{field_name} no es un importe valido.") from error
    if not amount.is_finite() or amount < 0:
        raise ValueError(f"{field_name} debe ser un importe no negativo.")
    return format(amount, "f")


def _parse_date(value: object, field_name: str) -> str | None:
    text = _clean_text(value)
    if text is None:
        return None
    for date_format in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, date_format).date().isoformat()
        except ValueError:
            continue
    match = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", text)
    if match is None:
        raise ValueError(f"{field_name} no es una fecha valida.")
    day, month, year = (int(value) for value in match.groups())
    if day <= 12 and month <= 12 and day != month:
        raise ValueError(f"{field_name} tiene una fecha ambigua: {text!r}. Use AAAA-MM-DD.")
    try:
        return date(year, month, day).isoformat()
    except ValueError as error:
        raise ValueError(f"{field_name} no es una fecha valida.") from error


def canonical_identity_hash(values: dict[str, str | None]) -> str:
    serialized = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _source_key(values: dict[str, str | None]) -> dict[str, str | None]:
    return {
        "debtor_external_reference": values.get("debtor_external_reference"),
        "debt_external_reference": values.get("debt_external_reference"),
    }


def parse_multi_csv_bytes(
    content: bytes,
    overrides: dict[str, str] | None = None,
) -> MultiCsvParseResult:
    structure = detect_multi_csv_structure(content, overrides)
    _headers, source_rows, _encoding, _delimiter = _read_csv_matrix(content)
    rows: list[dict[str, Any]] = []
    errors: list[MultiImportRowError] = []
    seen_identities: set[tuple[str, str]] = set()

    for row_number, source_values in enumerate(source_rows, start=2):
        values_by_header = {
            header: source_values[index].strip() if index < len(source_values) else ""
            for index, header in enumerate(structure.headers)
        }
        normalized: dict[str, str | None] = {}
        provided_fields: list[str] = []
        try:
            for canonical, header in structure.mapping.items():
                raw_value = values_by_header.get(header)
                provided_fields.append(canonical)
                data_type = FIELD_DEFINITIONS[canonical]["type"]
                if data_type == "DECIMAL":
                    normalized[canonical] = _parse_decimal(raw_value, canonical)
                elif data_type == "DATE":
                    normalized[canonical] = _parse_date(raw_value, canonical)
                else:
                    normalized[canonical] = _clean_text(raw_value)

            if not normalized.get("debtor_external_reference") or not normalized.get("debt_external_reference"):
                raise ValueError("Las identidades del objeto y de la deuda son obligatorias.")

            debtor_hash = canonical_identity_hash({"external_reference": normalized["debtor_external_reference"]})
            debt_hash = canonical_identity_hash({"external_reference": normalized["debt_external_reference"]})
            identity = (debtor_hash, debt_hash)
            if identity in seen_identities:
                raise ValueError("La deuda se repite dentro del mismo CSV.")
            seen_identities.add(identity)

            rows.append(
                {
                    "source_row": row_number,
                    "raw_values": values_by_header,
                    "normalized_values": normalized,
                    "provided_fields": provided_fields,
                    "debtor_identity_hash": debtor_hash,
                    "debt_identity_hash": debt_hash,
                    "person_identity_hash": (
                        canonical_identity_hash({"external_reference": normalized["person_external_reference"]})
                        if normalized.get("person_external_reference")
                        else None
                    ),
                }
            )
        except ValueError as error:
            errors.append(
                MultiImportRowError(
                    source_row=row_number,
                    code="INVALID_ROW",
                    message=str(error),
                    source_key=_source_key(normalized),
                )
            )

    return MultiCsvParseResult(
        structure=structure,
        total_rows=len(source_rows),
        rows=rows,
        errors=errors,
    )


def _values_differ(left: object, right: object, field: str | None = None) -> bool:
    if left is None and right is None:
        return False
    if field in {"original_amount", "current_amount"}:
        try:
            return Decimal(str(left)) != Decimal(str(right))
        except InvalidOperation:
            return True
    return str(left) != str(right)


def compare_multi_csv_rows(
    parsed: MultiCsvParseResult,
    existing_debtors: dict[str, dict[str, Any]],
    existing_debts: dict[tuple[str, str], dict[str, Any]],
    existing_people: dict[str, dict[str, Any]] | None = None,
) -> MultiCsvComparison:
    inserted = updated = unchanged = rejected = 0
    people_new = people_updated = debtor_new = debtor_updated = 0
    preview_rows: list[dict[str, Any]] = []
    people_by_hash = existing_people or {}

    for row in parsed.rows:
        values = row["normalized_values"]
        debtor = existing_debtors.get(row["debtor_identity_hash"])
        debt = existing_debts.get((row["debtor_identity_hash"], row["debt_identity_hash"]))
        comparison = "UNCHANGED"
        changed_fields: list[str] = []

        if debtor is None:
            debtor_new += 1
        if debt is None:
            missing = [field for field in REQUIRED_NEW_DEBT_FIELDS if not values.get(field)]
            if missing:
                rejected += 1
                comparison = "REJECTED"
                changed_fields = missing
            else:
                inserted += 1
                comparison = "INSERTED"
        else:
            for field in row["provided_fields"]:
                if field in {"debtor_external_reference", "debt_external_reference", "person_external_reference"}:
                    continue
                storage_field = DEBT_STORAGE_FIELD.get(field)
                if storage_field and _values_differ(
                    debt.get(storage_field), values.get(field), field
                ):
                    changed_fields.append(field)
            if changed_fields:
                updated += 1
                comparison = "UPDATED"
            else:
                unchanged += 1

        if debtor is not None and values.get("debtor_description") and _values_differ(
            debtor.get("description"), values.get("debtor_description")
        ):
            debtor_updated += 1

        person_hash = row.get("person_identity_hash")
        if person_hash:
            person = people_by_hash.get(person_hash)
            if person is None:
                people_new += 1
            elif values.get("person_full_name") and _values_differ(person.get("full_name"), values.get("person_full_name")):
                people_updated += 1

        if len(preview_rows) < MAX_PREVIEW_SAMPLE_ROWS:
            preview_rows.append(
                {
                    "source_row": row["source_row"],
                    "comparison": comparison,
                    "changed_fields": changed_fields,
                    "debtor_external_reference": values.get("debtor_external_reference"),
                    "debt_external_reference": values.get("debt_external_reference"),
                }
            )

    return MultiCsvComparison(
        inserted=inserted,
        updated=updated,
        unchanged=unchanged,
        rejected=rejected + len(parsed.errors),
        people_new=people_new,
        people_updated=people_updated,
        debtor_new=debtor_new,
        debtor_updated=debtor_updated,
        preview_rows=preview_rows,
    )


def iter_chunks(values: Iterable[dict[str, Any]], size: int = 500) -> Iterable[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for value in values:
        batch.append(value)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
