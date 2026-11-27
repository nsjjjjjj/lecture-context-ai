export const DEFAULT_AWS_REGION = "ap-northeast-2";
export const DEFAULT_AWS_PARTIAL_RESULTS_STABILITY = "low";

export type AwsPartialResultsStability = "off" | "low" | "medium" | "high";
export type ServiceVerification = "unverified" | "verified" | "failed";

export type ServiceConfigurationStatus = {
  configured: boolean;
  verification: ServiceVerification;
};

export type AwsTranscribeConfiguration = {
  region: string;
  partialResultsStability: AwsPartialResultsStability;
  providerTimeoutMs: number;
  drainTimeoutMs: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveAwsPartialResultsStability(
  value = process.env.AWS_TRANSCRIBE_PARTIAL_STABILITY
): AwsPartialResultsStability {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    ? value
    : DEFAULT_AWS_PARTIAL_RESULTS_STABILITY;
}

export function resolveAwsRegion(): string {
  return process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || DEFAULT_AWS_REGION;
}

export function getAwsTranscribeConfigurationError(): string | null {
  const region = resolveAwsRegion();
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u.test(region)) {
    return "AWS_REGION 형식이 올바르지 않습니다.";
  }
  const configuredStability = process.env.AWS_TRANSCRIBE_PARTIAL_STABILITY;
  if (configuredStability && !["off", "low", "medium", "high"].includes(configuredStability)) {
    return "AWS_TRANSCRIBE_PARTIAL_STABILITY은 off, low, medium, high 중 하나여야 합니다.";
  }
  return null;
}

export function resolveAwsTranscribeConfiguration(): AwsTranscribeConfiguration {
  const error = getAwsTranscribeConfigurationError();
  if (error) throw new Error(error);
  return {
    region: resolveAwsRegion(),
    partialResultsStability: resolveAwsPartialResultsStability(),
    providerTimeoutMs: positiveInteger(process.env.AWS_TRANSCRIBE_PROVIDER_TIMEOUT_MS, 8_000),
    drainTimeoutMs: positiveInteger(process.env.AWS_TRANSCRIBE_DRAIN_TIMEOUT_MS, 5_000)
  };
}

export function isAwsTranscribeConfigured(): boolean {
  return getAwsTranscribeConfigurationError() === null;
}

export function unverifiedServiceConfiguration(configured: boolean): ServiceConfigurationStatus {
  return { configured, verification: "unverified" };
}

export function resolveSttProvider(
  value = process.env.STT_PROVIDER,
  nodeEnv = process.env.NODE_ENV
): "aws" | "google" {
  return nodeEnv === "development" && value?.trim().toLowerCase() === "google" ? "google" : "aws";
}
