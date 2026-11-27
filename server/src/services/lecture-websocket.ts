import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, type WebSocketServer } from "ws";
import type { GlossaryTerm, TranscriptEvent } from "../types.js";
import { createTranscriptEvent } from "./caption.js";
import { demoTranscript } from "./demo.js";
import {
  getAwsTranscribeConfigurationError,
  resolveSttProvider
} from "./aws-config.js";
import {
  createAwsTranscribeSession,
  type AwsTranscriptEmission
} from "./aws-transcribe.js";
import { awsVocabularyNameForTerms, isManagedAwsVocabularyName } from "./aws-vocabulary.js";
import {
  createDevelopmentSpeechDiagnosticReporter,
  getGoogleSpeechConfigurationError,
  type SpeechDiagnosticEvent
} from "./google-speech-config.js";
import { createLiveAudioFlowController, type LiveAudioFlowController } from "./live-audio-flow.js";
import {
  createOutboundWebSocketFlowController,
  type OutboundWebSocketFlowController
} from "./outbound-websocket-flow.js";
import type { SttSession } from "./stt-session.js";
import {
  createTranscriptSegmentSequencer,
  type TranscriptSegmentSequencer
} from "./transcript-segments.js";
import { resolveStartContext } from "./ws-start.js";
import {
  clearPendingSpeechEnd,
  closeSpeechSessionForSocket,
  consumeSpeechEndMessage,
  requestLectureStop,
  type SttSessionSlot
} from "./ws-lifecycle.js";
import {
  createFixedWindowRateLimiter,
  resolveClientAddress,
  type FixedWindowRateLimiter
} from "./ws-security.js";
import {
  parseClientControlMessage,
  validateAwsPcmAudioChunk,
  WebSocketProtocolError
} from "./ws-protocol.js";

type AwsSessionFactory = typeof createAwsTranscribeSession;
type GoogleSessionFactory = (
  phraseSet: string[],
  callbacks: {
    onTranscript: (text: string, isFinal: boolean) => void;
    onError: (error: Error) => void;
    onEnd: () => void;
    onDrain?: () => void;
    onDiagnostic?: (event: SpeechDiagnosticEvent) => void;
  }
) => Promise<SttSession>;

async function createDevelopmentGoogleSession(
  ...args: Parameters<GoogleSessionFactory>
): Promise<SttSession> {
  const { createGoogleSpeechSession } = await import("./speech.js");
  return createGoogleSpeechSession(...args);
}

export type LectureWebSocketRuntimeOptions = {
  nodeEnv?: string;
  maxLiveSessions?: number;
  maxLiveSessionMs?: number;
  maxConnections?: number;
  startTimeoutMs?: number;
  capturePermissionTimeoutMs?: number;
  firstAudioTimeoutMs?: number;
  audioIdleTimeoutMs?: number;
  trustProxy?: boolean;
  startLimiter?: FixedWindowRateLimiter;
  resolveProvider?: () => "aws" | "google";
  getAwsConfigurationError?: () => string | null;
  getGoogleConfigurationError?: () => string | null;
  createAwsSession?: AwsSessionFactory;
  createGoogleSession?: GoogleSessionFactory;
};

export type LectureWebSocketRuntime = {
  activeConnectionCount: () => number;
  activeLiveSessionCount: () => number;
  detach: () => void;
};

export const DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS = 30_000;
export const DEFAULT_FIRST_AUDIO_TIMEOUT_MS = 3_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function emitTranscript(
  outbound: OutboundWebSocketFlowController,
  emission: AwsTranscriptEmission,
  terms: GlossaryTerm[],
  segments: TranscriptSegmentSequencer
): void {
  outbound.send(
    createTranscriptEvent(
      emission.text,
      emission.isFinal,
      terms,
      segments.next({
        isFinal: emission.isFinal,
        ...(emission.providerResultId ? { providerResultId: emission.providerResultId } : {}),
        ...(emission.stablePrefixLength === undefined
          ? {}
          : { stablePrefixLength: emission.stablePrefixLength }),
        ...(emission.startTimeMs === undefined ? {} : { startTimeMs: emission.startTimeMs }),
        ...(emission.endTimeMs === undefined ? {} : { endTimeMs: emission.endTimeMs })
      })
    )
  );
}

