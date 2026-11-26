from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = PROJECT_ROOT / "supabase" / "multiinstitution" / "migrations" / "20261123091600_multi_import_apply.sql"
CLAIM_LOCK_FIX_MIGRATION = PROJECT_ROOT / "supabase" / "multiinstitution" / "migrations" / "20261123091700_multi_import_claim_lock_fix.sql"


def test_apply_migration_keeps_database_writes_blocked_until_three_controls_allow_them():
    sql = MIGRATION.read_text(encoding="utf-8")

    assert "guard_multiinstitution_apply_job" in sql
    assert "authorization_row.can_apply" in sql
    assert "control.apply_enabled" in sql
    assert "simulation_job_id" in sql
    assert "rejected_rows <> 0" in sql
    assert "No se puede convertir una simulacion existente" in sql


def test_apply_migration_uses_the_previous_simulation_and_has_recovery_without_remerge():
    sql = MIGRATION.read_text(encoding="utf-8")

    assert "apply_multiinstitution_import_stage" in sql
    assert "recalculate_multiinstitution_import_profiles" in sql
    assert "job.merge_completed_at is not null" in sql
    assert "RECALCULATING_PROFILES" in sql
    assert "on conflict (institution_id, debtor_id, identity_scheme_id, identity_hash) do nothing" in sql
    assert "on conflict (institution_id, debtor_id) do update" in sql
    assert "security definer" in sql
    assert "set search_path = public, pg_temp" in sql


def test_claim_lock_fix_locks_only_import_jobs_when_recovery_uses_left_joins():
    sql = CLAIM_LOCK_FIX_MIGRATION.read_text(encoding="utf-8")

    assert "left join public.import_authorization" in sql
    assert "for update of job skip locked" in sql
    assert "for update skip locked" not in sql
    assert "recalculate_multiinstitution_import_profiles" not in sql
    assert "security definer" in sql
    assert "set search_path = public, pg_temp" in sql
