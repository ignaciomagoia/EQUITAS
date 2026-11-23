from __future__ import annotations

from io import StringIO

import pandas as pd
import pytest

from ETL.daily_csv_import import (
    build_daily_stage_rows,
    compare_daily_csv_rows,
    parse_daily_csv_bytes,
)


def _base_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "Bien_Tipo_Id": "1",
        "Cuenta": "700001",
        "DEUD_id": "900001",
        "NOTD_capital": "1000,50",
        "NOTD_totalActualizado": "1250,75",
        "tipo_deuda": "Tasa municipal",
        "descripcion": "Obligacion de prueba",
        "NOTD_vencimiento": "31/01/2026",
        "fecha_emision": "01/01/2026",
        "fecha_ultima_gestion": "15/02/2026",
        "periodo": "2026-01",
        "estado": "2",
        "moneda": "1",
    }
    row.update(overrides)
    return row


def _csv_bytes(
    rows: list[dict[str, object]],
    *,
    columns: list[str] | None = None,
    separator: str = ",",
    encoding: str = "utf-8-sig",
) -> bytes:
    output = StringIO()
    pd.DataFrame(rows, columns=columns).to_csv(output, index=False, sep=separator, lineterminator="\r\n")
    return output.getvalue().encode(encoding)


def _existing_debt() -> dict[str, object]:
    return {
        "external_id": 900001,
        "debtor": 44,
        "type": "Tasa municipal",
        "description": "Descripcion existente",
        "original_amount": 1000.5,
        "current_amount": 1250.75,
        "currency": 1,
        "issue_date": "2026-01-01",
        "due_date": "2026-01-31",
        "last_collection_date": "2026-02-15",
        "period": "2026-01",
        "status": 2,
    }


def test_accepts_five_columns_when_the_stable_key_and_amounts_are_present() -> None:
    # Arrange
    row = _base_row()
    columns = [
        "Bien_Tipo_Id",
        "Cuenta",
        "DEUD_id",
        "NOTD_capital",
        "NOTD_totalActualizado",
    ]

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], columns=columns))

    # Assert
    assert parsed.errors == []
    assert parsed.ignored_columns == []
    assert parsed.stage_rows[0]["original_amount"] == 1000.5
    assert parsed.stage_rows[0]["current_amount"] == 1250.75


def test_accepts_fifteen_columns_and_ignores_unknown_ones() -> None:
    # Arrange
    row = _base_row(campo_municipal_a="A", campo_municipal_b="B")
    columns = list(_base_row()) + ["campo_municipal_a", "campo_municipal_b"]

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], columns=columns))

    # Assert
    assert len(columns) == 15
    assert parsed.errors == []
    assert parsed.ignored_columns == ["campo_municipal_a", "campo_municipal_b"]


def test_accepts_more_than_thirty_columns_and_ignores_all_unknown_ones() -> None:
    # Arrange
    extra_columns = [f"campo_desconocido_{index}" for index in range(1, 22)]
    row = _base_row(**{column: f"valor-{index}" for index, column in enumerate(extra_columns, start=1)})
    columns = list(_base_row()) + extra_columns

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], columns=columns))

    # Assert
    assert len(columns) == 34
    assert parsed.errors == []
    assert set(parsed.ignored_columns) == set(extra_columns)


def test_optional_columns_can_be_missing_without_marking_an_existing_debt_as_changed() -> None:
    # Arrange
    parsed = build_daily_stage_rows(
        pd.DataFrame(
            [
                {
                    "Bien_Tipo_Id": "1",
                    "Cuenta": "700001",
                    "DEUD_id": "900001",
                }
            ]
        )
    )

    # Act
    comparison = compare_daily_csv_rows(
        parsed,
        {(1, 700001): 44},
        {(44, 900001): _existing_debt()},
    )

    # Assert
    assert parsed.stage_rows[0]["provided_fields"] == []
    assert comparison.unchanged == 1
    assert comparison.updated == 0
    assert comparison.rejected == 0


def test_column_order_does_not_change_the_parsed_result() -> None:
    # Arrange
    row = _base_row()
    columns = list(reversed(list(row)))

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], columns=columns))

    # Assert
    assert parsed.errors == []
    stage_row = parsed.stage_rows[0]
    assert stage_row["debtor_type"] == 1
    assert stage_row["debtor_external_id"] == 700001
    assert stage_row["debt_external_id"] == 900001
    assert stage_row["due_date"] == "2026-01-31"


def test_accepts_case_space_accent_and_explicit_header_aliases() -> None:
    # Arrange
    row = {
        " BIÉN TIPO ID ": "1",
        "NRO CUENTA": "700001",
        "DEUDA ID": "900001",
        "CAPITAL": "100",
        "SALDO ACTUALIZADO": "120",
        "DESCRIPCIÓN": "Deuda exportada desde Excel",
    }

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row]))

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["debtor_type"] == 1
    assert parsed.stage_rows[0]["debtor_external_id"] == 700001
    assert parsed.stage_rows[0]["debt_external_id"] == 900001
    assert parsed.stage_rows[0]["description"] == "Deuda exportada desde Excel"


def test_accepts_semicolon_delimited_excel_csv() -> None:
    # Arrange
    row = _base_row()

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], separator=";"))

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["current_amount"] == 1250.75


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig"])
def test_accepts_utf8_excel_style_csv_with_quoted_text_and_day_first_dates(encoding: str) -> None:
    # Arrange
    row = _base_row(descripcion="Tasa municipal, periodo enero", NOTD_capital="1.234,50")

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row], encoding=encoding))

    # Assert
    assert parsed.errors == []
    stage_row = parsed.stage_rows[0]
    assert stage_row["description"] == "Tasa municipal, periodo enero"
    assert stage_row["original_amount"] == 1234.5
    assert stage_row["issue_date"] == "2026-01-01"


