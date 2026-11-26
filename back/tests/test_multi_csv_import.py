from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest

from ETL.multi_csv_import import (
    canonical_identity_hash,
    compare_multi_csv_rows,
    detect_multi_csv_structure,
    parse_multi_csv_bytes,
)


def build_csv(headers: list[str], rows: list[list[str]], delimiter: str = ",") -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=delimiter)
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def canonical_csv(rows: list[list[str]]) -> bytes:
    return build_csv(
        ["Cuenta", "Deuda Id", "Capital", "Importe actualizado", "Descripcion"], rows
    )


def test_detects_aliases_order_delimiter_and_ignored_columns() -> None:
    content = build_csv(
        ["Importe actualizado", "Columna extra", "Deuda Id", "Cuenta", "Capital"],
        [["1.250,50", "ignorar", "CUOTA-1", "ALU-001", "1.000,00"]],
        delimiter=";",
    )

    result = parse_multi_csv_bytes(content)

    assert result.structure.delimiter == ";"
    assert result.structure.mapping["debtor_external_reference"] == "Cuenta"
    assert result.structure.mapping["debt_external_reference"] == "Deuda Id"
    assert result.structure.ignored_columns == ["Columna extra"]
    assert result.rows[0]["normalized_values"]["current_amount"] == "1250.50"


def test_accepts_windows_1252_and_normalizes_accents() -> None:
    content = (
        "CÓDIGO CUENTA;NÚMERO DEUDA;IMPORTE ORIGINAL;IMPORTE ACTUALIZADO\n"
        "ALU-001;CUOTA-1;1000,00;1250,50\n"
    ).encode("cp1252")

    result = parse_multi_csv_bytes(content)

    assert result.structure.encoding == "WINDOWS-1252"
    assert result.errors == []
    assert result.rows[0]["normalized_values"]["debtor_external_reference"] == "ALU-001"


def test_requires_explicit_mapping_when_required_identity_is_unknown() -> None:
    content = build_csv(
        ["Referencia interna", "Comprobante externo", "Capital", "Saldo"],
        [["ALU-001", "CUOTA-1", "1000", "1200"]],
    )

    with pytest.raises(ValueError, match="identidad requeridas"):
        detect_multi_csv_structure(content)

    result = parse_multi_csv_bytes(
        content,
        overrides={
            "debtor_external_reference": "Referencia interna",
            "debt_external_reference": "Comprobante externo",
            "original_amount": "Capital",
            "current_amount": "Saldo",
        },
    )

    assert result.errors == []
    assert result.rows[0]["normalized_values"]["debt_external_reference"] == "CUOTA-1"


def test_rejects_ambiguous_amount_and_duplicate_debt_identity() -> None:
    content = canonical_csv(
        [
            ["ALU-001", "CUOTA-1", "1.000", "1.234", "Arancel"],
            ["ALU-002", "CUOTA-2", "1000", "1200", "Arancel"],
            ["ALU-002", "CUOTA-2", "1000", "1200", "Arancel"],
        ]
    )

    result = parse_multi_csv_bytes(content)

    assert len(result.rows) == 1
    assert len(result.errors) == 2
    assert "ambiguo" in result.errors[0].message
    assert "repite" in result.errors[1].message


def test_marks_absent_optional_column_differently_from_present_empty_value() -> None:
    without_description = parse_multi_csv_bytes(
        build_csv(
            ["Cuenta", "Deuda Id", "Capital", "Importe actualizado"],
            [["ALU-001", "CUOTA-1", "1000", "1200"]],
        )
    )
    with_empty_description = parse_multi_csv_bytes(
        canonical_csv([["ALU-001", "CUOTA-1", "1000", "1200", ""]])
    )

    assert "debt_description" not in without_description.rows[0]["provided_fields"]
    assert "debt_description" in with_empty_description.rows[0]["provided_fields"]
    assert with_empty_description.rows[0]["normalized_values"]["debt_description"] is None


