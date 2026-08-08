import {
  DAILY_RULESET_VERSION,
  dailyChallengeForDate,
} from "../../daily-dispatch";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

const DAILY_CHALLENGE_PATTERN =
  /^daily-(\d{4})-(\d{2})-(\d{2})-v([1-9]\d{0,2})$/u;
const SESSION_REQUEST_FIELDS = new Set(["challengeId", "rulesetVersion"]);
const ONE_DAY_MILLISECONDS = 86_400_000;

export const SCORE_LIMITS = {
  bodyBytes: 2_048,
  sessionBodyBytes: 512,
  maxNameLength: 18,
  maxTickets: 24,
  maxBoots: 24,
  maxScore: 16_000,
  maxObjectiveBonus: 2_000,
  maxObjectiveIdLength: 48,
  maxAcceptedPerHour: 10,
  retainedScores: 500,
  minimumSessionAgeSeconds: 75,
  maximumSessionAgeSeconds: 600,
} as const;

type ShiftSessionClaims = {
  version: 2;
  runId: string;
  sourceHash: string;
  issuedAt: number;
  challengeId: string;
  rulesetVersion: number;
};

export class ScoreRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScoreRequestError";
  }
}

export class ScoreboardConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreboardConfigurationError";
  }
}

export function scoreResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDailyChallengeId(value: string) {
  const match = DAILY_CHALLENGE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const rulesetVersion = Number(match[4]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { rulesetVersion, timestamp };
}

export function validateChallengeId(value: unknown) {
  if (value === "classic") return value;
  if (typeof value !== "string" || !parseDailyChallengeId(value)) {
    throw new ScoreRequestError(400, "That leaderboard challenge is not valid.");
  }
  return value;
}

export function expectedDailyChallenge(challengeId: string) {
  const parsed = parseDailyChallengeId(challengeId);
  if (!parsed) return null;
  const date = new Date(parsed.timestamp).toISOString().slice(0, 10);
  const challenge = dailyChallengeForDate(date);
  return challenge.id === challengeId
    ? { ...challenge, rulesetVersion: parsed.rulesetVersion }
    : null;
}

export function validateDailySessionPayload(payload: Record<string, unknown>) {
  if (Object.keys(payload).some((key) => !SESSION_REQUEST_FIELDS.has(key))) {
    throw new ScoreRequestError(
      400,
      "The shift session request contains unsupported fields.",
    );
  }

  const challengeId = validateChallengeId(payload.challengeId);
  const parsedChallenge = parseDailyChallengeId(challengeId);
  if (
    !parsedChallenge ||
    typeof payload.rulesetVersion !== "number" ||
    !Number.isSafeInteger(payload.rulesetVersion) ||
    payload.rulesetVersion !== DAILY_RULESET_VERSION ||
    parsedChallenge.rulesetVersion !== payload.rulesetVersion
  ) {
    throw new ScoreRequestError(400, "That daily challenge is not valid.");
  }

  const now = new Date();
  const currentUtcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (
    parsedChallenge.timestamp !== currentUtcDay &&
    parsedChallenge.timestamp !== currentUtcDay - ONE_DAY_MILLISECONDS
  ) {
    throw new ScoreRequestError(
      400,
      "Only the current or previous daily challenge can start a ranked shift.",
    );
  }

  return {
    challengeId,
    rulesetVersion: payload.rulesetVersion,
  };
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }

  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }
}

async function getScoreboardKey() {
  const { env } = await import("cloudflare:workers");
  const secret = env.SCOREBOARD_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new ScoreboardConfigurationError(
      "SCOREBOARD_SECRET must be configured as a hosted secret with at least 32 characters.",
    );
  }

  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function getSourceAddress(request: Request) {
  const sourceAddress = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  if (
    sourceAddress.length < 3 ||
    sourceAddress.length > 64 ||
    !/^[0-9a-f:.]+$/iu.test(sourceAddress)
  ) {
    throw new ScoreRequestError(
      503,
      "The scoreboard could not verify this network connection.",
    );
  }
  return sourceAddress.toLowerCase();
}

