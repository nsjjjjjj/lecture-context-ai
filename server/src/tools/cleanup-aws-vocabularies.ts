import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DeleteVocabularyCommand, ListVocabulariesCommand, TranscribeClient } from "@aws-sdk/client-transcribe";
import { resolveAwsRegion } from "../services/aws-config.js";
import { AWS_VOCABULARY_PREFIX, isManagedAwsVocabularyName } from "../services/aws-vocabulary.js";

function parseOptions(argv: string[]): { execute: boolean; olderThanDays: number } {
  const execute = argv.includes("--execute");
  const value = argv.find((argument) => argument.startsWith("--older-than-days="))?.split("=")[1];
  const parsed = Number(value ?? 30);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--older-than-days는 1 이상의 정수여야 합니다.");
  return { execute, olderThanDays: parsed };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const region = resolveAwsRegion();
  const bucket = process.env.AWS_TRANSCRIBE_VOCABULARY_BUCKET?.trim();
  const keyPrefix = (process.env.AWS_TRANSCRIBE_VOCABULARY_PREFIX || "lecture-context/vocabularies").replace(/^\/+|\/+$/gu, "");
  const cutoff = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1_000;
  const transcribe = new TranscribeClient({ region });
  const s3 = new S3Client({ region });

  let nextToken: string | undefined;
  const vocabularyNames: string[] = [];
  do {
    const page = await transcribe.send(
      new ListVocabulariesCommand({ NameContains: AWS_VOCABULARY_PREFIX, MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) })
    );
    for (const vocabulary of page.Vocabularies || []) {
      const name = vocabulary.VocabularyName;
      const modifiedAt = vocabulary.LastModifiedTime?.getTime();
      if (name && isManagedAwsVocabularyName(name) && modifiedAt !== undefined && modifiedAt < cutoff) {
        vocabularyNames.push(name);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);

  console.log(`${options.execute ? "삭제" : "DRY RUN"}: ${vocabularyNames.length}개 vocabulary 후보`);
  for (const name of vocabularyNames) {
    console.log(`- ${name}`);
    if (options.execute) await transcribe.send(new DeleteVocabularyCommand({ VocabularyName: name }));
  }

  if (!bucket) {
    console.log("AWS_TRANSCRIBE_VOCABULARY_BUCKET이 없어 S3 임시 원본 검사는 건너뜁니다.");
    return;
  }
  let continuationToken: string | undefined;
  const staleObjects: string[] = [];
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${keyPrefix}/`, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) })
    );
    for (const object of page.Contents || []) {
      const key = object.Key;
      const modifiedAt = object.LastModified?.getTime();
      const prefix = `${keyPrefix}/`;
      const fileName = key?.startsWith(prefix) ? key.slice(prefix.length) : "";
      const vocabularyName = fileName.endsWith(".txt") ? fileName.slice(0, -4) : "";
      if (key && isManagedAwsVocabularyName(vocabularyName) && modifiedAt !== undefined && modifiedAt < cutoff) {
        staleObjects.push(key);
      }
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  console.log(`${options.execute ? "삭제" : "DRY RUN"}: ${staleObjects.length}개 S3 임시 원본 후보`);
  for (const key of staleObjects) {
    console.log(`- s3://${bucket}/${key}`);
    if (options.execute) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  if (!options.execute) console.log("실제 삭제는 검토 후 --execute를 명시해야 실행됩니다.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "AWS vocabulary 정리에 실패했습니다.");
  process.exitCode = 1;
});
