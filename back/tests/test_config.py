from ETL.config import get_settings, normalize_supabase_url


def test_normalize_supabase_url_removes_rest_endpoint_suffix():
    # Arrange
    configured_url = "https://example.supabase.co/rest/v1/"

    # Act
    normalized_url = normalize_supabase_url(configured_url)

    # Assert
    assert normalized_url == "https://example.supabase.co"


def test_normalize_supabase_url_preserves_base_project_url():
    # Arrange
    configured_url = " https://example.supabase.co/ "

    # Act
    normalized_url = normalize_supabase_url(configured_url)

    # Assert
    assert normalized_url == "https://example.supabase.co"


def test_get_settings_uses_normalized_supabase_url(monkeypatch):
    # Arrange
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/rest/v1/")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

    # Act
    settings = get_settings()

    # Assert
    assert settings.supabase_url == "https://example.supabase.co"