def test_accepts_lowercase_snake_case_original_headers() -> None:
    # Arrange
    row = {
        "bien_tipo_id": "1",
        "cuenta": "700001",
        "deud_id": "900001",
        "notd_capital": "100",
        "notd_totalactualizado": "120",
    }

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([row]))

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["debtor_type"] == 1
    assert parsed.stage_rows[0]["current_amount"] == 120.0


def test_accepts_windows_1252_excel_csv() -> None:
    # Arrange
    row = _base_row(descripcion="Obligacion con ñ")
    content = _csv_bytes([row], encoding="cp1252")

    # Act
    parsed = parse_daily_csv_bytes(content)

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["description"] == row["descripcion"]


def test_rejects_unknown_encoding_without_replacing_characters() -> None:
    # Arrange
    content = b"\x81"

    # Act / Assert
    with pytest.raises(ValueError, match="UTF-8"):
        parse_daily_csv_bytes(content)


def test_rejects_ambiguous_headers_that_map_to_the_same_field() -> None:
    # Arrange
    row = _base_row(**{"Nro Cuenta": "700002"})

    # Act / Assert
    with pytest.raises(ValueError, match="encabezados ambiguos: Cuenta"):
        parse_daily_csv_bytes(_csv_bytes([row]))


def test_empty_optional_values_preserve_the_existing_debt_during_comparison() -> None:
    # Arrange
    parsed = build_daily_stage_rows(
        pd.DataFrame(
            [
                {
                    "Bien_Tipo_Id": "1",
                    "Cuenta": "700001",
                    "DEUD_id": "900001",
                    "descripcion": "",
                    "NOTD_capital": "",
                    "NOTD_totalActualizado": "",
                    "NOTD_vencimiento": "",
                }
            ]
        )
    )

    # Act
    comparison = compare_daily_csv_rows(
        parsed,
        {(1, 700001): 44},
        {(44, 900001): _existing_debt()},
    )

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["provided_fields"] == []
    assert comparison.unchanged == 1


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        ("1234", 1234.0),
        ("1234,50", 1234.5),
        ("1234.50", 1234.5),
        ("1.234,50", 1234.5),
        ("1,234.50", 1234.5),
        ("1.234.567,89", 1234567.89),
        ("1,234,567.89", 1234567.89),
    ],
)
def test_accepts_unambiguous_amount_formats(amount: str, expected: float) -> None:
    # Arrange
    row = _base_row(NOTD_capital=amount)

    # Act
    parsed = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["original_amount"] == expected


@pytest.mark.parametrize("amount", ["1.234", "1,234", "12.34.56"])
def test_rejects_ambiguous_or_invalid_amount_formats(amount: str) -> None:
    # Arrange
    row = _base_row(NOTD_capital=amount)

    # Act
    parsed = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert parsed.stage_rows == []
    assert "formato de importe ambiguo" in parsed.errors[0].message


@pytest.mark.parametrize(
    ("date_value", "expected"),
    [
        ("2026-02-13", "2026-02-13"),
        ("2026/02/13", "2026-02-13"),
        ("13/02/2026", "2026-02-13"),
        ("13-02-2026", "2026-02-13"),
    ],
)
def test_accepts_unambiguous_date_formats(date_value: str, expected: str) -> None:
    # Arrange
    row = _base_row(NOTD_vencimiento=date_value)

    # Act
    parsed = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert parsed.errors == []
    assert parsed.stage_rows[0]["due_date"] == expected


def test_rejects_ambiguous_day_month_date() -> None:
    # Arrange
    row = _base_row(NOTD_vencimiento="01/02/2026")

    # Act
    parsed = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert parsed.stage_rows == []
    assert "fecha ambigua" in parsed.errors[0].message


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("NOTD_capital", "12.3.4", "formato de importe ambiguo"),
        ("NOTD_totalActualizado", "-10", "NOTD_totalActualizado debe ser un importe no negativo"),
        ("NOTD_vencimiento", "fecha-invalida", "NOTD_vencimiento no es una fecha"),
    ],
)
def test_rejects_invalid_amounts_and_dates(field: str, value: str, message: str) -> None:
    # Arrange
    row = _base_row(**{field: value})

    # Act
    parsed = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert parsed.stage_rows == []
    assert len(parsed.errors) == 1
    assert message in parsed.errors[0].message


def test_rejects_duplicate_stable_debt_key_in_a_csv_file() -> None:
    # Arrange
    first = _base_row()
    duplicate = _base_row(descripcion="Duplicada")

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes([first, duplicate]))

    # Assert
    assert len(parsed.stage_rows) == 1
    assert len(parsed.errors) == 1
    assert parsed.errors[0].source_row == 3
    assert "se repite" in parsed.errors[0].message


def test_parses_fifty_six_thousand_synthetic_rows_without_database_access() -> None:
    # Arrange
    row_count = 56_000
    rows = [
        {
            "Bien_Tipo_Id": "1",
            "Cuenta": str(800_000 + index),
            "DEUD_id": str(9_000_000 + index),
            "NOTD_capital": "100",
            "NOTD_totalActualizado": "125",
        }
        for index in range(row_count)
    ]

    # Act
    parsed = parse_daily_csv_bytes(_csv_bytes(rows))

    # Assert
    assert parsed.total_rows == row_count
    assert len(parsed.stage_rows) == row_count
    assert parsed.errors == []
    assert parsed.stage_rows[-1]["debt_external_id"] == 9_055_999
