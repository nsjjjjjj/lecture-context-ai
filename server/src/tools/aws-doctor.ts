import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { ListVocabulariesCommand, TranscribeClient } from "@aws-sdk/client-transcribe";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { getAwsTranscribeConfigurationError, resolveAwsRegion } from "../services/aws-config.js";

async function main(): Promise<void> {
  const configurationError = getAwsTranscribeConfigurationError();
  if (configurationError) throw new Error(configurationError);
  const region = resolveAwsRegion();
  const bucket = process.env.AWS_TRANSCRIBE_VOCABULARY_BUCKET?.trim();
  if (!bucket) throw new Error("AWS_TRANSCRIBE_VOCABULARY_BUCKET 설정이 필요합니다.");

  const sts = new STSClient({ region });
  const transcribe = new TranscribeClient({ region });
  const s3 = new S3Client({ region });
  await sts.send(new GetCallerIdentityCommand({}));
  console.log(`OK credentials (${region})`);
  await transcribe.send(new ListVocabulariesCommand({ NameContains: "lecture-ko-", MaxResults: 5 }));
  console.log("OK transcribe:ListVocabularies");
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log("OK s3:HeadBucket");
  console.log("AWS Transcribe 사전점검을 통과했습니다. 계정 ID와 자격증명 값은 출력하지 않았습니다.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "AWS 사전점검에 실패했습니다.");
  process.exitCode = 1;
});
