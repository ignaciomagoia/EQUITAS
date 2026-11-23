from pathlib import Path

import pytest

from ETL.daily_csv_import import compare_daily_csv_rows, parse_daily_csv

FIXTURE_DIRECTORY = Path(__file__).parent / "fixtures" / "csv"
EXPECTED_DEBTS = [
    (1, 3, 3195796, 70000.0),
    (1, 3, 3195795, 80000.0),
    (1, 3, 3195794, 90000.0),
]


@pytest.mark.parametrize(
    ("file_name", "expected_ignored_columns"),
    [
        ("lafalda_prueba_formato_original.csv", set()),
        (
            "lafalda_prueba_columnas_flexibles.csv",
            {f"Campo_externo_{index:02}" for index in range(1, 19)},
        ),
        (
            "lafalda_prueba_formato_excel.csv",
            {"Origen_Excel", "Campo_no_utilizado"},
        ),
    ],
)
def test_lafalda_csv_fixtures_parse_end_to_end(
    file_name: str,
    expected_ignored_columns: set[str],
) -> None:
    # Arrange
    file_path = FIXTURE_DIRECTORY / file_name

    # Act
    parsed = parse_daily_csv(file_path)

    # Assert
    assert parsed.total_rows == 3
    assert parsed.errors == []
    assert set(parsed.ignored_columns) == expected_ignored_columns
    assert [
        (
            row["debtor_type"],
            row["debtor_external_id"],
            row["debt_external_id"],
            row["current_amount"],
        )
        for row in parsed.stage_rows
    ] == EXPECTED_DEBTS
    assert all(row["provided_fields"] == ["current_amount"] for row in parsed.stage_rows)

    comparison = compare_daily_csv_rows(
        parsed,
        {(1, 3): 1},
        {
            (1, debt_external_id): {"current_amount": current_amount}
            for _, _, debt_external_id, current_amount in EXPECTED_DEBTS
        },
    )
    assert comparison.inserted == 0
    assert comparison.updated == 0
    assert comparison.unchanged == 3
    assert comparison.rejected == 0
