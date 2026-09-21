CREATE TABLE IF NOT EXISTS autonomous_cycle_locks (
  lock_key varchar(100) PRIMARY KEY,
  owner_id varchar(100) NOT NULL,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
