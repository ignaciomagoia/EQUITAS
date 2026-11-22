from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = PROJECT_ROOT / "supabase" / "testing" / "lafalda_apply_fixture.sql"


def test_testing_fixture_is_kept_outside_production_migrations_and_is_guarded():
    # Arrange
    sql = FIXTURE_PATH.read_text(encoding="utf-8")

    # Act / Assert
    assert "EQUITAS-TP-TESTING" in sql
    assert "testing_prepare_lafalda_apply_fixture" in sql
    assert "testing_cleanup_lafalda_apply_fixture" in sql
    assert "update public.lafalda_import_control" in sql
    assert "delete from public.debtor where id = 1001" in sql
    assert "set apply_enabled = false" in sql
    assert "grant execute on function public.testing_prepare_lafalda_apply_fixture() to service_role" in sql
    assert not (PROJECT_ROOT / "supabase" / "migrations" / FIXTURE_PATH.name).exists()
