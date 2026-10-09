import type { ColumnType, Generated } from "kysely";

export type ProcessingStatus = "pending" | "processing" | "processed" | "failed";

export interface RawEventsTable {
  id: Generated<number>;
  received_at: ColumnType<Date, Date | undefined, never>;
  auth_header_name: ColumnType<string | null, string | null | undefined, string | null>;
  payload: ColumnType<unknown, string, string>;
  processing_status: ColumnType<ProcessingStatus, ProcessingStatus | undefined, ProcessingStatus>;
  processed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  processing_error: ColumnType<string | null, string | null | undefined, string | null>;
  attempt_count: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  claimed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface TracesTable {
  id: Generated<string>;
  openrouter_trace_id: string;
  otel_trace_id: string | null;
  service_name: string | null;
  trace_name: string | null;
  tags: unknown | null;
  metadata: unknown | null;
  session_id: string | null;
  user_id: string | null;
  entity_id: string | null;
  api_key_name: string | null;
  provider_name: string | null;
  provider_slug: string | null;
  environment: string | null;
  source: string | null;
  received_at: ColumnType<Date, Date | undefined, never>;
  raw_event_id: ColumnType<number | null, number | null | undefined, number | null>;
}

export interface LlmGenerationsTable {
  id: Generated<string>;
  trace_id: string;
  span_id: string;
  otel_trace_id: string | null;
  name: string | null;
  kind: number | null;
  status_code: number | null;
  span_type: string | null;
  span_level: string | null;
  start_time: Date | null;
  end_time: Date | null;
  duration_ms: number | null;
  operation_name: string | null;
  system: string | null;
  provider_name: string | null;
  request_model: string | null;
  response_model: string | null;
  response_id: string | null;
  finish_reason: string | null;
  finish_reasons: unknown | null;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  input_cost: number | null;
  output_cost: number | null;
  total_cost: number | null;
  input_unit_price: number | null;
  output_unit_price: number | null;
  prompt: unknown | null;
  completion: unknown | null;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface UsageDailyTable {
  day: ColumnType<string, string, never>;
  model: ColumnType<string, string, never>;
  calls: ColumnType<string, number | string | undefined, never>;
  input_tokens: ColumnType<string, number | string | undefined, never>;
  output_tokens: ColumnType<string, number | string | undefined, never>;
  cached_tokens: ColumnType<string, number | string | undefined, never>;
  reasoning_tokens: ColumnType<string, number | string | undefined, never>;
  total_tokens: ColumnType<string, number | string | undefined, never>;
  total_cost: ColumnType<string, number | string | undefined, never>;
  avg_duration_ms: ColumnType<number | null, number | null | undefined, never>;
  p50_duration_ms: ColumnType<string | null, number | string | null | undefined, never>;
  p95_duration_ms: ColumnType<string | null, number | string | null | undefined, never>;
  status_counts: ColumnType<unknown | null, unknown | null | undefined, never>;
  finish_reason_counts: ColumnType<unknown | null, unknown | null | undefined, never>;
  provider_counts: ColumnType<unknown | null, unknown | null | undefined, never>;
  response_model_counts: ColumnType<unknown | null, unknown | null | undefined, never>;
  prompt_chars: ColumnType<string | null, number | string | null | undefined, never>;
  completion_chars: ColumnType<string | null, number | string | null | undefined, never>;
}

export interface UsageHourlyTable {
  hour: ColumnType<Date, Date | string, never>;
  model: ColumnType<string, string, never>;
  calls: ColumnType<string, number | string | undefined, never>;
  input_tokens: ColumnType<string, number | string | undefined, never>;
  output_tokens: ColumnType<string, number | string | undefined, never>;
  cached_tokens: ColumnType<string, number | string | undefined, never>;
  reasoning_tokens: ColumnType<string, number | string | undefined, never>;
  total_tokens: ColumnType<string, number | string | undefined, never>;
  total_cost: ColumnType<string, number | string | undefined, never>;
}

export interface Database {
  raw_events: RawEventsTable;
  traces: TracesTable;
  llm_generations: LlmGenerationsTable;
  usage_daily: UsageDailyTable;
  usage_hourly: UsageHourlyTable;
}
