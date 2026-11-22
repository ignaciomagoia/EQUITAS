from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_PATH = PROJECT_ROOT / "supabase" / "testing" / "lafalda_apply_fixture.sql"
CATALOGS_PATH = PROJECT_ROOT / "supabase" / "testing" / "lafalda_apply_fixture_catalogs.sql"
DIAGNOSTIC_PATH = PROJECT_ROOT / "supabase" / "testing" / "diagnostico_lafalda_apply_fixture.sql"


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
    assert "where name = 'equitastp_fixture_importer'" in sql
    assert "where key = 'equitastp_fixture_debtor_type'" in sql
    assert "where key = 'equitastp_fixture_contact'" in sql
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


def test_testing_catalog_bootstrap_only_adds_missing_fixture_dependencies():
    # Arrange
    sql = CATALOGS_PATH.read_text(encoding="utf-8")

    # Act / Assert
    assert "equitastp_fixture_importer" in sql
    assert "equitastp_fixture_debtor_type" in sql
    assert "equitastp_fixture_contact" in sql
    assert "where code = 'ARS'" in sql
    assert "where id = 2" in sql
    assert "on conflict (id) do nothing" in sql
    assert "delete from" not in sql.lower()
    assert "update public.role" not in sql.lower()
    assert "update public.debtor_type" not in sql.lower()
    assert "update public.currency" not in sql.lower()
    assert "update public.debt_status" not in sql.lower()
    assert "update public.contact_type" not in sql.lower()


def test_testing_diagnostic_is_read_only_and_covers_worker_dependencies():
    # Arrange
    sql = DIAGNOSTIC_PATH.read_text(encoding="utf-8").lower()

    # Act / Assert
    assert "lafalda-imports" in sql
    assert "apply_lafalda_import_stage" in sql
    assert "data_import_authorization" in sql
    assert "falta_tabla" in sql
    assert "falta_registro" in sql
    assert "falta_funcion" in sql
    assert "sin_permiso_service_role" in sql
    assert "insert into" not in sql
    assert "update " not in sql
    assert "delete from" not in sql
    assert "create " not in sql
