import type {
  LegacyInterimTranscriptEvent,
  TranscriptControlEvent as ClientTranscriptControlEvent,
  TranscriptCorrection as ClientTranscriptCorrection,
  TranscriptEvent as ClientTranscriptEvent,
  TranscriptSegmentEvent as ClientTranscriptSegmentEvent
} from "../types";
import type {
  TranscriptControlEvent as ServerTranscriptControlEvent,
  TranscriptCorrection as ServerTranscriptCorrection,
  TranscriptEvent as ServerTranscriptEvent,
  TranscriptSegmentEvent as ServerTranscriptSegmentEvent
} from "../../../server/src/types";

type Exact<Left, Right> =
  [Left] extends [Right]
    ? [Right] extends [Left]
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;
type CurrentClientTranscriptEvent = Exclude<ClientTranscriptEvent, LegacyInterimTranscriptEvent>;

// These aliases intentionally fail `pnpm typecheck` when either side changes
// a current WebSocket event without updating the other side. The legacy
// client-only `interim` reader is excluded because the server no longer emits it.
export type TranscriptCorrectionContractParity = Assert<
  Exact<ClientTranscriptCorrection, ServerTranscriptCorrection>
>;
export type TranscriptSegmentContractParity = Assert<
  Exact<ClientTranscriptSegmentEvent, ServerTranscriptSegmentEvent>
>;
export type TranscriptControlContractParity = Assert<
  Exact<ClientTranscriptControlEvent, ServerTranscriptControlEvent>
>;
export type TranscriptEventContractParity = Assert<
  Exact<CurrentClientTranscriptEvent, ServerTranscriptEvent>
>;
