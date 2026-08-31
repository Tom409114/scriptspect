export type ProvenanceExpectation = {
  package: string;
  version: string;
  predicateType: string;
  subjectDigest: { algorithm: 'sha512'; value: string };
  repository: string;
  workflowPath: string;
  ref: string;
  commitSha: string;
  builderId: string;
};

export type VerifiedProvenance = {
  package: string;
  version: string;
  predicateType: string;
  statementDigest: string;
};

export function verifyProvenanceAudit(
  audit: unknown,
  expected: ProvenanceExpectation,
): VerifiedProvenance;