def test_comparison_identifies_new_updated_and_unchanged_without_writes() -> None:
    parsed = parse_multi_csv_bytes(
        canonical_csv(
            [
                ["ALU-001", "CUOTA-1", "1000.00", "1200.00", "Arancel"],
                ["ALU-001", "CUOTA-2", "1000.00", "1500.00", "Nueva cuota"],
                ["ALU-002", "CUOTA-1", "1000.00", "1000.00", "Nueva cuenta"],
            ]
        )
    )
    existing_debtors = {
        parsed.rows[0]["debtor_identity_hash"]: {"description": "Cuenta existente"},
    }
    existing_debts = {
        (parsed.rows[0]["debtor_identity_hash"], parsed.rows[0]["debt_identity_hash"]): {
            "original_amount": "1000",
            "current_amount": "1200",
            "description": "Arancel",
        },
        (parsed.rows[1]["debtor_identity_hash"], parsed.rows[1]["debt_identity_hash"]): {
            "original_amount": "1000",
            "current_amount": "1400",
            "description": "Nueva cuota",
        },
    }

    comparison = compare_multi_csv_rows(parsed, existing_debtors, existing_debts)

    assert (comparison.inserted, comparison.updated, comparison.unchanged, comparison.rejected) == (1, 1, 1, 0)
    assert comparison.debtor_new == 1


def test_supports_a_large_csv_without_database_access() -> None:
    rows = [[f"ALU-{index:05d}", f"CUOTA-{index:05d}", "1000", "1200", "Arancel"] for index in range(56_000)]

    result = parse_multi_csv_bytes(canonical_csv(rows))

    assert result.total_rows == 56_000
    assert len(result.rows) == 56_000
    assert result.errors == []


def test_fictitious_institution_fixtures_support_initial_load_and_update_formats() -> None:
    fixture_dir = Path(__file__).resolve().parents[1] / "ETL" / "test_data"

    initial = parse_multi_csv_bytes((fixture_dir / "multi_universidad_primera_carga.csv").read_bytes())
    update = parse_multi_csv_bytes((fixture_dir / "multi_universidad_actualizacion.csv").read_bytes())

    assert initial.total_rows == 2
    assert initial.structure.delimiter == ";"
    assert initial.structure.ignored_columns == ["Columna ajena"]
    assert initial.errors == []
    assert initial.rows[0]["normalized_values"]["person_document_number"] == "90000001"
    assert update.total_rows == 3
    assert update.structure.mapping["debtor_external_reference"] == "Referencia objeto"
    assert update.structure.mapping["debt_external_reference"] == "Id deuda"
    assert update.rows[0]["normalized_values"]["current_amount"] == "16000.00"
    assert update.structure.ignored_columns == [
        "Campo irrelevante",
        "Columna adicional A",
        "Observacion interna",
        "Origen planilla",
    ]

    for row in update.rows:
        values = row["normalized_values"]
        row["debtor_identity_hash"] = canonical_identity_hash(
            {"account_code": values["debtor_external_reference"]}
        )
        row["debt_identity_hash"] = canonical_identity_hash(
            {"installment_code": values["debt_external_reference"]}
        )
        row["person_identity_hash"] = canonical_identity_hash(
            {"document_number": values["person_document_number"]}
        )

    existing_debtors = {
        update.rows[0]["debtor_identity_hash"]: {},
        update.rows[1]["debtor_identity_hash"]: {},
    }
    existing_debts = {
        (update.rows[0]["debtor_identity_hash"], update.rows[0]["debt_identity_hash"]): {
            "original_amount": "15000.00",
            "current_amount": "15000.00",
            "description": "Arancel marzo",
            "due_date": "2026-03-15",
        },
        (update.rows[1]["debtor_identity_hash"], update.rows[1]["debt_identity_hash"]): {
            "original_amount": "2500.00",
            "current_amount": "2500.00",
            "description": "Prestamo biblioteca",
            "due_date": "2026-03-20",
        },
    }
    existing_people = {
        update.rows[0]["person_identity_hash"]: {"full_name": "Estudiante ficticio Uno"},
        update.rows[1]["person_identity_hash"]: {"full_name": "Estudiante ficticio Dos"},
    }

    comparison = compare_multi_csv_rows(update, existing_debtors, existing_debts, existing_people)

    assert (comparison.inserted, comparison.updated, comparison.unchanged, comparison.rejected) == (1, 1, 1, 0)
    assert (comparison.debtor_new, comparison.people_new) == (1, 1)
