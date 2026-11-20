-- The app connects as a NON-owner role so that FORCE ROW LEVEL SECURITY applies (spec §11.5).
-- Migrations run as relayon_owner. Dev-only passwords.
CREATE ROLE relayon_app LOGIN PASSWORD 'relayon_app' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE relayon TO relayon_app;
