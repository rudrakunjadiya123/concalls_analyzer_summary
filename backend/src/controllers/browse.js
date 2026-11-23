import { z } from "zod";
import { utcInstantSchema } from "@finosauras/shared";
import { createBrowseModel } from "../models/browse.js";
import { eventsAfter, latestEventId } from "../models/outbox.js";
import { PipelineError } from "../utils/errors.js";
import { systemClock, utcIso } from "../utils/clock.js";

const uuid = z.uuid();
const integer = (max) =>
  z.string().regex(/^\d+$/u).transform(Number).pipe(z.int().min(0).max(max));
const limit = integer(100)
  .refine((value) => value >= 1)
  .default(20);
const cursor = z
  .string()
  .regex(/^[\w-]{1,700}$/u)
  .optional();
const collection = { limit, cursor };
const companyQuery = z.strictObject({
  ...collection,
  sector: z.string().trim().min(1).max(80).optional(),
});
const summariesQuery = z.strictObject({
  ...collection,
  company_id: uuid.optional(),
  include_superseded: z.enum(["true", "false"]).default("false"),
});
const historyQuery = z.strictObject(collection);
const eventsQuery = z.strictObject({
  limit,
  after_id: integer(Number.MAX_SAFE_INTEGER).default(0),
});
const noQuery = z.strictObject({});
const badRequest = () =>
  new PipelineError("BAD_REQUEST", undefined, { statusCode: 400 });

function read(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw badRequest();
  return result.data;
}

const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function readCursor(token, scope, keySchema) {
  if (!token) return { key: null, id: null };
  try {
    const [kind, key, id] = z
      .tuple([z.literal(scope), keySchema, uuid])
      .parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    if (encode([kind, key, id]) !== token) throw badRequest();
    return { key, id };
  } catch {
    throw badRequest();
  }
}

function page(rows, size, scope, keyField) {
  const values = rows.slice(0, size);
  const last = values.at(-1);
  return {
    values,
    next: rows.length > size ? encode([scope, last[keyField], last.id]) : null,
  };
}

/** Validate HTTP input and format browse responses around the shared read model. */
export function createBrowseController(options) {
  const { db, mode, clock = systemClock } = options;
  const model = createBrowseModel({ ...options, clock });
  const object = (res, data) =>
    res.json({ data, meta: { mode, generated_at: utcIso(clock.now()) } });
  const list = (res, values, next, size) =>
    res.json({
      data: values,
      pagination: { next_cursor: next, limit: size },
      meta: { mode },
    });
  function history(res, query, companyId, includeHistory) {
    const scope = `summaries:${mode}:${companyId ?? "*"}:${Number(includeHistory)}`;
    const position = readCursor(query.cursor, scope, utcInstantSchema);
    const rows = model.history({
      companyId,
      includeHistory,
      key: position.key,
      after: position.id,
      size: query.limit + 1,
    });
    const result = page(rows, query.limit, scope, "published_at");
    return list(res, result.values, result.next, query.limit);
  }

  return {
    status(req, res) {
      read(noQuery, req.query);
      object(res, model.status());
    },
    watchlist(req, res) {
      read(noQuery, req.query);
      object(res, model.watchlist());
    },
    companies(req, res) {
      const query = read(companyQuery, req.query);
      const scope = `companies:${mode}:${query.sector ?? "*"}`;
      const position = readCursor(
        query.cursor,
        scope,
        z.string().min(1).max(256),
      );
      const rows = model.companies({
        sector: query.sector,
        key: position.key,
        after: position.id,
        size: query.limit + 1,
      });
      const result = page(rows, query.limit, scope, "display_name");
      list(res, result.values.map(model.companyCard), result.next, query.limit);
    },
    company(req, res) {
      read(noQuery, req.query);
      object(res, model.company(read(uuid, req.params.id)));
    },
    companySummaries(req, res) {
      const id = read(uuid, req.params.id);
      model.requireCompany(id);
      history(res, read(historyQuery, req.query), id, true);
    },
    summaries(req, res) {
      const query = read(summariesQuery, req.query);
      history(
        res,
        query,
        query.company_id,
        query.include_superseded === "true",
      );
    },
    summary(req, res) {
      read(noQuery, req.query);
      object(res, model.detail(read(uuid, req.params.id)));
    },
    markdown(req, res) {
      read(noQuery, req.query);
      res
        .type("text/markdown")
        .send(model.detail(read(uuid, req.params.id)).markdown);
    },
    evidence(req, res) {
      read(noQuery, req.query);
      object(res, model.evidence(read(uuid, req.params.id)));
    },
    latestEvent(req, res) {
      read(noQuery, req.query);
      object(res, { last_event_id: latestEventId(db, mode) });
    },
    events(req, res) {
      const query = read(eventsQuery, req.query);
      const events = eventsAfter(db, mode, query.after_id, query.limit + 1);
      const values = events.slice(0, query.limit);
      list(
        res,
        values,
        events.length > query.limit ? values.at(-1).event_id : null,
        query.limit,
      );
    },
  };
}
