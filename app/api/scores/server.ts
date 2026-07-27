const encoder = new TextEncoder();
const decoder = new TextDecoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export const SCORE_LIMITS = {
  bodyBytes: 2_048,
  maxNameLength: 18,
  maxTickets: 24,
  maxBoots: 24,
  maxAcceptedPerHour: 10,
  retainedScores: 500,
  minimumSessionAgeSeconds: 75,
  maximumSessionAgeSeconds: 600,
} as const;

type ShiftSessionClaims = {
  version: 1;
  runId: string;
  sourceHash: string;
  issuedAt: number;
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

export async function issueShiftSession(request: Request) {
  const key = await getScoreboardKey();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims: ShiftSessionClaims = {
    version: 1,
    runId: crypto.randomUUID(),
    sourceHash: await sourceHash(request, key),
    issuedAt,
  };
  const encodedClaims = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await sessionSignature(encodedClaims, key);
  const token = `${encodedClaims}.${base64UrlEncode(signature)}`;

  return {
    session: {
      runId: claims.runId,
      issuedAt,
      token,
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
    claims.version !== 1 ||
    typeof claims.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      claims.runId,
    ) ||
    typeof claims.sourceHash !== "string" ||
    claims.sourceHash !== expectedSourceHash ||
    typeof claims.issuedAt !== "number" ||
    !Number.isSafeInteger(claims.issuedAt)
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
  };
}

export async function readJsonObject(request: Request) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ScoreRequestError(415, "Scores must be sent as JSON.");
  }

  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > SCORE_LIMITS.bodyBytes)
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
      if (totalBytes > SCORE_LIMITS.bodyBytes) {
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
