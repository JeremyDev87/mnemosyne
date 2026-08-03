CREATE TABLE storage_budget_leases (
  prefix TEXT PRIMARY KEY,
  lease_owner TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0 CHECK (lease_expires_at >= 0),
  logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  receipt_at INTEGER NOT NULL DEFAULT 0 CHECK (receipt_at >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0),
  CHECK (lease_owner IS NULL OR lease_expires_at > 0)
);
