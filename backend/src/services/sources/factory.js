import { SOURCES } from "@finosauras/shared/constants";
import {
  discoveryResultSchema,
  sourceHealthSchema,
  utcInstantSchema,
} from "@finosauras/shared";
import { sourceGrants } from "../../config/env.js";
import { PipelineError } from "../../utils/errors.js";
import { validateSourceUrl } from "../../utils/security.js";
import { createSourceHttp } from "../../utils/source-http.js";
import { createNseSource } from "./nse.js";
import { createBseSource } from "./bse.js";
import { createLicensedSource } from "./licensed.js";
import { createAnnouncementReview } from "./xbrl.js";
import {
  discoverFixture,
  isFixtureAttachment,
  openFixtureAttachment,
} from "./fixture.js";

const creators = {
  NSE: createNseSource,
  BSE: createBseSource,
  LICENSED: createLicensedSource,
};

/**
 * Construct fixture, direct exchange and licensed source adapters from grants.
 * @returns {Record<import('./types.js').NormalizedFiling['source'], import('./types.js').FilingSource>}
 */
export function createSources(
  config,
  { policy, logger, clock, network = {} } = {},
) {
  const grants = sourceGrants(config);
  return Object.fromEntries(
    SOURCES.map((source) => {
      const enabled = grants[source];
      const fixture = source === "FIXTURE";
      const endpoint = config[`${source}_FEED_URL`];
      const hosts = endpoint ? [new URL(endpoint).hostname] : [];
      if (source === "BSE" && config.BSE_ATTACHMENT_BASE_URL)
        hosts.push(new URL(config.BSE_ATTACHMENT_BASE_URL).hostname);
      hosts.push(
        ...(config[`${source}_ATTACHMENT_HOSTS`] ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      );
      const guard = () => {
        if (!enabled)
          throw new PipelineError("SOURCE_NOT_AUTHORIZED", undefined, {
            source,
          });
        policy?.check(source);
      };
      const client =
        enabled && !fixture
          ? createSourceHttp({
              ...network,
              source,
              allowedHosts: hosts,
              authorized: () => enabled,
              minGap: config.SOURCE_MIN_GAP_MS,
              requestTimeout: config.SOURCE_TIMEOUT_MS,
              attempts: Math.min(3, config.MAX_JOB_ATTEMPTS),
              policy,
              clock,
            })
          : null;

      const discover = fixture
        ? discoverFixture
        : enabled
          ? creators[source]({
              endpoint,
              client,
              logger,
              maxPages: config.MAX_SOURCE_PAGES,
              attachmentBase: config.BSE_ATTACHMENT_BASE_URL,
              token:
                source === "LICENSED" ? config.LICENSED_FEED_TOKEN : undefined,
            })
          : null;

      const allowedAttachment = (url) => {
        if (fixture) return isFixtureAttachment(url);
        try {
          validateSourceUrl(url, hosts);
          return true;
        } catch {
          return false;
        }
      };

      return [
        source,
        {
          source,
          cacheNamespace: fixture ? "fixture" : "live",
          enabled,
          allowedAttachment,
          reviewAnnouncement:
            client && ["NSE", "BSE"].includes(source)
              ? createAnnouncementReview({ client, allowedAttachment, logger })
              : undefined,
          guard,
          eligible(company) {
            if (fixture) return company.nseSymbol === "INFY";
            if (!utcInstantSchema.safeParse(company.identityVerifiedAt).success)
              return false;
            if (source === "NSE") return Boolean(company.nseSymbol);
            if (source === "BSE") return Boolean(company.bseScripCode);
            return Boolean(
              company.isin || company.nseSymbol || company.bseScripCode,
            );
          },
          async discover(window) {
            guard();
            if (!window.company) {
              // Market discovery uses the same approved endpoint, origin and policy holds.
              if (fixture)
                throw new PipelineError("SOURCE_NOT_AUTHORIZED", undefined, {
                  source,
                });
              return discoveryResultSchema.parse(await discover(window));
            }
            if (!this.eligible(window.company))
              throw new PipelineError("UNVERIFIED_COMPANY", undefined, {
                source,
              });
            const { displayName, nseSymbol, bseScripCode, isin } =
              window.company;
            return discoveryResultSchema.parse(
              await discover({
                ...window,
                company: { displayName, nseSymbol, bseScripCode, isin },
              }),
            );
          },
          async download(url, { signal }, consume) {
            guard();
            if (!allowedAttachment(url))
              throw new PipelineError("DOWNLOAD_UNSAFE_URL");
            if (!fixture)
              return client.pdf(
                url,
                { signal, timeout: config.DOWNLOAD_TIMEOUT_MS },
                consume,
              );
            const stream = openFixtureAttachment(url, signal);
            try {
              return await consume(stream, signal);
            } finally {
              stream.destroy();
            }
          },
          health() {
            const state = policy?.state(source);
            return sourceHealthSchema.parse({
              enabled,
              mode: enabled
                ? fixture
                  ? "fixture"
                  : "authorized"
                : "disabled_permission",
              lastSuccessAt: state?.last_success_at ?? null,
              status:
                !enabled || state?.last_error_code === "UNVERIFIED_COMPANY"
                  ? "disabled"
                  : state?.blocked
                    ? "blocked"
                    : (state?.result ?? "idle"),
              reason: !enabled
                ? "SOURCE_NOT_AUTHORIZED"
                : (state?.last_error_code ?? undefined),
            });
          },
        },
      ];
    }),
  );
}
