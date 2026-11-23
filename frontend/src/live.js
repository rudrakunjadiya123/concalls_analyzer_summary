import { useEffect, useState } from "react";
import { eventSchema } from "@finosauras/shared";
import { readApi } from "./api.js";

/** Follow durable IDs. Buffer pushes until catch-up covers any events missed during setup or disconnect. */
export function useLiveSummaries() {
  const [live, setLive] = useState({
    ready: false,
    phase: "connecting",
    revision: 0,
    last: null,
    warning: null,
  });
  useEffect(() => {
    let stopped = false,
      socket,
      timer,
      cursor = 0,
      retries = 0,
      session = 0;
    const lifetime = new AbortController();
    function apply(event) {
      if (event.event_id <= cursor) return;
      cursor = event.event_id;
      setLive((previous) => ({
        ...previous,
        last: event,
        revision: previous.revision + 1,
      }));
    }
    async function catchUp(connected, buffer, token) {
      if (connected.data.last_event_id < cursor) {
        cursor = connected.data.last_event_id;
        setLive((previous) => ({
          ...previous,
          last: null,
          revision: previous.revision + 1,
        }));
      }
      for (let page = 0; page < 10; page++) {
        const response = await readApi(
          `/events?after_id=${cursor}&limit=100`,
          lifetime.signal,
        );
        if (stopped || token !== session) return false;
        for (const payload of response.data) {
          const parsed = eventSchema.safeParse(payload);
          if (parsed.success && parsed.data.type !== "connected")
            apply(parsed.data);
          else
            setLive((previous) => ({
              ...previous,
              warning: "An unsupported feed event was skipped.",
            }));
        }
        if (response.pagination.next_cursor === null) break;
        if (page === 9) {
          const latest = await readApi("/events/latest", lifetime.signal);
          if (stopped || token !== session) return false;
          cursor = latest.data.last_event_id;
          setLive((previous) => ({
            ...previous,
            last: null,
            revision: previous.revision + 1,
          }));
        }
      }
      for (const event of [...buffer.values()].sort(
        (a, b) => a.event_id - b.event_id,
      ))
        apply(event);
      buffer.clear();
      return true;
    }
    function connect() {
      if (stopped) return;
      const token = ++session;
      const buffer = new Map();
      let synced = false,
        handshake = false;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(
        `${protocol}//${location.host}/ws/summaries`,
      );
      socket = current;
      current.onmessage = (message) => {
        if (stopped || token !== session) return;
        let event;
        try {
          event = eventSchema.parse(JSON.parse(message.data));
        } catch {
          setLive((previous) => ({
            ...previous,
            warning: "An unsupported feed event was skipped.",
          }));
          return;
        }
        if (event.type === "connected") {
          if (handshake) return;
          handshake = true;
          catchUp(event, buffer, token)
            .then((finished) => {
              if (!finished || stopped || token !== session) return;
              synced = true;
              retries = 0;
              setLive((previous) => ({ ...previous, phase: "connected" }));
            })
            .catch(() => current.close());
        } else if (synced) apply(event);
        else {
          buffer.set(event.event_id, event);
          if (buffer.size > 1000) current.close();
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (stopped || token !== session) return;
        session++;
        setLive((previous) => ({ ...previous, phase: "offline" }));
        const delay = Math.min(
          30_000,
          1000 * 2 ** Math.min(retries++, 5) * (0.85 + Math.random() * 0.3),
        );
        timer = setTimeout(connect, delay);
      };
    }
    // Capture the watermark before loading REST pages so their initial snapshot cannot leave a push gap.
    readApi("/events/latest", lifetime.signal)
      .then(({ data }) => {
        cursor = data.last_event_id;
      })
      .catch(() => {})
      .finally(() => {
        if (!stopped) {
          setLive((previous) => ({ ...previous, ready: true }));
          connect();
        }
      });
    return () => {
      stopped = true;
      lifetime.abort();
      clearTimeout(timer);
      socket?.close();
    };
  }, []);
  return live;
}

export function cardFromEvent(event) {
  const { data, emitted_at } = event;
  const { summary } = data;
  return {
    id: data.summary_id,
    company_id: data.company_id,
    concall_event_id: data.concall_event_id,
    revision: data.revision,
    is_current: true,
    is_mock: data.is_mock,
    published_at: emitted_at,
    company: summary.company,
    quarter: summary.quarter,
    call_date: summary.call_date,
    source: summary.source,
    status: "published",
  };
}

/** Merge a push by durable IDs, retaining superseded history and never creating duplicate cards. */
export function mergeHistory(rows, event) {
  if (!event || rows.some(({ id }) => id === event.data.summary_id))
    return rows;
  const next = cardFromEvent(event);
  if (
    rows.some(
      (row) =>
        row.concall_event_id === next.concall_event_id &&
        row.revision > next.revision,
    )
  )
    return rows;
  return [
    next,
    ...rows.map((row) =>
      row.concall_event_id === next.concall_event_id
        ? { ...row, is_current: false }
        : row,
    ),
  ];
}

export function mergeLatest(row, event) {
  if (event?.data.company_id !== row.id) return row;
  const current = row.latest_summary;
  const next = cardFromEvent(event);
  if (
    current &&
    (current.id === next.id ||
      (current.concall_event_id === next.concall_event_id
        ? current.revision > next.revision
        : (current.call_date ?? "") > (next.call_date ?? "")))
  )
    return row;
  return { ...row, latest_summary: next, status: "published" };
}