function validatedVocabularyName(value: unknown, terms: GlossaryTerm[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WebSocketProtocolError("AWS 사용자 지정 용어집 이름이 올바르지 않습니다.");
  const name = value.trim();
  if (!isManagedAwsVocabularyName(name)) {
    throw new WebSocketProtocolError("AWS 사용자 지정 용어집 이름이 올바르지 않습니다.");
  }
  if (name !== awsVocabularyNameForTerms(terms)) {
    throw new WebSocketProtocolError("현재 강연 용어와 AWS 사용자 지정 용어집이 일치하지 않습니다.");
  }
  return name;
}

function publicSpeechError(error: Error, provider: "aws" | "google"): string {
  if (/credential|token|access.?key|signature/iu.test(`${error.name} ${error.message}`)) {
    return `${provider === "aws" ? "AWS" : "Google"} 음성인식 인증을 확인해 주세요.`;
  }
  if (/timeout|시간이 초과/iu.test(`${error.name} ${error.message}`)) {
    return "음성인식 연결 시간이 초과되었습니다. 다시 시작해 주세요.";
  }
  return `${provider === "aws" ? "AWS" : "Google"} 음성인식 연결을 처리하지 못했습니다.`;
}

function startDemo(
  outbound: OutboundWebSocketFlowController,
  terms: GlossaryTerm[],
  segments: TranscriptSegmentSequencer,
  onEnd: () => void
): Array<NodeJS.Timeout> {
  const timers: Array<NodeJS.Timeout> = [];
  const readyResult = outbound.send({ type: "ready", message: "데모 강연이 준비되었습니다." });
  if (readyResult === "closed" || readyResult === "overflow") return timers;
  demoTranscript.forEach((line, index) => {
    timers.push(
      setTimeout(
        () => emitTranscript(outbound, { text: line.interim, isFinal: false }, terms, segments),
        700 + index * 2_350
      ),
      setTimeout(
        () => emitTranscript(outbound, { text: line.final, isFinal: true }, terms, segments),
        1_650 + index * 2_350
      )
    );
  });
  timers.push(setTimeout(onEnd, 1_650 + demoTranscript.length * 2_350));
  return timers;
}

export function attachLectureWebSocketRuntime(
  wss: WebSocketServer,
  options: LectureWebSocketRuntimeOptions = {}
): LectureWebSocketRuntime {
  const maxLiveSessions = positiveInteger(options.maxLiveSessions, 5);
  const maxLiveSessionMs = positiveInteger(options.maxLiveSessionMs, 4 * 60 * 60 * 1_000);
  const maxConnections = positiveInteger(options.maxConnections, 100);
  const startTimeoutMs = positiveInteger(options.startTimeoutMs, 10_000);
  const capturePermissionTimeoutMs = positiveInteger(
    options.capturePermissionTimeoutMs,
    DEFAULT_CAPTURE_PERMISSION_TIMEOUT_MS
  );
  const firstAudioTimeoutMs = positiveInteger(options.firstAudioTimeoutMs, DEFAULT_FIRST_AUDIO_TIMEOUT_MS);
  const audioIdleTimeoutMs = positiveInteger(options.audioIdleTimeoutMs, 30_000);
  const startLimiter = options.startLimiter ?? createFixedWindowRateLimiter({ limit: 12, windowMs: 60_000 });
  const resolveProvider = options.resolveProvider ?? (() => resolveSttProvider(process.env.STT_PROVIDER, options.nodeEnv));
  const getAwsConfigurationError = options.getAwsConfigurationError ?? getAwsTranscribeConfigurationError;
  const getGoogleConfigurationError = options.getGoogleConfigurationError ?? getGoogleSpeechConfigurationError;
  const createAwsSession = options.createAwsSession ?? createAwsTranscribeSession;
  const createGoogleSession = options.createGoogleSession ?? createDevelopmentGoogleSession;
  let activeLiveSessions = 0;
  let activeConnections = 0;

  const onConnection = (websocket: WebSocket, request: IncomingMessage): void => {
    type ConnectionPhase =
      | "awaiting-start"
      | "awaiting-capture"
      | "preparing"
      | "streaming"
      | "draining"
      | "terminal";

    if (activeConnections >= maxConnections) {
      websocket.on("error", () => undefined);
      websocket.send(JSON.stringify({
        type: "error",
        message: "동시에 연결할 수 있는 강연 준비 수를 초과했습니다."
      } satisfies TranscriptEvent));
      websocket.close(1013, "websocket capacity");
      return;
    }
    activeConnections += 1;

    const speechSessionSlot: SttSessionSlot = { active: null, pendingEndMessage: null };
    const transcriptSegments = createTranscriptSegmentSequencer();
    const clientAddress = resolveClientAddress({
      remoteAddress: request.socket.remoteAddress,
      forwardedFor: firstHeaderValue(request.headers["x-forwarded-for"]),
      trustProxy: options.trustProxy
    });
    let phase: ConnectionPhase = "awaiting-start";
    let terms: GlossaryTerm[] = [];
    let demoTimers: Array<NodeJS.Timeout> = [];
    let liveAudioFlow: LiveAudioFlowController | null = null;
    let liveSessionHeld = false;
    let liveSessionTimer: NodeJS.Timeout | null = null;
    let startTimer: NodeJS.Timeout | null = null;
    let capturePermissionTimer: NodeJS.Timeout | null = null;
    let firstAudioTimer: NodeJS.Timeout | null = null;
    let audioIdleTimer: NodeJS.Timeout | null = null;
    let firstAudioReceived = false;
    let startProviderAfterCapture: (() => Promise<void>) | null = null;
    let connectionHeld = true;
    const isTerminalPhase = (): boolean => phase === "terminal";
    const outbound = createOutboundWebSocketFlowController({
      transport: {
        isOpen: () => websocket.readyState === WebSocket.OPEN,
        bufferedAmount: () => websocket.bufferedAmount,
        send: (payload, callback) => websocket.send(payload, callback),
        close: (code, reason) => websocket.close(code, reason),
        terminate: () => websocket.terminate()
      },
      overflowEvent: {
        type: "error",
        message: "자막 전송이 지연되어 안전한 전송 한도를 초과했습니다. 다시 시작해 주세요."
      },
      onOverflow: () => {
        if (phase === "terminal") return;
        phase = "terminal";
        clearPendingSpeechEnd(speechSessionSlot);
        cleanup(true);
      }
    });

    const clearTimer = (timer: NodeJS.Timeout | null): void => {
      if (timer) clearTimeout(timer);
    };
    const unrefTimer = (timer: NodeJS.Timeout): NodeJS.Timeout => {
      timer.unref();
      return timer;
    };
    const clearAudioTimers = (): void => {
      clearTimer(capturePermissionTimer);
      clearTimer(firstAudioTimer);
      clearTimer(audioIdleTimer);
      capturePermissionTimer = null;
      firstAudioTimer = null;
      audioIdleTimer = null;
    };
    const clearLiveSessionTimer = (): void => {
      clearTimer(liveSessionTimer);
      liveSessionTimer = null;
    };
    const releaseLiveSession = (): void => {
      clearLiveSessionTimer();
      if (!liveSessionHeld) return;
      liveSessionHeld = false;
      activeLiveSessions = Math.max(0, activeLiveSessions - 1);
    };
    const cleanup = (abortActiveSession: boolean): void => {
      clearTimer(startTimer);
      startTimer = null;
      clearAudioTimers();
      demoTimers.forEach(clearTimeout);
      demoTimers = [];
      liveAudioFlow?.dispose();
      liveAudioFlow = null;
      startProviderAfterCapture = null;
      if (abortActiveSession) closeSpeechSessionForSocket(speechSessionSlot);
      releaseLiveSession();
      if (connectionHeld) {
        connectionHeld = false;
        activeConnections = Math.max(0, activeConnections - 1);
      }
    };
    const failOnce = (message: string, code = 1011, reason = "terminal error"): void => {
      if (phase === "terminal") return;
      phase = "terminal";
      clearPendingSpeechEnd(speechSessionSlot);
      cleanup(true);
      outbound.finish({ type: "error", message }, code, reason);
    };
    const endOnce = (
      message: string,
      outcome: "completed" | "flush-timeout" = "completed"
    ): void => {
      if (phase === "terminal") return;
      phase = "terminal";
      cleanup(true);
      outbound.finish({ type: "ended", outcome, message }, 1000, outcome);
    };
    const armFirstAudioTimeout = (): void => {
      clearTimer(firstAudioTimer);
      firstAudioTimer = unrefTimer(setTimeout(() => {
        failOnce(
          `마이크 준비 신호 뒤 ${Math.ceil(firstAudioTimeoutMs / 1_000)}초 동안 PCM 오디오가 도착하지 않아 음성인식 연결을 종료했습니다. 입력 장치를 확인해 주세요.`,
          1008,
          "first audio timeout"
        );
      }, firstAudioTimeoutMs));
    };
    const armCapturePermissionTimeout = (): void => {
      clearTimer(capturePermissionTimer);
      capturePermissionTimer = unrefTimer(setTimeout(() => {
        failOnce(
          `${Math.ceil(capturePermissionTimeoutMs / 1_000)}초 동안 마이크 준비 응답이 없어 대기를 종료했습니다. 마이크 권한을 확인해 주세요.`,
          1008,
          "capture permission timeout"
        );
      }, capturePermissionTimeoutMs));
    };
    const armAudioIdleTimeout = (): void => {
      clearTimer(audioIdleTimer);
      audioIdleTimer = unrefTimer(setTimeout(() => {
        failOnce(
          "오디오 전송이 중단되어 음성인식 연결을 종료했습니다. 다시 시작해 주세요.",
          1008,
          "audio idle timeout"
        );
      }, audioIdleTimeoutMs));
    };

    startTimer = unrefTimer(setTimeout(() => {
      failOnce("강연 시작 요청이 없어 연결을 종료했습니다.", 1008, "start timeout");
    }, startTimeoutMs));

    websocket.on("message", async (data, isBinary) => {
      try {
        if (isBinary) {
          if (phase === "draining" || phase === "terminal") return;
          if (phase !== "streaming" || !speechSessionSlot.active || !liveAudioFlow) {
            throw new WebSocketProtocolError("오디오를 받을 준비가 되기 전에 데이터가 전송되었습니다.");
          }
          const audio = validateAwsPcmAudioChunk(data);
          if (!firstAudioReceived) {
            firstAudioReceived = true;
            clearTimer(firstAudioTimer);
            firstAudioTimer = null;
          }
          armAudioIdleTimeout();
          liveAudioFlow.writeOrQueue(audio);
          return;
        }

        const message = parseClientControlMessage(data);
        if (message.type === "stop") {
          if (phase === "terminal" || phase === "draining") return;
          phase = "draining";
          clearAudioTimers();
          clearLiveSessionTimer();
          if (speechSessionSlot.active && !firstAudioReceived) {
            endOnce("강연을 종료했습니다.", "completed");
            return;
          }
          const flowToFlush = liveAudioFlow;
          await requestLectureStop(
            speechSessionSlot,
            (endMessage) => endOnce(endMessage, "completed"),
            flowToFlush
              ? async () => {
                  const result = await flowToFlush.flushBeforeFinishInput();
                  if (result !== "flushed" && phase === "draining") {
                    failOnce(
                      "마지막 오디오를 음성인식 서버로 전달하지 못했습니다. 다시 시도해 주세요.",
                      1011,
                      "speech input flush failed"
                    );
                  }
                }
              : undefined
          );
          return;
        }
        if (message.type === "captureReady") {
          if (phase !== "awaiting-capture" || !startProviderAfterCapture) {
            throw new WebSocketProtocolError("마이크 준비 신호를 받을 수 있는 단계가 아닙니다.");
          }
          clearTimer(capturePermissionTimer);
          capturePermissionTimer = null;
          phase = "preparing";
          const startProvider = startProviderAfterCapture;
          startProviderAfterCapture = null;
          await startProvider();
          return;
        }
        if (phase !== "awaiting-start") {
          throw new WebSocketProtocolError("강연 시작 요청은 연결당 한 번만 보낼 수 있습니다.");
        }

        const rateLimit = startLimiter.take(clientAddress);
        if (!rateLimit.allowed) {
          failOnce(
            `강연 시작 요청이 너무 많습니다. ${rateLimit.retryAfterSeconds}초 후 다시 시도해 주세요.`,
            1008,
            "start rate limited"
          );
          return;
        }

        clearTimer(startTimer);
        startTimer = null;
        phase = "preparing";
        const context = resolveStartContext(message.mode, message.terms, message.phraseSet);
        terms = context.terms;

        if (message.mode === "demo") {
          phase = "streaming";
          demoTimers = startDemo(outbound, terms, transcriptSegments, () =>
            endOnce("데모 강연이 끝났습니다.", "completed")
          );
          return;
        }

        const provider = resolveProvider();
        const speechConfigurationError = provider === "aws"
          ? getAwsConfigurationError()
          : getGoogleConfigurationError();
        if (speechConfigurationError) {
          failOnce(speechConfigurationError, 1011, "speech configuration error");
          return;
        }
        const vocabularyName = provider === "aws"
          ? validatedVocabularyName(message.vocabularyName, context.terms)
          : undefined;

        if (activeLiveSessions >= maxLiveSessions) {
          failOnce("동시에 실행할 수 있는 실시간 강연 수를 초과했습니다.", 1013, "live session capacity");
          return;
        }
        activeLiveSessions += 1;
        liveSessionHeld = true;
        liveSessionTimer = unrefTimer(setTimeout(() => {
          failOnce(
            "실시간 강연의 최대 실행 시간이 지나 연결을 종료했습니다.",
            1008,
            "live session duration exceeded"
          );
        }, maxLiveSessionMs));

        const diagnostic = provider === "google"
          ? createDevelopmentSpeechDiagnosticReporter(
              options.nodeEnv === "development",
              randomUUID(),
              (record) => console.debug("[live-stt-diagnostic]", record)
            )
          : undefined;
        liveAudioFlow = createLiveAudioFlowController({
          enqueueAudio: (audio) => speechSessionSlot.active?.enqueueAudio(audio) ?? "closed",
          pauseInput: () => websocket.pause(),
          resumeInput: () => websocket.resume(),
          onTimeout: () => failOnce(
            "음성 전송이 지연되어 오래된 오디오가 쌓이기 전에 연결을 종료했습니다. 다시 시작해 주세요.",
            1013,
            "speech backpressure timeout"
          ),
          onOverflow: () => failOnce(
            "음성 전송 적체가 안전 한도를 넘어 오래된 오디오를 버리지 않고 연결을 종료했습니다. 다시 시작해 주세요.",
            1013,
            "speech backpressure overflow"
          ),
          onClosed: () => {
            if (phase === "streaming" || phase === "draining") {
              failOnce(
                "음성인식 세션이 이미 종료되었습니다. 다시 시작해 주세요.",
                1011,
                "speech session closed"
              );
            }
          }
        });

        startProviderAfterCapture = async () => {
          let createdSession: SttSession | null = null;
          let sessionTerminated = false;
          let awsProviderAccepted = false;
          let awsProviderAcceptedSent = false;
          const sendAwsProviderAccepted = (): void => {
            if (
              !awsProviderAccepted ||
              awsProviderAcceptedSent ||
              phase !== "streaming" ||
              speechSessionSlot.active !== createdSession
            ) {
              return;
            }
            awsProviderAcceptedSent = true;
            outbound.send({ type: "providerAccepted", message: "AWS 음성인식 연결이 승인되었습니다." });
          };
          try {
            const onError = (error: Error): void => {
              sessionTerminated = true;
              if (speechSessionSlot.active === createdSession) speechSessionSlot.active = null;
              clearPendingSpeechEnd(speechSessionSlot);
              failOnce(publicSpeechError(error, provider), 1011, "speech provider error");
            };
            if (provider === "aws") {
              createdSession = createAwsSession(vocabularyName, {
                onProviderAccepted: () => {
                  awsProviderAccepted = true;
                  sendAwsProviderAccepted();
                },
                onTranscript: (emission) => {
                  if (phase === "streaming" || phase === "draining") {
                    emitTranscript(outbound, emission, terms, transcriptSegments);
                  }
                },
                onError,
                onEnd: ({ flushTimedOut }) => {
                  sessionTerminated = true;
                  if (speechSessionSlot.active === createdSession) speechSessionSlot.active = null;
                  if (phase !== "draining") {
                    clearPendingSpeechEnd(speechSessionSlot);
                    failOnce(
                      "AWS 음성인식 응답이 강연 종료 전에 끊어졌습니다. 다시 시작해 주세요.",
                      1011,
                      "unexpected speech provider end"
                    );
                    return;
                  }
                  const requestedEndMessage = consumeSpeechEndMessage(
                    speechSessionSlot,
                    "AWS 음성인식 연결이 종료되었습니다."
                  );
                  const message = flushTimedOut
                    ? "강연은 종료됐지만 마지막 자막 확정 대기 시간이 초과되었습니다."
                    : requestedEndMessage;
                  endOnce(message, flushTimedOut ? "flush-timeout" : "completed");
                },
                onDrain: () => liveAudioFlow?.resumeFromGrpc()
              });
            } else {
              createdSession = await createGoogleSession(context.phraseSet, {
                onTranscript: (text, isFinal) => {
                  if (phase === "streaming" || phase === "draining") {
                    emitTranscript(outbound, { text, isFinal }, terms, transcriptSegments);
                  }
                },
                onError,
                onEnd: () => {
                  sessionTerminated = true;
                  if (speechSessionSlot.active === createdSession) speechSessionSlot.active = null;
                  endOnce(
                    consumeSpeechEndMessage(speechSessionSlot, "Google 음성인식 연결이 종료되었습니다."),
                    "completed"
                  );
                },
                onDrain: () => liveAudioFlow?.resumeFromGrpc(),
                onDiagnostic: diagnostic
              });
            }
          } catch (error) {
            if (!sessionTerminated) {
              failOnce(
                publicSpeechError(
                  error instanceof Error ? error : new Error("음성인식을 준비하지 못했습니다."),
                  provider
                ),
                1011,
                "speech setup error"
              );
            }
            return;
          }
          if (sessionTerminated || isTerminalPhase() || websocket.readyState !== WebSocket.OPEN) {
            createdSession.abort();
            return;
          }
          speechSessionSlot.active = createdSession;
          phase = "streaming";
          outbound.send({ type: "readyForAudio", message: "오디오 전송을 시작할 수 있습니다." });
          if (isTerminalPhase()) return;
          armFirstAudioTimeout();
          if (provider === "aws") {
            sendAwsProviderAccepted();
          } else {
            outbound.send({ type: "providerAccepted", message: "Google 음성인식 연결이 승인되었습니다." });
          }
        };
        phase = "awaiting-capture";
        outbound.send({
          type: "captureRequested",
          message: `마이크 권한을 확인하고 있습니다. ${Math.ceil(capturePermissionTimeoutMs / 1_000)}초 안에 허용해 주세요.`
        });
        if (isTerminalPhase()) return;
        armCapturePermissionTimeout();
      } catch (error) {
        const protocolError = error instanceof WebSocketProtocolError
          ? error
          : new WebSocketProtocolError("요청을 처리하지 못했습니다.");
        failOnce(protocolError.message, protocolError.closeCode, "protocol error");
      }
    });

    websocket.on("error", () => {
      outbound.dispose();
      if (phase !== "terminal") {
        phase = "terminal";
        cleanup(true);
      }
    });

    websocket.on("close", () => {
      outbound.dispose();
      if (phase !== "terminal") phase = "terminal";
      cleanup(true);
    });
  };

  wss.on("connection", onConnection);
  return {
    activeConnectionCount: () => activeConnections,
    activeLiveSessionCount: () => activeLiveSessions,
    detach: () => wss.off("connection", onConnection)
  };
}