async function sourceHash(request: Request, key: CryptoKey) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`meter-mayhem-source:${getSourceAddress(request)}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function sessionSignature(encodedClaims: string, key: CryptoKey) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`meter-mayhem-shift:${encodedClaims}`),
  );
  return new Uint8Array(signature);
}

export async function issueShiftSession(
  request: Request,
  payload: Record<string, unknown>,
) {
  const challenge = validateDailySessionPayload(payload);
  const key = await getScoreboardKey();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims: ShiftSessionClaims = {
    version: 2,
    runId: crypto.randomUUID(),
    sourceHash: await sourceHash(request, key),
    issuedAt,
    challengeId: challenge.challengeId,
    rulesetVersion: challenge.rulesetVersion,
  };
  const encodedClaims = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await sessionSignature(encodedClaims, key);
  const token = `${encodedClaims}.${base64UrlEncode(signature)}`;

  return {
    session: {
      runId: claims.runId,
      issuedAt,
      token,
      challengeId: claims.challengeId,
      rulesetVersion: claims.rulesetVersion,
    },
  };
}

export async function verifyShiftSession(
  token: unknown,
  request: Request,
) {
  if (typeof token !== "string" || token.length < 80 || token.length > 1_024) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }

  const tokenParts = token.split(".");
  if (tokenParts.length !== 2) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }
  const [encodedClaims, encodedSignature] = tokenParts;

  const key = await getScoreboardKey();
  const expectedSourceHash = await sourceHash(request, key);
  const suppliedSignature = base64UrlDecode(encodedSignature);
  const signatureIsValid = await crypto.subtle.verify(
    "HMAC",
    key,
    suppliedSignature,
    encoder.encode(`meter-mayhem-shift:${encodedClaims}`),
  );
  if (!signatureIsValid) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }

  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(base64UrlDecode(encodedClaims)));
  } catch {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }
  if (
    !isRecord(claims) ||
    claims.version !== 2 ||
    typeof claims.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      claims.runId,
    ) ||
    typeof claims.sourceHash !== "string" ||
    claims.sourceHash !== expectedSourceHash ||
    typeof claims.issuedAt !== "number" ||
    !Number.isSafeInteger(claims.issuedAt) ||
    typeof claims.challengeId !== "string" ||
    !parseDailyChallengeId(claims.challengeId) ||
    typeof claims.rulesetVersion !== "number" ||
    !Number.isSafeInteger(claims.rulesetVersion) ||
    claims.rulesetVersion !== DAILY_RULESET_VERSION ||
    parseDailyChallengeId(claims.challengeId)?.rulesetVersion !==
      claims.rulesetVersion
  ) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }

  const ageSeconds = Math.floor(Date.now() / 1_000) - claims.issuedAt;
  if (ageSeconds < SCORE_LIMITS.minimumSessionAgeSeconds) {
    throw new ScoreRequestError(
      400,
      "Complete at least 75 seconds of the shift before saving a global score.",
    );
  }
  if (ageSeconds > SCORE_LIMITS.maximumSessionAgeSeconds) {
    throw new ScoreRequestError(
      410,
      "This shift session expired. Start a new patrol to post another score.",
    );
  }

  return {
    runId: claims.runId,
    sourceHash: claims.sourceHash,
    issuedAt: claims.issuedAt,
    ageSeconds,
    challengeId: claims.challengeId,
    rulesetVersion: claims.rulesetVersion,
  };
}

export async function readJsonObject(
  request: Request,
  maximumBytes: number = SCORE_LIMITS.bodyBytes,
) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ScoreRequestError(415, "Scores must be sent as JSON.");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > maximumBytes)
  ) {
    throw new ScoreRequestError(413, "The score request is too large.");
  }

  if (!request.body) {
    throw new ScoreRequestError(400, "The score request body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ScoreRequestError(413, "The score request is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ScoreRequestError) throw error;
    throw new ScoreRequestError(400, "The score request body could not be read.");
  }

  if (totalBytes === 0) {
    throw new ScoreRequestError(400, "The score request body is required.");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(strictDecoder.decode(bytes));
  } catch {
    throw new ScoreRequestError(400, "The score request was not valid JSON.");
  }
  if (!isRecord(payload)) {
    throw new ScoreRequestError(400, "The score request must be a JSON object.");
  }
  return payload;
}
