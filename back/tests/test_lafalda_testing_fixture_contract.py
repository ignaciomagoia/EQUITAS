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
    assert "returns jsonb" in sql
    assert "drop function if exists public.testing_prepare_lafalda_apply_fixture();" in sql
    assert "update public.lafalda_import_control" in sql
    assert "where requested_by = v_fixture_user_id" in sql
    assert "where code = 'ARS'" in sql
    assert "insert into public.currency" not in sql
    assert "insert into public.role" not in sql
    assert "insert into public.debtor_type" not in sql
    assert "insert into public.debt_status" not in sql
    assert "insert into public.contact_type" not in sql
    assert "insert into public.tenant (" not in sql
    assert "delete from public.data_import_job where tenant = 1" not in sql
    assert "previous_apply_enabled" in sql
    assert "Colision con relaciones o perfiles ajenos al fixture." in sql
    assert "grant execute on function public.testing_prepare_lafalda_apply_fixture() to service_role" in sql
    assert not (PROJECT_ROOT / "supabase" / "migrations" / FIXTURE_PATH.name).exists()
