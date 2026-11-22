import csv
from pathlib import Path
from typing import Any

from ETL.daily_csv_import import parse_daily_csv
from ETL.export_lafalda_csv_sample import (
    CSV_COLUMNS,
    export_lafalda_complete,
    export_lafalda_sample,
)


class FakeResponse:
    def __init__(self, data: list[dict[str, Any]], count: int | None = None) -> None:
        self.data = data
        self.count = count


class FakeQuery:
    def __init__(
        self,
        table_name: str,
        rows: list[dict[str, Any]],
        calls: list[tuple[str, int, int]],
        count_requests: list[str],
    ) -> None:
        self.table_name = table_name
        self.rows = rows
        self.calls = calls
        self.count_requests = count_requests
        self.tenant_id: int | None = None
        self.debtor_ids: set[int] | None = None
        self.offset = 0
        self.end = 0
        self.requests_count = False
        self.head = False

    def select(self, _columns: str, count: str | None = None, head: bool | None = None) -> "FakeQuery":
        self.requests_count = count == "exact"
        self.head = bool(head)
        return self

    def eq(self, column_name: str, value: int) -> "FakeQuery":
        if self.table_name == "debtor" and column_name == "tenant":
            self.tenant_id = value
        return self

    def in_(self, column_name: str, values: list[int]) -> "FakeQuery":
        if self.table_name == "debt" and column_name == "debtor":
            self.debtor_ids = set(values)
        return self

    def order(self, _column_name: str) -> "FakeQuery":
        return self

    def range(self, offset: int, end: int) -> "FakeQuery":
        self.offset = offset
        self.end = end
        return self

    def execute(self) -> FakeResponse:
        filtered_rows = self.rows
        if self.table_name == "debtor":
            filtered_rows = [row for row in filtered_rows if row["tenant"] == self.tenant_id]
        if self.table_name == "debt" and self.debtor_ids is not None:
            filtered_rows = [row for row in filtered_rows if row["debtor"] in self.debtor_ids]

        self.calls.append((self.table_name, self.offset, self.end))
        if self.requests_count:
            self.count_requests.append(self.table_name)
        data = [] if self.head else filtered_rows[self.offset : self.end + 1]
        return FakeResponse(data, count=len(filtered_rows) if self.requests_count else None)


class FakeSupabaseClient:
    def __init__(self, debtors: list[dict[str, Any]], debts: list[dict[str, Any]]) -> None:
        self.debtors = debtors
        self.debts = debts
        self.calls: list[tuple[str, int, int]] = []
        self.count_requests: list[str] = []

    def table(self, table_name: str) -> FakeQuery:
        rows = self.debtors if table_name == "debtor" else self.debts
        return FakeQuery(table_name, rows, self.calls, self.count_requests)


def test_export_lafalda_sample_paginates_and_generates_a_valid_import_csv(tmp_path: Path) -> None:
    # Arrange
    client = FakeSupabaseClient(
        debtors=[
            {"id": 10, "tenant": 1, "type": 1, "external_id": 101},
            {"id": 11, "tenant": 1, "type": 6, "external_id": 202},
            {"id": 12, "tenant": 1, "type": 1, "external_id": 303},
        ],
        debts=[
            {
                "id": 1,
                "external_id": 9001,
                "debtor": 10,
                "type": "inmuebles",
                "description": "Tasa municipal",
                "original_amount": 1000.5,
                "current_amount": 1200.75,
                "currency": 1,
                "issue_date": "2025-01-01",
                "due_date": "2025-02-01",
                "last_collection_date": "2025-03-01",
                "period": "2025-01",
                "status": 2,
            },
            {
                "id": 2,
                "external_id": 9002,
                "debtor": 10,
                "type": "inmuebles",
                "description": None,
                "original_amount": 250,
                "current_amount": 300,
                "currency": 1,
                "issue_date": None,
                "due_date": "2025-03-01",
                "last_collection_date": None,
                "period": "2025-02",
                "status": 2,
            },
            {
                "id": 3,
                "external_id": 9003,
                "debtor": 11,
                "type": "agua",
                "description": "Servicio de agua",
                "original_amount": 350,
                "current_amount": 400,
                "currency": 1,
                "issue_date": "2025-01-15",
                "due_date": "2025-02-15",
                "last_collection_date": "2025-03-15",
                "period": "2025-03",
                "status": 2,
            },
        ],
    )
    output_path = tmp_path / "lafalda_10000_prueba.csv"

    # Act
    result = export_lafalda_sample(
        client,
        output_path=output_path,
        sample_size=3,
        debtor_page_size=2,
        debt_page_size=2,
        debtor_chunk_size=1,
    )

    # Assert
    assert result.exported_rows == 3
    assert result.database_debt_count is None
    assert result.duplicate_keys_skipped == 0
    assert result.invalid_rows_skipped == 0
    assert result.file_size_bytes == output_path.stat().st_size
    assert ("debtor", 0, 1) in client.calls
    assert ("debtor", 2, 3) in client.calls

    with output_path.open("r", encoding="utf-8-sig", newline="") as exported_file:
        rows = list(csv.DictReader(exported_file))

    assert rows[0] == {
        "Bien_Tipo_Id": "1",
        "Cuenta": "101",
        "DEUD_id": "9001",
        "tipo_deuda": "inmuebles",
        "descripcion": "Tasa municipal",
        "NOTD_capital": "1000.5",
        "NOTD_totalActualizado": "1200.75",
        "NOTD_vencimiento": "2025-02-01",
        "fecha_emision": "2025-01-01",
        "fecha_ultima_gestion": "2025-03-01",
        "periodo": "2025-01",
        "estado": "2",
        "moneda": "1",
    }
    assert len(rows) == 3
    assert tuple(rows[1]) == CSV_COLUMNS
    assert not parse_daily_csv(output_path).errors


def test_export_lafalda_complete_matches_an_independent_database_count(tmp_path: Path) -> None:
    # Arrange
    client = FakeSupabaseClient(
        debtors=[{"id": 10, "tenant": 1, "type": 1, "external_id": 101}],
        debts=[
            {
                "id": 1,
                "external_id": 9001,
                "debtor": 10,
                "type": "inmuebles",
                "description": "Tasa municipal",
                "original_amount": 1000,
                "current_amount": 1200,
                "currency": 1,
                "issue_date": "2025-01-01",
                "due_date": "2025-02-01",
                "last_collection_date": "2025-03-01",
                "period": "2025-01",
                "status": 2,
            }
        ],
    )

    # Act
    result = export_lafalda_complete(client, output_path=tmp_path / "lafalda_completo_prueba.csv")

    # Assert
    assert result.exported_rows == 1
    assert result.database_debt_count == 1
    assert result.source_debt_rows_read == 1
    assert client.count_requests == ["debt"]
