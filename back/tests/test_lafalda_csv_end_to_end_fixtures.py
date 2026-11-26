import pytest

from ETL.daily_csv_import import compare_daily_csv_rows, parse_daily_csv

EXPECTED_DEBTS = [
    (1, 3, 1001, 70000.0),
    (1, 3, 1002, 80000.0),
    (1, 3, 1003, 90000.0),
]

CSV_FIXTURES = {
    "lafalda_prueba_formato_original.csv": (
        "Bien_Tipo_Id,Cuenta,DEUD_id,NOTD_totalActualizado\n"
        "1,3,1001,70000\n"
        "1,3,1002,80000\n"
        "1,3,1003,90000\n"
    ),
    "lafalda_prueba_columnas_flexibles.csv": (
        "Campo_externo_01,Saldo Actualizado,Campo_externo_02,DEUDA ID,Campo_externo_03,BIEN TIPO ID,Campo_externo_04,Nro Cuenta,Campo_externo_05,Campo_externo_06,Campo_externo_07,Campo_externo_08,Campo_externo_09,Campo_externo_10,Campo_externo_11,Campo_externo_12,Campo_externo_13,Campo_externo_14,Campo_externo_15,Campo_externo_16,Campo_externo_17,Campo_externo_18\n"
        "prueba-a,70000,origen-a,1001,lote-a,1,control-a,3,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a,x-a\n"
        "prueba-b,80000,origen-b,1002,lote-b,1,control-b,3,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b,x-b\n"
        "prueba-c,90000,origen-c,1003,lote-c,1,control-c,3,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c,x-c\n"
    ),
    "lafalda_prueba_formato_excel.csv": (
        "Origen_Excel;DEUDA ID;Nro Cuenta;BIEN TIPO ID;Saldo Actualizado;Campo_no_utilizado\n"
        "exportacion-excel;1001;3;1;70000;prueba\n"
        "exportacion-excel;1002;3;1;80000;prueba\n"
        "exportacion-excel;1003;3;1;90000;prueba\n"
    ),
}


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
    tmp_path,
) -> None:
    # Arrange
    file_path = tmp_path / file_name
    file_path.write_text(CSV_FIXTURES[file_name], encoding="utf-8")

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
