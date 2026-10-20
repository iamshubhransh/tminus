/**
 * Ordered schema migrations. Never edit a shipped migration; append a new one.
 * All timestamps are epoch milliseconds.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        project_path_hash TEXT,
        model TEXT,
        started_at INTEGER
      );

      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        ext_id TEXT,
        submitted_at INTEGER NOT NULL,
        finished_at INTEGER,
        active_ms INTEGER,
        idle_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        model TEXT,
        effort TEXT,
        mode TEXT,
        context_pct REAL,
        features_json TEXT,
        predicted_p50_ms INTEGER,
        predicted_p90_ms INTEGER,
        source TEXT NOT NULL CHECK (source IN ('live', 'backfill'))
      );
      CREATE UNIQUE INDEX turns_ext ON turns (agent, session_id, ext_id);
      CREATE INDEX turns_submitted ON turns (submitted_at);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER REFERENCES turns (id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        tool_name TEXT,
        meta_json TEXT
      );
      CREATE INDEX events_turn ON events (turn_id, ts);

      CREATE TABLE predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        p50_remaining_ms INTEGER NOT NULL,
        p90_remaining_ms INTEGER NOT NULL,
        signal_weights_json TEXT
      );
      CREATE INDEX predictions_turn ON predictions (turn_id, ts);
    `,
  },
  {
    // Lower bound of the displayed range, which predictor produced the numbers,
    // and summary counts that the live activity signal learns from.
    version: 2,
    sql: `
      ALTER TABLE turns ADD COLUMN predicted_p10_ms INTEGER;
      ALTER TABLE turns ADD COLUMN predictor TEXT;
      ALTER TABLE turns ADD COLUMN trigger TEXT;
      ALTER TABLE turns ADD COLUMN tool_calls INTEGER;
      ALTER TABLE turns ADD COLUMN todo_total INTEGER;
      ALTER TABLE turns ADD COLUMN agent_duration_ms INTEGER;
    `,
  },
  {
    // Tool calls made inside subagents during the turn (counted as work by the activity signal).
    version: 3,
    sql: `ALTER TABLE turns ADD COLUMN subagent_tool_calls INTEGER;`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
