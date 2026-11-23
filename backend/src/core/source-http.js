import { Client } from "undici";
import { setTimeout as sleepTimer } from "node:timers/promises";
import { resolveSourceUrl, validateSourceUrl } from "./security.js";
import { PipelineError } from "./errors.js";
import { retryAfterMs, withRetry } from "./retry.js";
import { systemClock } from "./clock.js";

const transient = new Set([408, 429, 500, 502, 503, 504]);
const redirects = new Set([301, 302, 303, 307, 308]);

/** Direct TLS transport pinned to a vetted address, with normal hostname verification. */
export async function pinnedRequest(url, { address, family, signal, headers }) {
  if (url.protocol !== "https:") throw new PipelineError("DOWNLOAD_UNSAFE_URL");
  const dispatcher = new Client(url.origin, {
    pipelining: 0,
    connect: {
      autoSelectFamily: false,
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    },
  });
  const dispose = () => void dispatcher.destroy().catch(() => {});
  try {
    // Preserve the original hostname for TLS while using only the vetted address for the socket.
    const {
      statusCode,
      headers: receivedHeaders,
      body,
    } = await dispatcher.request({
      method: "GET",
      path: url.pathname + url.search,
      signal,
      headers,
    });
    // Undici returns raw bytes and leaves redirects to the source policy.
    body.once("close", dispose);
    return Object.assign(body, { statusCode, headers: receivedHeaders });
  } catch (error) {
    dispose();
    throw error;
  }
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() =>
    signal.removeEventListener("abort", abort),
  );
}

function responseError(response, source) {
  const statusCode = response.statusCode;
  const forbidden = statusCode === 401 || statusCode === 403;
  const code = forbidden
    ? "SOURCE_FORBIDDEN"
    : statusCode === 429
      ? "SOURCE_RATE_LIMITED"
      : "SOURCE_UNAVAILABLE";
  const error = new PipelineError(code, undefined, {
    source,
    stage: "source",
    statusCode,
    retryable: transient.has(statusCode),
  });
  error.retryAfter = response.headers["retry-after"];
  return error;
}

/** Create the source-scoped, paced HTTPS client shared by feed and PDF requests. */
export function createSourceHttp({
  source,
  allowedHosts,
  authorized,
  minGap,
  requestTimeout,
  attempts,
  policy = {},
  clock = systemClock,
  sleep = (ms, signal) => sleepTimer(ms, undefined, { signal }),
  open = pinnedRequest,
  resolve,
  random,
}) {
  let queue = Promise.resolve();
  let lastStart = -Infinity;
  let forbidden;
  let resumeAt = -Infinity;

  function permit() {
    if (!authorized())
      throw new PipelineError("SOURCE_NOT_AUTHORIZED", undefined, { source });
    policy.check?.(source);
    if (forbidden) throw forbidden;
  }

  async function perform(
    initial,
    { signal: caller, timeout = requestTimeout, kind, token },
    consume,
  ) {
    permit();
    const first = validateSourceUrl(initial, allowedHosts);
    let url = first;
    for (let hop = 0; hop <= 3; hop++) {
      caller?.throwIfAborted();
      const wait =
        Math.max(lastStart + minGap, resumeAt) - clock.now().getTime();
      if (wait > 0) await sleep(wait, caller);
      permit();
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = caller
        ? AbortSignal.any([caller, timeoutSignal])
        : timeoutSignal;
      let response;
      try {
        signal.throwIfAborted();
        const { addresses } = await abortable(
          resolveSourceUrl(url, allowedHosts, { resolve }),
          signal,
        );
        const headers = {
          accept:
            kind === "pdf"
              ? "application/pdf, application/octet-stream"
              : "application/json",
          "accept-encoding": "identity",
        };
        // Provider credentials are scoped to the original approved feed origin.
        if (token && url.origin === first.origin)
          headers.authorization = `Bearer ${token}`;
        lastStart = clock.now().getTime();
        response = await open(url, { ...addresses[0], signal, headers });
        if (redirects.has(response.statusCode)) {
          if (hop === 3 || typeof response.headers.location !== "string")
            throw new PipelineError("DOWNLOAD_UNSAFE_URL");
          url = validateSourceUrl(response.headers.location, allowedHosts, {
            redirectFrom: url,
          });
          continue;
        }
        if (response.statusCode !== 200) {
          const error = responseError(response, source);
          if (error.code === "SOURCE_FORBIDDEN") {
            forbidden = error;
            policy.block?.(source, error.code);
          } else if (error.code === "SOURCE_RATE_LIMITED") {
            resumeAt =
              clock.now().getTime() +
              Math.min(
                86_400_000,
                retryAfterMs(error.retryAfter, clock.now()) ?? 3000,
              );
            policy.pause?.(source, new Date(resumeAt));
          }
          throw error;
        }
        return await consume(response, signal);
      } catch (cause) {
        caller?.throwIfAborted();
        if (timeoutSignal.aborted) {
          const code =
            kind === "pdf" ? "DOWNLOAD_TIMEOUT" : "SOURCE_UNAVAILABLE";
          throw new PipelineError(code, undefined, {
            source,
            retryable: true,
            cause,
          });
        }
        if (cause instanceof PipelineError) throw cause;
        throw new PipelineError("SOURCE_UNAVAILABLE", undefined, {
          source,
          retryable: true,
          cause,
        });
      } finally {
        response?.destroy();
      }
    }
  }

  function run(url, options, consume) {
    const { signal } = options;
    const task = queue.then(() =>
      withRetry(() => perform(url, options, consume), {
        maxAttempts: options.kind === "pdf" ? 1 : attempts,
        clock,
        sleep,
        random,
        signal,
        getRetryAfter: (error) => error.retryAfter,
      }),
    );
    // Serialize the entire response lifetime per source, including retry and redirect handling.
    queue = task.catch(() => {});
    return task;
  }

  return {
    pdf: (url, options, consume) =>
      run(url, { ...options, kind: "pdf" }, consume),
    json: (url, options = {}) =>
      run(url, { ...options, kind: "json" }, async (response) => {
        const type = response.headers["content-type"]
          ?.split(";")[0]
          .trim()
          .toLowerCase();
        if (!(
          type === "application/json" ||
          /^application\/[a-z0-9.+-]+\+json$/u.test(type ?? "")
        ))
          throw new PipelineError("SOURCE_SCHEMA_CHANGED");
        const max = 4 * 1024 * 1024;
        if (Number(response.headers["content-length"]) > max)
          throw new PipelineError("SOURCE_SCHEMA_CHANGED");
        const chunks = [];
        let total = 0;
        for await (const chunk of response) {
          total += chunk.length;
          if (total > max) throw new PipelineError("SOURCE_SCHEMA_CHANGED");
          chunks.push(chunk);
        }
        if (response.complete === false)
          throw new PipelineError("SOURCE_UNAVAILABLE", undefined, {
            retryable: true,
          });
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new PipelineError("SOURCE_SCHEMA_CHANGED");
        }
      }),
  };
}
