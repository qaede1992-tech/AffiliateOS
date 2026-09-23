ALTER TABLE autonomous_feedback_snapshots ADD COLUMN anomaly varchar(10) NOT NULL DEFAULT 'none';
ALTER TABLE autonomous_feedback_snapshots ADD COLUMN anomaly_score real NOT NULL DEFAULT 0;