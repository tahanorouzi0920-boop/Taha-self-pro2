CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('points_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('games_enabled', '1');
