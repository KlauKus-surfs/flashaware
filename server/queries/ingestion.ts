import { getOne } from '../db';

export interface IngestionRecord {
  id: number;
  product_id: string;
  product_time_start: string;
  product_time_end: string;
  flash_count: number;
  file_size_bytes: number | null;
  download_ms: number | null;
  parse_ms: number | null;
  ingested_at: string;
  qc_status: string;
  trail_data: any;
}

export async function addIngestionRecord(record: Omit<IngestionRecord, 'id'>): Promise<number> {
  const result = await getOne<{ id: number }>(
    `INSERT INTO ingestion_log (
      product_id, product_time_start, product_time_end, flash_count,
      file_size_bytes, download_ms, parse_ms, ingested_at, qc_status, trail_data
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      record.product_id,
      record.product_time_start,
      record.product_time_end,
      record.flash_count,
      record.file_size_bytes,
      record.download_ms,
      record.parse_ms,
      record.ingested_at,
      record.qc_status,
      record.trail_data ? JSON.stringify(record.trail_data) : null,
    ],
  );
  if (!result) throw new Error('Failed to add ingestion record');
  return result.id;
}

export async function getLatestIngestionTime(): Promise<Date | null> {
  const result = await getOne<{ latest: Date }>(
    "SELECT MAX(product_time_end) AS latest FROM ingestion_log WHERE qc_status != 'ERROR'",
  );
  return result?.latest || null;
}
