import { extractTranscriptFacts, selectTranscriptFacts } from "./extractive.js";

/** Deterministic provider reserved for fictional fixture runs. */
export function createMockProvider() {
  return {
    id: "mock",
    model: "synthetic-extractive-v1",
    isMock: true,
    status: () => ({ configured: true, probed: false }),
    async generateFacts(input) {
      return extractTranscriptFacts(input);
    },
    async synthesize(input) {
      return selectTranscriptFacts(input);
    },
  };
}
