import {
  issueShiftSession,
  ScoreboardConfigurationError,
  ScoreRequestError,
  scoreResponse,
} from "../server";

export async function POST(request: Request) {
  try {
    return scoreResponse(await issueShiftSession(request), 201);
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
    return scoreResponse(
      { error: "A shift session could not be created." },
      503,
    );
  }
}
