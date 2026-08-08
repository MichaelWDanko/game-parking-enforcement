import { and, asc, count, desc, eq, gt } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { scores } from "../../../db/schema";
import {
  expectedDailyChallenge,
  readJsonObject,
  SCORE_LIMITS,
  ScoreboardConfigurationError,
  ScoreRequestError,
  scoreResponse,
  validateChallengeId,
  verifyShiftSession,
} from "./server";

const EXPECTED_SCORE_FIELDS = new Set([
  "runId",
  "issuedAt",
  "token",
  "playerName",
  "score",
  "tickets",
  "boots",
  "challengeId",
  "rulesetVersion",
  "objectiveId",
  "objectiveCompleted",
  "objectiveBonus",
]);

type ValidatedScorePayload = {
  runId: string;
  issuedAt: number;
  token: string;
  playerName: string;
  score: number;
  tickets: number;
  boots: number;
  challengeId: string;
  rulesetVersion: number;
  objectiveId: string | null;
  objectiveCompleted: boolean;
  objectiveBonus: number;
};

function normalizeName(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

function isSafeName(name: string) {
  return (
    name.length >= 2 &&
    name.length <= SCORE_LIMITS.maxNameLength &&
    /^[\p{L}\p{N} ._'-]+$/u.test(name)
  );
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validateObjectiveId(value: unknown) {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > SCORE_LIMITS.maxObjectiveIdLength ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    throw new ScoreRequestError(400, "That dispatch objective is not valid.");
  }
  return value;
}

function validatePayload(
  payload: Record<string, unknown>,
): ValidatedScorePayload {
  if (Object.keys(payload).some((key) => !EXPECTED_SCORE_FIELDS.has(key))) {
    throw new ScoreRequestError(
      400,
      "The score request contains unsupported fields.",
    );
  }

  const playerName = normalizeName(payload.playerName);
  const challengeId = validateChallengeId(payload.challengeId);
  const objectiveId = validateObjectiveId(payload.objectiveId);
  if (
    typeof payload.runId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      payload.runId,
    ) ||
    typeof payload.issuedAt !== "number" ||
    !Number.isSafeInteger(payload.issuedAt) ||
    typeof payload.token !== "string" ||
    payload.token.length > 1_024
  ) {
    throw new ScoreRequestError(400, "This shift session is not valid.");
  }
  if (!isSafeName(playerName)) {
    throw new ScoreRequestError(
      400,
      `Names must be 2–${SCORE_LIMITS.maxNameLength} letters, numbers, spaces, periods, apostrophes, underscores, or hyphens.`,
    );
  }
  if (
    !isIntegerInRange(payload.score, 0, SCORE_LIMITS.maxScore) ||
    !isIntegerInRange(payload.tickets, 0, SCORE_LIMITS.maxTickets) ||
    !isIntegerInRange(payload.boots, 0, SCORE_LIMITS.maxBoots) ||
    !isIntegerInRange(payload.rulesetVersion, 1, 999) ||
    typeof payload.objectiveCompleted !== "boolean" ||
    !isIntegerInRange(
      payload.objectiveBonus,
      0,
      SCORE_LIMITS.maxObjectiveBonus,
    ) ||
    payload.boots > payload.tickets ||
    payload.score % 5 !== 0
  ) {
    throw new ScoreRequestError(
      400,
      "That shift result is outside the valid range.",
    );
  }

  if (
    (!payload.objectiveCompleted && payload.objectiveBonus !== 0) ||
    (objectiveId === null &&
      (payload.objectiveCompleted || payload.objectiveBonus !== 0))
  ) {
    throw new ScoreRequestError(
      400,
      "That objective result does not match the shift results.",
    );
  }

  const expectedChallenge = expectedDailyChallenge(challengeId);
  if (
    !expectedChallenge ||
    payload.rulesetVersion !== expectedChallenge.rulesetVersion ||
    objectiveId !== expectedChallenge.objective.id ||
    payload.objectiveBonus !==
      (payload.objectiveCompleted ? expectedChallenge.bonus : 0)
  ) {
    throw new ScoreRequestError(400, "That objective result does not match dispatch.");
  }

  const maximumTicketScore =
    payload.tickets * 100 +
    10 * payload.tickets * (payload.tickets - 1);
  const maximumPossibleScore =
    maximumTicketScore + payload.boots * 250 + payload.objectiveBonus;
  if (payload.score > maximumPossibleScore) {
    throw new ScoreRequestError(
      400,
      "That score does not match the shift results.",
    );
  }

  return {
    runId: payload.runId,
    issuedAt: payload.issuedAt,
    token: payload.token,
    playerName,
    score: payload.score,
    tickets: payload.tickets,
    boots: payload.boots,
    challengeId,
    rulesetVersion: payload.rulesetVersion,
    objectiveId,
    objectiveCompleted: payload.objectiveCompleted,
    objectiveBonus: payload.objectiveBonus,
  };
}

function publicScore(row: typeof scores.$inferSelect) {
  return {
    entryId: String(row.id),
    playerName: row.playerName,
    score: row.score,
    tickets: row.tickets,
    boots: row.boots,
    challengeId: row.challengeId,
    rulesetVersion: row.rulesetVersion,
    objectiveId: row.objectiveId,
    objectiveCompleted: row.objectiveCompleted,
    objectiveBonus: row.objectiveBonus,
    createdAt: row.createdAt,
  };
}

export async function GET(request: Request) {
  try {
    const challengeParams = new URL(request.url).searchParams.getAll(
      "challengeId",
    );
    if (challengeParams.length > 1) {
      throw new ScoreRequestError(
        400,
        "Only one leaderboard challenge can be requested.",
      );
    }
    const challengeId = challengeParams.length
      ? validateChallengeId(challengeParams[0])
      : null;
    const db = await getDb();
    const rows = challengeId
      ? await db
          .select()
          .from(scores)
          .where(eq(scores.challengeId, challengeId))
          .orderBy(desc(scores.score), asc(scores.createdAt), asc(scores.id))
          .limit(10)
      : await db
          .select()
          .from(scores)
          .orderBy(desc(scores.score), asc(scores.createdAt), asc(scores.id))
          .limit(10);

    return scoreResponse({ scores: rows.map(publicScore) });
  } catch (error) {
    if (error instanceof ScoreRequestError) {
      return scoreResponse({ error: error.message }, error.status);
    }
    return scoreResponse(
      { error: "The global scores are temporarily unavailable." },
      503,
    );
  }
}

export async function POST(request: Request) {
  let validated: ValidatedScorePayload;
  let session: Awaited<ReturnType<typeof verifyShiftSession>>;
  try {
    validated = validatePayload(await readJsonObject(request));
    session = await verifyShiftSession(validated.token, request);
    if (
      validated.runId !== session.runId ||
      validated.issuedAt !== session.issuedAt ||
      validated.challengeId !== session.challengeId ||
      validated.rulesetVersion !== session.rulesetVersion
    ) {
      throw new ScoreRequestError(
        400,
        "The shift details do not match the signed session.",
      );
    }
  } catch (error) {
    if (error instanceof ScoreRequestError) {
      return scoreResponse({ error: error.message }, error.status);
    }
    if (error instanceof ScoreboardConfigurationError) {
      return scoreResponse(
        { error: "The global scoreboard is not configured yet." },
        503,
      );
    }
    return scoreResponse({ error: "The score request was not valid." }, 400);
  }

  try {
    const d1 = await getD1();
    const now = Math.floor(Date.now() / 1_000);
    const rateWindowStart = now - 3_600;
    const batchResults = await d1.batch([
      d1
        .prepare("DELETE FROM score_rate_limits WHERE created_at < ?")
        .bind(rateWindowStart),
      d1
        .prepare(
          `INSERT INTO score_rate_limits
            (session_id, source_hash, created_at)
           SELECT ?, ?, ?
           WHERE (
             SELECT COUNT(*)
             FROM score_rate_limits
             WHERE source_hash = ? AND created_at >= ?
           ) < ?
           ON CONFLICT(session_id) DO NOTHING`,
        )
        .bind(
          session.runId,
          session.sourceHash,
          now,
          session.sourceHash,
          rateWindowStart,
          SCORE_LIMITS.maxAcceptedPerHour,
        ),
      d1
        .prepare(
          `INSERT INTO scores
            (run_id, player_name, score, tickets, boots, challenge_id,
             ruleset_version, objective_id, objective_completed, objective_bonus)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM score_rate_limits
             WHERE session_id = ? AND source_hash = ?
           )
           ON CONFLICT(run_id) DO NOTHING`,
        )
        .bind(
          session.runId,
          validated.playerName,
          validated.score,
          validated.tickets,
          validated.boots,
          validated.challengeId,
          validated.rulesetVersion,
          validated.objectiveId,
          validated.objectiveCompleted ? 1 : 0,
          validated.objectiveBonus,
          session.runId,
          session.sourceHash,
        ),
    ]);

    const db = await getDb();
    const [stored] = await db
      .select()
      .from(scores)
      .where(eq(scores.runId, session.runId))
      .limit(1);
    if (!stored) {
      return scoreResponse(
        {
          error:
            "This network has reached the limit of 10 global scores per hour.",
        },
        429,
      );
    }

    const [{ totalAbove }] = await db
      .select({ totalAbove: count() })
      .from(scores)
      .where(
        and(
          eq(scores.challengeId, stored.challengeId),
          gt(scores.score, stored.score),
        ),
      );

    await d1.batch([
      d1
        .prepare(
          `DELETE FROM scores
           WHERE id IN (
             SELECT id
             FROM scores
             WHERE challenge_id = ?
             ORDER BY score DESC, created_at ASC, id ASC
             LIMIT -1 OFFSET ?
           )`,
        )
        .bind(stored.challengeId, SCORE_LIMITS.retainedScores),
      d1
        .prepare("DELETE FROM score_rate_limits WHERE created_at < ?")
        .bind(rateWindowStart),
    ]);

    const rateMarkerWasInserted =
      Number(batchResults[1]?.meta?.changes ?? 0) > 0;
    return scoreResponse(
      {
        score: publicScore(stored),
        rank: Number(totalAbove) + 1,
      },
      rateMarkerWasInserted ? 201 : 200,
    );
  } catch {
    return scoreResponse(
      { error: "The global score could not be saved." },
      503,
    );
  }
}
