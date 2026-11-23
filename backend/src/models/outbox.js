import { summaryEventSchema } from "@finosauras/shared";
import { decodeJson } from "./queries.js";

// REST replay and WebSocket delivery share the same durable event queries.
const inMode = `json_extract(payload_json,'$.data_mode') = ?`;
export function latestEventId(db, mode) {
  return db
    .prepare(`SELECT coalesce(max(id),0) FROM outbox_events WHERE ${inMode}`)
    .pluck()
    .get(mode);
}
export function eventsAfter(db, mode, after, size) {
  return db
    .prepare(
      `SELECT payload_json FROM outbox_events WHERE ${inMode} AND id > ? ORDER BY id LIMIT ?`,
    )
    .pluck()
    .all(mode, after, size)
    .map((payload) => decodeJson(summaryEventSchema, payload));
}
