from pathlib import Path

import pandas as pd

from ETL.daily_csv_import import (
    build_daily_stage_rows,
    compare_daily_csv_rows,
    parse_daily_csv,
    stage_row_to_debt_payload,
)
from ETL.transform import build_daily_csv_debt_payload

TEST_DATA_DIR = Path(__file__).resolve().parents[1] / "ETL" / "test_data"


def _existing_debts_from_first_file():
    first_day = parse_daily_csv(TEST_DATA_DIR / "lafalda_dia_1_basado_en_supabase.csv")
    debtor_ids_by_key = {
        (int(row["debtor_type"]), int(row["debtor_external_id"])): 1
        for row in first_day.stage_rows
    }
    existing_debts_by_key = {
        (1, int(row["debt_external_id"])): stage_row_to_debt_payload(row, 1)
        for row in first_day.stage_rows
    }

    return debtor_ids_by_key, existing_debts_by_key


def test_daily_csv_ignores_extra_columns_and_preserves_expected_rows():
    # Arrange
    file_path = TEST_DATA_DIR / "lafalda_dia_2_actualizado_prueba.csv"

    # Act
    result = parse_daily_csv(file_path)

    # Assert
    assert result.total_rows == 16
    assert len(result.stage_rows) == 16
    assert result.errors == []
    assert result.ignored_columns == ["columna_extra_ignorar"]


def test_daily_csv_second_file_detects_new_modified_and_unchanged_debts():
    # Arrange
    debtor_ids_by_key, existing_debts_by_key = _existing_debts_from_first_file()
    second_day = parse_daily_csv(TEST_DATA_DIR / "lafalda_dia_2_actualizado_prueba.csv")

    # Act
    comparison = compare_daily_csv_rows(second_day, debtor_ids_by_key, existing_debts_by_key)

    # Assert
    assert comparison.inserted == 1
    assert comparison.updated == 3
    assert comparison.unchanged == 12
    assert comparison.rejected == 0
    assert comparison.unknown_debtors == 0


def test_daily_csv_rejects_duplicate_debt_in_the_same_file():
    # Arrange
    rows = [
        {
            "Bien_Tipo_Id": "1",
            "Cuenta": "3",
            "DEUD_id": "100",
            "NOTD_capital": "10",
            "NOTD_totalActualizado": "12",
        },
        {
            "Bien_Tipo_Id": "1",
            "Cuenta": "3",
            "DEUD_id": "100",
            "NOTD_capital": "10",
            "NOTD_totalActualizado": "12",
        },
    ]

    # Act
    result = build_daily_stage_rows(pd.DataFrame(rows))

    # Assert
    assert len(result.stage_rows) == 1
    assert len(result.errors) == 1
    assert result.errors[0].source_row == 3
    assert result.errors[0].code == "INVALID_ROW"


def test_daily_csv_stages_missing_amounts_as_not_provided_for_later_validation():
    # Arrange
    row = {
        "Bien_Tipo_Id": "1",
        "Cuenta": "3",
        "DEUD_id": "100",
        "NOTD_capital": "",
        "NOTD_totalActualizado": "12",
    }

    # Act
    result = build_daily_stage_rows(pd.DataFrame([row]))

    # Assert
    assert result.errors == []
    assert len(result.stage_rows) == 1
    assert result.stage_rows[0]["original_amount"] is None
    assert "original_amount" not in result.stage_rows[0]["provided_fields"]


def test_daily_csv_rejects_incomplete_new_debt_during_comparison():
    # Arrange
    parsed = build_daily_stage_rows(
        pd.DataFrame(
            [
                {
                    "Bien_Tipo_Id": "1",
                    "Cuenta": "3",
                    "DEUD_id": "100",
                    "NOTD_totalActualizado": "12",
                }
            ]
        )
    )

    # Act
    comparison = compare_daily_csv_rows(parsed, {(1, 3): 1}, {})

    # Assert
    assert comparison.inserted == 0
    assert comparison.rejected == 1


def test_daily_csv_updates_existing_debt_without_overwriting_missing_amounts():
    # Arrange
    parsed = build_daily_stage_rows(
        pd.DataFrame(
            [
                {
                    "Bien_Tipo_Id": "1",
                    "Cuenta": "3",
                    "DEUD_id": "100",
                    "descripcion": "Descripcion actualizada",
                }
            ]
        )
    )
    existing_debt = {
        "external_id": 100,
        "debtor": 1,
        "description": "Descripcion anterior",
        "original_amount": 10,
        "current_amount": 12,
    }

    # Act
    comparison = compare_daily_csv_rows(parsed, {(1, 3): 1}, {(1, 100): existing_debt})

    # Assert
    assert comparison.updated == 1
    assert comparison.rejected == 0
    assert parsed.stage_rows[0]["provided_fields"] == ["description"]


def test_daily_debt_payload_does_not_invent_optional_values_or_amounts():
    # Arrange
    row = {
        "DEUD_id": "100",
        "NOTD_capital": "",
        "NOTD_totalActualizado": "",
    }

    # Act
    payload = build_daily_csv_debt_payload(row)

    # Assert
    assert payload["description"] is None
    assert payload["original_amount"] is None
    assert payload["current_amount"] is None
    assert payload["currency"] is None
    assert payload["status"] is None
