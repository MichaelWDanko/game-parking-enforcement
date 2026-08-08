"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as THREE from "three";
import {
  CITY_THEME_BY_ID,
  CITY_THEMES,
  DEFAULT_CITY_ID,
  colorToCss,
  isCityId,
  type CityId,
} from "./city-themes";
import {
  DAILY_RULESET_VERSION,
  FIXED_STEP_SECONDS,
  GHOST_RUN_VERSION,
  SHIFT_DURATION_SECONDS,
  createSeededRandom,
  dailyChallengeForDate,
  evaluateObjective,
  sampleGhostAt,
  type GhostRun,
  type ObjectiveEvaluation,
  type ObjectiveMetrics,
} from "./daily-dispatch";
import { GameFeedback, firstConnectedGamepad } from "./game-feedback";
import { loadPersonalBestGhost, savePersonalBestGhost } from "./ghost-store";
import styles from "./parking-game.module.css";
import {
  nearestTrafficGap,
  parkingRoutePosition,
  parkingTravelDirection,
  TRAFFIC_BRAKE_DISTANCE,
  TRAFFIC_LOOP_MAX,
  TRAFFIC_LOOP_MIN,
  trafficVehiclesOverlap,
  type TrafficAxis,
  type TrafficVehiclePosition,
} from "./traffic-collision";
import {
  OFFICER_COLLISION_RADIUS,
  WorldCollisionIndex,
  circleFitsWalkableArea,
  circleIntersectsCollider,
  createBuildingCollider,
  createChunkSceneryColliders,
  createFountainCollider,
  createParkingMeterCollider,
  createVehicleCollider,
} from "./world-collision";

type Screen = "loading" | "home" | "playing" | "gameover";
type ActionKind = "ticket" | "lookup" | "boot";
type KeyboardScheme = "arrows" | "wasd";
type GraphicsMode = "auto" | "performance" | "balanced" | "quality";
type BoardScope = "daily" | "all";

type GraphicsProfile = {
  label: string;
  pixelRatio: number;
  shadows: boolean;
  fogNear: number;
  fogFar: number;
  details: boolean;
};

type WorldChunkDefinition = {
  id: string;
  name: string;
  centerZ: number;
  file: string;
  initial?: boolean;
};

type WorldManifest = {
  district: string;
  chunks: WorldChunkDefinition[];
};

type WorldBuilding = {
  side: -1 | 1;
  z: number;
  width: number;
  height: number;
  depth: number;
  color: string;
  accent: string;
};

type WorldTree = {
  side: -1 | 1;
  z: number;
  color: string;
};

type WorldChunkData = {
  id: string;
  name: string;
  buildings: WorldBuilding[];
  trees: WorldTree[];
  lamps: { side: -1 | 1; z: number }[];
};

type Stats = {
  score: number;
  tickets: number;
  boots: number;
  combo: number;
  timeLeft: number;
  fps: number;
};

type CarContext = {
  plate: string;
  seconds: number;
  expired: boolean;
  priors: number;
  lookedUp: boolean;
  ticketed: boolean;
  booted: boolean;
  priority: boolean;
} | null;

type GameResult = {
  runId: string;
  issuedAt: number;
  token: string;
  score: number;
  tickets: number;
  boots: number;
  best: number;
  challengeId: string;
  rulesetVersion: number;
  objectiveId: string;
  objectiveCompleted: boolean;
  objectiveBonus: number;
  ranked: boolean;
  rankedReason: string;
  ghostSaved: boolean;
};

type ShiftSession = Pick<
  GameResult,
  "runId" | "issuedAt" | "token" | "challengeId" | "rulesetVersion"
>;

type GlobalScore = {
  entryId: string;
  playerName: string;
  score: number;
  tickets: number;
  boots: number;
  challengeId: string;
  rulesetVersion: number;
  objectiveId: string | null;
  objectiveCompleted: boolean;
  objectiveBonus: number;
  createdAt: string;
};

type ScoreStatus =
  | { kind: "idle"; message: string }
  | { kind: "saving"; message: string }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

type CarData = {
  plate: string;
  priors: number;
  color: number;
  expireAt: number;
  departAt: number;
  ticketed: boolean;
  booted: boolean;
  lookedUp: boolean;
  priority: boolean;
  phase: "arriving" | "parked" | "leaving";
  phaseTime: number;
  driveRate: number;
  group: THREE.Group;
  ticketMesh?: THREE.Mesh;
  bootMesh?: THREE.Mesh;
};

type ParkingSpot = {
  axis: TrafficAxis;
  x: number;
  z: number;
  side: number;
  meterLight: THREE.Mesh;
  car: CarData | null;
  respawnAt: number;
};

type MovingCar = {
  group: THREE.Group;
  speed: number;
  cruiseSpeed: number;
  axis: TrafficAxis;
  initialPosition: THREE.Vector3;
};

type BuildingThemeTarget = {
  body: THREE.MeshStandardMaterial;
  accents: THREE.MeshStandardMaterial[];
  index: number;
};

const INITIAL_STATS: Stats = {
  score: 0,
  tickets: 0,
  boots: 0,
  combo: 0,
  timeLeft: SHIFT_DURATION_SECONDS,
  fps: 60,
};

const PLATE_STARTS = ["ZIP", "MTR", "BEEP", "PARK", "TKT", "VROOM", "CITY"];
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const GRAPHICS_PROFILES: Record<Exclude<GraphicsMode, "auto">, GraphicsProfile> = {
  performance: {
    label: "Performance",
    pixelRatio: 0.9,
    shadows: false,
    fogNear: 30,
    fogFar: 64,
    details: false,
  },
  balanced: {
    label: "Balanced",
    pixelRatio: 1.25,
    shadows: true,
    fogNear: 44,
    fogFar: 88,
    details: true,
  },
  quality: {
    label: "Quality",
    pixelRatio: 1.8,
    shadows: true,
    fogNear: 56,
    fogFar: 118,
    details: true,
  },
};
const GRAPHICS_CHOICES: { mode: GraphicsMode; label: string; note: string }[] = [
  { mode: "auto", label: "Auto", note: "Best fit for this device" },
  { mode: "performance", label: "Performance", note: "Crisp motion, fewer effects" },
  { mode: "balanced", label: "Balanced", note: "Shadows and street detail" },
  { mode: "quality", label: "Quality", note: "Sharpest view, full atmosphere" },
];

function assetPath(path: string) {
  return `${PUBLIC_BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

function resolveGraphicsProfile(mode: GraphicsMode): GraphicsProfile {
  if (mode !== "auto") return GRAPHICS_PROFILES[mode];
  if (typeof navigator === "undefined") return GRAPHICS_PROFILES.balanced;

  const device = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  const strongDevice =
    Boolean(device.gpu) &&
    (device.deviceMemory ?? 4) >= 8 &&
    (navigator.hardwareConcurrency ?? 4) >= 8;
  const modestDevice =
    (device.deviceMemory ?? 4) <= 4 || (navigator.hardwareConcurrency ?? 4) <= 4;

  if (strongDevice) return { ...GRAPHICS_PROFILES.quality, label: "Auto · Quality" };
  if (modestDevice) return { ...GRAPHICS_PROFILES.performance, label: "Auto · Performance" };
  return { ...GRAPHICS_PROFILES.balanced, label: "Auto · Balanced" };
}

function damp(current: number, target: number, smoothing: number, dt: number) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-smoothing * dt));
}

function dampAngle(current: number, target: number, smoothing: number, dt: number) {
  let difference = (target - current + Math.PI) % (Math.PI * 2);
  if (difference < 0) difference += Math.PI * 2;
  difference -= Math.PI;
  return current + difference * (1 - Math.exp(-smoothing * dt));
}

function roundedBox(
  width: number,
  height: number,
  depth: number,
  color: number,
  roughness = 0.8,
) {
  return new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth, 2, 2, 2),
    new THREE.MeshStandardMaterial({ color, roughness }),
  );
}

function addShadow(mesh: THREE.Object3D) {
  mesh.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    childMaterials.forEach((material) => materials.add(material));
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function createOfficer() {
  const root = new THREE.Group();
  const body = roundedBox(0.84, 1.1, 0.48, 0x284b75);
  body.position.y = 1.72;
  root.add(body);

  const vest = roundedBox(0.9, 0.56, 0.53, 0xffd45b);
  vest.position.set(0, 1.72, 0.01);
  root.add(vest);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xb87552, roughness: 0.9 }),
  );
  head.position.y = 2.58;
  root.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.37, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.56),
    new THREE.MeshStandardMaterial({ color: 0x273144, roughness: 0.95 }),
  );
  hair.position.y = 2.68;
  root.add(hair);

  const hatBrim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.43, 0.43, 0.08, 16),
    new THREE.MeshStandardMaterial({ color: 0x284b75 }),
  );
  hatBrim.position.y = 2.91;
  root.add(hatBrim);

  const hatTop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.34, 0.22, 16),
    new THREE.MeshStandardMaterial({ color: 0x284b75 }),
  );
  hatTop.position.y = 3.03;
  root.add(hatTop);

  const leftArm = new THREE.Group();
  const rightArm = new THREE.Group();
  const armGeometry = new THREE.CapsuleGeometry(0.14, 0.66, 4, 8);
  const uniformMaterial = new THREE.MeshStandardMaterial({ color: 0x284b75 });
  const leftArmMesh = new THREE.Mesh(armGeometry, uniformMaterial);
  const rightArmMesh = new THREE.Mesh(armGeometry, uniformMaterial);
  leftArmMesh.position.y = -0.38;
  rightArmMesh.position.y = -0.38;
  leftArm.add(leftArmMesh);
  rightArm.add(rightArmMesh);
  leftArm.position.set(-0.58, 2.14, 0);
  rightArm.position.set(0.58, 2.14, 0);
  root.add(leftArm, rightArm);

  const leftLeg = new THREE.Group();
  const rightLeg = new THREE.Group();
  const legGeometry = new THREE.CapsuleGeometry(0.16, 0.72, 4, 8);
  const pantsMaterial = new THREE.MeshStandardMaterial({ color: 0x213c60 });
  const leftLegMesh = new THREE.Mesh(legGeometry, pantsMaterial);
  const rightLegMesh = new THREE.Mesh(legGeometry, pantsMaterial);
  leftLegMesh.position.y = -0.45;
  rightLegMesh.position.y = -0.45;
  leftLeg.add(leftLegMesh);
  rightLeg.add(rightLegMesh);
  leftLeg.position.set(-0.25, 1.12, 0);
  rightLeg.position.set(0.25, 1.12, 0);
  root.add(leftLeg, rightLeg);

  const badge = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.1, 0),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.45 }),
  );
  badge.position.set(-0.2, 1.9, 0.3);
  root.add(badge);

  root.scale.setScalar(0.85);
  addShadow(root);
  return { root, leftArm, rightArm, leftLeg, rightLeg, body };
}

function createCar(color: number) {
  const car = new THREE.Group();
  const body = roundedBox(2.15, 0.62, 4.1, color, 0.55);
  body.position.y = 0.63;
  car.add(body);

  const cabin = roundedBox(1.74, 0.68, 2.15, 0xc9f2ff, 0.22);
  cabin.position.set(0, 1.18, -0.2);
  car.add(cabin);

  const roof = roundedBox(1.78, 0.12, 1.6, color, 0.5);
  roof.position.set(0, 1.57, -0.2);
  car.add(roof);
  car.userData.paintMaterials = [body.material, roof.material];

  const bumperMaterial = new THREE.MeshStandardMaterial({ color: 0x26364b, roughness: 0.7 });
  const wheelGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.28, 12);
  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x1b2533, roughness: 0.88 });
  for (const x of [-1.05, 1.05]) {
    for (const z of [-1.35, 1.35]) {
      const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.42, z);
      car.add(wheel);
    }
  }
  for (const z of [-2.08, 2.08]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.12), bumperMaterial);
    bumper.position.set(0, 0.48, z);
    car.add(bumper);
  }
  addShadow(car);
  return car;
}

function createMeter(side: number) {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.12, 1.7, 10),
    new THREE.MeshStandardMaterial({ color: 0x34465e, metalness: 0.25 }),
  );
  pole.position.y = 0.85;
  group.add(pole);

  const head = roundedBox(0.5, 0.55, 0.28, 0xf4f1df, 0.7);
  head.position.y = 1.78;
  group.add(head);

  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 12, 8),
    new THREE.MeshStandardMaterial({
      color: 0x48d6c8,
      emissive: 0x1a6e63,
      emissiveIntensity: 1.4,
    }),
  );
  light.position.set(-side * 0.26, 1.86, 0);
  group.add(light);
  addShadow(group);
  return { group, light };
}

function makePlate(random: () => number) {
  const word = PLATE_STARTS[Math.floor(random() * PLATE_STARTS.length)];
  return `${word}-${Math.floor(100 + random() * 900)}`;
}

function formatMeter(seconds: number) {
  if (seconds <= 0) return `Expired ${Math.abs(Math.ceil(seconds))}s`;
  return `Paid ${Math.ceil(seconds)}s`;
}

function resultTitle(score: number) {
  if (score >= 1800) return "Meter Legend";
  if (score >= 1100) return "Block Boss";
  if (score >= 600) return "Sharp-Eyed Officer";
  return "Rookie Patrol";
}

async function fetchWithTimeout(
  path: string,
  init: RequestInit = {},
  timeoutMs = 7_000,
) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export function ParkingGame() {
  const dailyChallenge = useMemo(() => dailyChallengeForDate(), []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef(new Set<string>());
  const actionsRef = useRef<((kind: ActionKind) => void) | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const endRef = useRef<(() => void) | null>(null);
  const startAttemptRef = useRef(false);
  const briefingDialogRef = useRef<HTMLDialogElement>(null);
  const briefingStartRef = useRef<HTMLButtonElement>(null);
  const gameActiveRef = useRef(false);
  const audioOnRef = useRef(true);
  const applyGraphicsRef = useRef<((mode: GraphicsMode) => void) | null>(null);
  const applyCityRef = useRef<((cityId: CityId) => void) | null>(null);
  const cityIdRef = useRef<CityId>(DEFAULT_CITY_ID);
  const lastSubmittedRunRef = useRef("");
  const submissionInFlightRef = useRef("");
  const shiftSessionRef = useRef<ShiftSession | null>(null);
  const ghostRunRef = useRef<GhostRun | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [screen, setScreen] = useState<Screen>("loading");
  const [loadProgress, setLoadProgress] = useState(0);
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);
  const [context, setContext] = useState<CarContext>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [objectiveOpen, setObjectiveOpen] = useState(false);
  const [result, setResult] = useState<GameResult>({
    runId: "",
    issuedAt: 0,
    token: "",
    score: 0,
    tickets: 0,
    boots: 0,
    best: 0,
    challengeId: dailyChallenge.id,
    rulesetVersion: DAILY_RULESET_VERSION,
    objectiveId: dailyChallenge.objective.id,
    objectiveCompleted: false,
    objectiveBonus: 0,
    ranked: false,
    rankedReason: "Finish the full shift to enter the daily board.",
    ghostSaved: false,
  });
  const [audioOn, setAudioOn] = useState(true);
  const [controllerConnected, setControllerConnected] = useState(false);
  const [graphicsMode, setGraphicsMode] = useState<GraphicsMode>("auto");
  const graphicsModeRef = useRef<GraphicsMode>("auto");
  const [graphicsOpen, setGraphicsOpen] = useState(false);
  const [graphicsLabel, setGraphicsLabel] = useState("Auto");
  const [cityId, setCityId] = useState<CityId>(DEFAULT_CITY_ID);
  const [streamStatus, setStreamStatus] = useState(
    `Opening the ${CITY_THEME_BY_ID[DEFAULT_CITY_ID].name} map`,
  );
  const [playerName, setPlayerName] = useState("");
  const [nameError, setNameError] = useState("");
  const [boardScope, setBoardScope] = useState<BoardScope>("daily");
  const [scoresByScope, setScoresByScope] = useState<Record<BoardScope, GlobalScore[]>>({
    daily: [],
    all: [],
  });
  const [scoresLoading, setScoresLoading] = useState(true);
  const [scoresError, setScoresError] = useState(false);
  const [lastSavedScore, setLastSavedScore] = useState<GlobalScore | null>(null);
  const [starting, setStarting] = useState(false);
  const [ghostAvailable, setGhostAvailable] = useState(false);
  const [objectiveStatus, setObjectiveStatus] = useState<ObjectiveEvaluation>(() =>
    evaluateObjective(dailyChallenge.objective, {
      tickets: 0,
      boots: 0,
      maxCombo: 0,
      firstTicketAtSeconds: null,
      distanceMeters: 0,
    }),
  );
  const [scoreStatus, setScoreStatus] = useState<ScoreStatus>({
    kind: "idle",
    message: "Your result will be added to the global board.",
  });
  const city = CITY_THEME_BY_ID[cityId];
  const globalScores = scoresByScope[boardScope];

  const clearToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, durationMs = 2_800) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setObjectiveOpen(false);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, durationMs);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    const dialog = briefingDialogRef.current;
    if (!dialog) return;
    if (briefingOpen && !dialog.open) {
      dialog.showModal();
      briefingStartRef.current?.focus();
    } else if (!briefingOpen && dialog.open) {
      dialog.close();
    }
  }, [briefingOpen]);

  useEffect(() => {
    const saved = window.localStorage.getItem("meter-mayhem-graphics") as GraphicsMode | null;
    const savedName = window.localStorage.getItem("meter-mayhem-player-name");
    const savedCity = window.localStorage.getItem("meter-mayhem-city");
    if (!saved && !savedName && !savedCity) return;
    const timer = window.setTimeout(() => {
      if (saved && ["auto", "performance", "balanced", "quality"].includes(saved)) {
        graphicsModeRef.current = saved;
        setGraphicsMode(saved);
        applyGraphicsRef.current?.(saved);
      }
      if (savedName) setPlayerName(savedName.slice(0, 18));
      if (isCityId(savedCity)) {
        cityIdRef.current = savedCity;
        setCityId(savedCity);
        applyCityRef.current?.(savedCity);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPersonalBestGhost(dailyChallenge.id).then((ghost) => {
      if (cancelled) return;
      const matchingGhost = ghost?.rulesetVersion === DAILY_RULESET_VERSION ? ghost : null;
      ghostRunRef.current = matchingGhost;
      setGhostAvailable(Boolean(matchingGhost));
    });
    return () => {
      cancelled = true;
    };
  }, [dailyChallenge.id]);

  const refreshScores = useCallback(async (scope: BoardScope) => {
    setScoresLoading(true);
    setScoresError(false);
    try {
      const query = scope === "daily"
        ? `?challengeId=${encodeURIComponent(dailyChallenge.id)}`
        : "";
      const response = await fetchWithTimeout(`/api/scores${query}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Scores unavailable");
      const payload = (await response.json()) as { scores?: GlobalScore[] };
      const nextScores = Array.isArray(payload.scores) ? payload.scores.slice(0, 10) : [];
      setScoresByScope((current) => ({ ...current, [scope]: nextScores }));
    } catch {
      setScoresError(true);
    } finally {
      setScoresLoading(false);
    }
  }, [dailyChallenge.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshScores(boardScope), 0);
    return () => window.clearTimeout(timer);
  }, [boardScope, refreshScores]);

  const submitScore = useCallback(async (gameResult: GameResult) => {
    if (!gameResult.ranked) {
      setScoreStatus({ kind: "idle", message: gameResult.rankedReason });
      return;
    }
    if (!gameResult.token) {
      setScoreStatus({
        kind: "error",
        message: "Dispatch was offline when this shift began. Your local best is still saved.",
      });
      return;
    }
    if (
      lastSubmittedRunRef.current === gameResult.runId ||
      submissionInFlightRef.current === gameResult.runId
    ) {
      return;
    }

    submissionInFlightRef.current = gameResult.runId;
    setScoreStatus({ kind: "saving", message: "Adding your score to the global board…" });
    try {
      const response = await fetchWithTimeout("/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: gameResult.runId,
          issuedAt: gameResult.issuedAt,
          token: gameResult.token,
          playerName,
          score: gameResult.score,
          tickets: gameResult.tickets,
          boots: gameResult.boots,
          challengeId: gameResult.challengeId,
          rulesetVersion: gameResult.rulesetVersion,
          objectiveId: gameResult.objectiveId,
          objectiveCompleted: gameResult.objectiveCompleted,
          objectiveBonus: gameResult.objectiveBonus,
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        rank?: number;
        score?: GlobalScore;
      };
      if (!response.ok) throw new Error(payload.error ?? "Score not saved");
      lastSubmittedRunRef.current = gameResult.runId;
      if (payload.score) setLastSavedScore(payload.score);
      setScoreStatus({
        kind: "saved",
        message: payload.rank ? `Saved globally · rank #${payload.rank}` : "Saved globally",
      });
      setBoardScope("daily");
      await refreshScores("daily");
    } catch {
      setScoreStatus({
        kind: "error",
        message: "The score did not save. Your local best is safe.",
      });
    } finally {
      if (submissionInFlightRef.current === gameResult.runId) {
        submissionInFlightRef.current = "";
      }
    }
  }, [playerName, refreshScores]);

  useEffect(() => {
    if (screen !== "gameover" || !result.runId || !result.ranked || !result.token) return;
    const timer = window.setTimeout(() => void submitScore(result), 0);
    return () => window.clearTimeout(timer);
  }, [result, screen, submitScore]);

  useEffect(() => {
    gameActiveRef.current = screen === "playing";
  }, [screen]);

  useEffect(() => {
    audioOnRef.current = audioOn;
  }, [audioOn]);

  const selectGraphicsMode = useCallback((mode: GraphicsMode) => {
    graphicsModeRef.current = mode;
    setGraphicsMode(mode);
    window.localStorage.setItem("meter-mayhem-graphics", mode);
    applyGraphicsRef.current?.(mode);
  }, []);

  const selectCity = useCallback((nextCityId: CityId) => {
    cityIdRef.current = nextCityId;
    setCityId(nextCityId);
    window.localStorage.setItem("meter-mayhem-city", nextCityId);
    applyCityRef.current?.(nextCityId);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const visualRandom = createSeededRandom(dailyChallenge.seed ^ 0xa341316c);
    let gameplayRandom = createSeededRandom(dailyChallenge.seed);
    let incidentRandom = createSeededRandom(dailyChallenge.seed ^ 0xc8013ea4);

    const initialProfile = resolveGraphicsProfile(graphicsModeRef.current);
    const initialCityPalette = CITY_THEME_BY_ID[cityIdRef.current].palette;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialProfile.pixelRatio));
    renderer.shadowMap.enabled = initialProfile.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(initialCityPalette.sky);
    scene.fog = new THREE.Fog(
      initialCityPalette.fog,
      initialProfile.fogNear,
      initialProfile.fogFar,
    );

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 180);
    camera.position.set(14, 21, 19);
    const cameraTarget = new THREE.Vector3(0, 0, 7);

    const hemi = new THREE.HemisphereLight(
      initialCityPalette.hemisphereSky,
      initialCityPalette.hemisphereGround,
      2.4,
    );
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(initialCityPalette.sunlight, 4.2);
    sun.position.set(-12, 24, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -32;
    sun.shadow.camera.right = 32;
    sun.shadow.camera.top = 38;
    sun.shadow.camera.bottom = -38;
    scene.add(sun);

    const world = new THREE.Group();
    scene.add(world);
    const worldCollision = new WorldCollisionIndex();

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(116, 150),
      new THREE.MeshStandardMaterial({ color: initialCityPalette.ground, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.07;
    ground.receiveShadow = true;
    world.add(ground);

    const roadMaterial = new THREE.MeshStandardMaterial({
      color: initialCityPalette.road,
      roughness: 0.96,
    });
    const mainRoad = new THREE.Mesh(
      new THREE.PlaneGeometry(13.8, 112),
      roadMaterial,
    );
    mainRoad.rotation.x = -Math.PI / 2;
    mainRoad.position.y = 0;
    mainRoad.receiveShadow = true;
    mainRoad.name = "Main Street";
    world.add(mainRoad);

    const sidewalkMaterial = new THREE.MeshStandardMaterial({
      color: initialCityPalette.sidewalk,
      roughness: 1,
    });
    for (const x of [-9.25, 9.25]) {
      const sidewalk = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.24, 112), sidewalkMaterial);
      sidewalk.position.set(x, 0.08, 0);
      sidewalk.receiveShadow = true;
      world.add(sidewalk);
    }

    const stripeMaterial = new THREE.MeshBasicMaterial({ color: initialCityPalette.stripe });
    for (let z = -52; z <= 52; z += 8) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 3.9), stripeMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, 0.015, z);
      world.add(stripe);
    }

    const sideRoads = [
      { name: "Civic Avenue", z: 0, width: 100 },
      { name: "Garden Lane", z: 32, width: 76 },
    ];
    for (const sideRoad of sideRoads) {
      const road = new THREE.Mesh(
        new THREE.PlaneGeometry(sideRoad.width, 13.8),
        roadMaterial,
      );
      road.rotation.x = -Math.PI / 2;
      road.position.set(0, 0.006, sideRoad.z);
      road.receiveShadow = true;
      road.name = sideRoad.name;
      world.add(road);

      for (const zOffset of [-9.25, 9.25]) {
        const sidewalk = new THREE.Mesh(
          new THREE.BoxGeometry(sideRoad.width, 0.24, 4.6),
          sidewalkMaterial,
        );
        sidewalk.position.set(0, 0.08, sideRoad.z + zOffset);
        sidewalk.receiveShadow = true;
        world.add(sidewalk);
      }

      for (let x = -sideRoad.width / 2 + 4; x <= sideRoad.width / 2 - 4; x += 8) {
        if (Math.abs(x) < 9) continue;
        const stripe = new THREE.Mesh(new THREE.PlaneGeometry(3.9, 0.18), stripeMaterial);
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(x, 0.018, sideRoad.z);
        world.add(stripe);
      }
    }

    const plaza = new THREE.Mesh(
      new THREE.BoxGeometry(30, 0.18, 18),
      new THREE.MeshStandardMaterial({ color: initialCityPalette.plaza, roughness: 0.95 }),
    );
    plaza.position.set(29, 0.04, 46);
    plaza.receiveShadow = true;
    plaza.name = "Garden Plaza";
    world.add(plaza);

    const fountain = new THREE.Group();
    const fountainStone = new THREE.MeshStandardMaterial({
      color: initialCityPalette.fountainStone,
      roughness: 0.72,
    });
    const fountainWater = new THREE.MeshStandardMaterial({
      color: initialCityPalette.fountainWater,
      emissive: initialCityPalette.fountainGlow,
      emissiveIntensity: 0.35,
      roughness: 0.18,
    });
    const fountainBase = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.5, 0.6, 24),
      fountainStone,
    );
    fountainBase.position.y = 0.35;
    const fountainPool = new THREE.Mesh(
      new THREE.CylinderGeometry(2.75, 2.75, 0.12, 24),
      fountainWater,
    );
    fountainPool.position.y = 0.7;
    const fountainColumn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.75, 2.4, 16),
      fountainStone,
    );
    fountainColumn.position.y = 1.7;
    const fountainTop = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 10),
      fountainWater,
    );
    fountainTop.position.y = 3.1;
    fountain.add(fountainBase, fountainPool, fountainColumn, fountainTop);
    fountain.position.set(30, 0.14, 47);
    addShadow(fountain);
    world.add(fountain);
    worldCollision.add(createFountainCollider("fountain", 30, 47));

    const animatedTrees: THREE.Group[] = [];
    const qualityDetails: THREE.Object3D[] = [];
    const cameraOccluders: THREE.Group[] = [];
    const buildingThemeTargets: BuildingThemeTarget[] = [];
    const windowMaterials: THREE.MeshStandardMaterial[] = [];
    const treeTrunkMaterials: THREE.MeshStandardMaterial[] = [];
    const treeMaterials: THREE.MeshStandardMaterial[] = [];
    const lampPoleMaterials: THREE.MeshStandardMaterial[] = [];
    const lampBulbMaterials: THREE.MeshStandardMaterial[] = [];
    const cloudMaterials: THREE.MeshStandardMaterial[] = [];
    const cameraRaycaster = new THREE.Raycaster();
    const cameraFocus = new THREE.Vector3();
    const cameraRay = new THREE.Vector3();
    const loadedChunks = new Map<string, THREE.Group>();
    const loadingChunks = new Set<string>();
    let chunkManifest: WorldManifest | null = null;
    let disposed = false;

    const registerCameraOccluder = (group: THREE.Group) => {
      group.userData.cameraOccluder = true;
      cameraOccluders.push(group);
    };

    const isCrossStreetZ = (z: number) =>
      Math.abs(z) <= 11 || Math.abs(z - 32) <= 10;

    const addDistrictBuilding = (
      x: number,
      z: number,
      width: number,
      height: number,
      depth: number,
    ) => {
      const palette = CITY_THEME_BY_ID[cityIdRef.current].palette;
      const themeIndex = buildingThemeTargets.length;
      const color = palette.buildings[themeIndex % palette.buildings.length];
      const accent = palette.accents[themeIndex % palette.accents.length];
      const group = new THREE.Group();
      const building = roundedBox(width, height, depth, color);
      building.position.y = height / 2;
      const crown = roundedBox(width * 0.7, 0.5, depth * 0.7, accent, 0.7);
      crown.position.y = height + 0.18;
      const awning = roundedBox(width * 0.68, 0.34, 1.1, accent);
      awning.position.set(0, 2.2, -depth / 2 - 0.18);
      awning.rotation.x = -0.16;
      group.add(building, crown, awning);
      buildingThemeTargets.push({
        body: building.material,
        accents: [crown.material, awning.material],
        index: themeIndex,
      });

      const windowMaterial = new THREE.MeshStandardMaterial({
        color: palette.window,
        emissive: palette.windowGlow,
        emissiveIntensity: 0.45,
        roughness: 0.28,
      });
      windowMaterials.push(windowMaterial);
      const floorCount = Math.max(2, Math.floor(height / 2.8));
      for (let floor = 0; floor < floorCount; floor++) {
        for (const offset of [-width * 0.26, width * 0.26]) {
          const windowMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(Math.min(1.3, width * 0.22), 1.25),
            windowMaterial,
          );
          windowMesh.position.set(offset, 3 + floor * 2.3, -depth / 2 - 0.012);
          windowMesh.rotation.y = Math.PI;
          group.add(windowMesh);
          qualityDetails.push(windowMesh);
        }
      }

      group.position.set(x, 0, z);
      addShadow(group);
      registerCameraOccluder(group);
      world.add(group);
      worldCollision.add(
        createBuildingCollider(
          `district-building:${themeIndex}`,
          x,
          z,
          width,
          depth,
          "district-buildings",
        ),
      );
    };

    [
      [-39, -17, 11, 13, 9],
      [-24, -17, 10, 10, 9],
      [24, -17, 10, 15, 9],
      [39, -17, 11, 11, 9],
      [-39, 17, 11, 12, 9],
      [-24, 17, 10, 16, 9],
      [24, 17, 10, 11, 9],
      [39, 17, 11, 14, 9],
      [-32, 48, 12, 13, 10],
      [-18, 48, 10, 10, 10],
    ].forEach(([x, z, width, height, depth]) => {
      addDistrictBuilding(x, z, width, height, depth);
    });

    const createCityChunk = (data: WorldChunkData) => {
      const chunk = new THREE.Group();
      chunk.name = `city-chunk-${data.id}`;

      for (const item of data.buildings) {
        if (isCrossStreetZ(item.z)) continue;
        const palette = CITY_THEME_BY_ID[cityIdRef.current].palette;
        const themeIndex = buildingThemeTargets.length;
        const color = palette.buildings[themeIndex % palette.buildings.length];
        const accent = palette.accents[themeIndex % palette.accents.length];
        const buildingGroup = new THREE.Group();
        const building = roundedBox(item.width, item.height, item.depth, color);
        building.position.set(item.side * 17, item.height / 2, item.z);
        buildingGroup.add(building);

        const crown = roundedBox(item.width * 0.72, 0.5, item.depth * 0.72, accent, 0.7);
        crown.position.set(item.side * 17, item.height + 0.18, item.z);
        buildingGroup.add(crown);

        const awning = roundedBox(item.width * 0.68, 0.32, 1.2, accent);
        awning.position.set(
          item.side * 17 - item.side * (item.width / 2 + 0.15),
          2.15,
          item.z,
        );
        awning.rotation.z = item.side * -0.18;
        buildingGroup.add(awning);
        buildingThemeTargets.push({
          body: building.material,
          accents: [crown.material, awning.material],
          index: themeIndex,
        });

        const windowMaterial = new THREE.MeshStandardMaterial({
          color: palette.window,
          emissive: palette.windowGlow,
          emissiveIntensity: 0.5,
          roughness: 0.3,
        });
        windowMaterials.push(windowMaterial);
        const floors = Math.max(2, Math.floor(item.height / 2.7));
        for (let floor = 0; floor < floors; floor++) {
          for (const offset of [-2.2, 0, 2.2]) {
            if (Math.abs(offset) > item.depth / 2 - 0.8) continue;
            const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.18, 1.3), windowMaterial);
            windowMesh.position.set(
              item.side * 17 - item.side * (item.width / 2 + 0.012),
              3.05 + floor * 2.35,
              item.z + offset,
            );
            windowMesh.rotation.y = item.side > 0 ? -Math.PI / 2 : Math.PI / 2;
            buildingGroup.add(windowMesh);
            qualityDetails.push(windowMesh);
          }
        }
        addShadow(buildingGroup);
        registerCameraOccluder(buildingGroup);
        chunk.add(buildingGroup);
      }

      for (const item of data.trees) {
        if (isCrossStreetZ(item.z)) continue;
        const palette = CITY_THEME_BY_ID[cityIdRef.current].palette;
        const tree = new THREE.Group();
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: palette.treeTrunk });
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.24, 1.7, 8),
          trunkMaterial,
        );
        trunk.position.y = 0.85;
        const treeMaterial = new THREE.MeshStandardMaterial({
          color: palette.trees[treeMaterials.length % palette.trees.length],
          roughness: 0.94,
        });
        const crown = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1.1, 1),
          treeMaterial,
        );
        crown.position.y = 2.2;
        tree.add(trunk, crown);
        tree.position.set(item.side * 10.4, 0.2, item.z);
        tree.userData.windPhase = item.z * 0.37 + item.side;
        addShadow(tree);
        treeTrunkMaterials.push(trunkMaterial);
        treeMaterials.push(treeMaterial);
        animatedTrees.push(tree);
        chunk.add(tree);
      }

      for (const item of data.lamps) {
        if (isCrossStreetZ(item.z)) continue;
        const palette = CITY_THEME_BY_ID[cityIdRef.current].palette;
        const lamp = new THREE.Group();
        const poleMaterial = new THREE.MeshStandardMaterial({
          color: palette.lampPole,
          metalness: 0.35,
        });
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.11, 3.9, 10),
          poleMaterial,
        );
        pole.position.y = 1.95;
        const bulbMaterial = new THREE.MeshStandardMaterial({
          color: palette.lampBulb,
          emissive: palette.lampGlow,
          emissiveIntensity: 2.2,
        });
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 12, 8),
          bulbMaterial,
        );
        bulb.position.y = 3.95;
        lamp.add(pole, bulb);
        lamp.position.set(item.side * 11.25, 0.2, item.z);
        addShadow(lamp);
        lampPoleMaterials.push(poleMaterial);
        lampBulbMaterials.push(bulbMaterial);
        qualityDetails.push(bulb);
        chunk.add(lamp);
      }

      addShadow(chunk);
      return chunk;
    };

    const fallbackChunk = (definition: WorldChunkDefinition): WorldChunkData => ({
      id: definition.id,
      name: definition.name,
      buildings: [-1, 1].flatMap((side) =>
        [-6, 6].map((offset, index) => ({
          side: side as -1 | 1,
          z: definition.centerZ + offset,
          width: 8 + index,
          height: 10 + ((definition.centerZ + offset + 80) % 7),
          depth: 9,
          color: side < 0 ? "#ff6577" : "#7667e8",
          accent: index === 0 ? "#ffd45b" : "#48d6c8",
        })),
      ),
      trees: [-1, 1].flatMap((side) =>
        [-9, 1, 10].map((offset) => ({
          side: side as -1 | 1,
          z: definition.centerZ + offset,
          color: offset % 2 === 0 ? "#47b86c" : "#74c85a",
        })),
      ),
      lamps: [-1, 1].flatMap((side) =>
        [-7, 7].map((offset) => ({
          side: side as -1 | 1,
          z: definition.centerZ + offset,
        })),
      ),
    });

    const loadChunk = async (definition: WorldChunkDefinition) => {
      if (disposed || loadedChunks.has(definition.id) || loadingChunks.has(definition.id)) return;
      loadingChunks.add(definition.id);
      let data: WorldChunkData;
      try {
        const response = await fetch(assetPath(definition.file));
        if (!response.ok) throw new Error(`Chunk ${definition.id} returned ${response.status}`);
        data = (await response.json()) as WorldChunkData;
      } catch {
        data = fallbackChunk(definition);
      }
      if (disposed) return;
      const chunk = createCityChunk(data);
      const profile = resolveGraphicsProfile(graphicsModeRef.current);
      chunk.traverse((object) => {
        if (qualityDetails.includes(object)) object.visible = profile.details;
      });
      world.add(chunk);
      worldCollision.removeGroup(`chunk:${data.id}`);
      worldCollision.addMany(createChunkSceneryColliders(data));
      loadedChunks.set(definition.id, chunk);
      loadingChunks.delete(definition.id);
      setStreamStatus(
        `${loadedChunks.size}/${chunkManifest?.chunks.length ?? 5} ${
          CITY_THEME_BY_ID[cityIdRef.current].name
        } blocks ready`,
      );
    };

    const clouds: THREE.Group[] = [];
    for (let index = 0; index < 7; index++) {
      const cloud = new THREE.Group();
      const cloudMaterial = new THREE.MeshStandardMaterial({
        color: initialCityPalette.cloud,
        transparent: true,
        opacity: 0.72,
        roughness: 1,
      });
      cloudMaterials.push(cloudMaterial);
      for (const [x, y, scale] of [
        [-1.1, 0, 1],
        [0, 0.15, 1.3],
        [1.15, 0, 0.9],
      ]) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), cloudMaterial);
        puff.position.set(x, y, 0);
        puff.scale.setScalar(scale);
        cloud.add(puff);
      }
      cloud.position.set(-28 + index * 9, 28 + (index % 3) * 2.5, -42 + index * 15);
      cloud.scale.setScalar(1.1 + (index % 2) * 0.35);
      clouds.push(cloud);
      qualityDetails.push(cloud);
      world.add(cloud);
    }

    const motePositions = new Float32Array(90 * 3);
    for (let index = 0; index < 90; index++) {
      motePositions[index * 3] = (visualRandom() - 0.5) * 26;
      motePositions[index * 3 + 1] = 0.4 + visualRandom() * 7;
      motePositions[index * 3 + 2] = (visualRandom() - 0.5) * 105;
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
    const moteMaterial = new THREE.PointsMaterial({
      color: initialCityPalette.mote,
      size: 0.12,
      transparent: true,
      opacity: 0.58,
    });
    const motes = new THREE.Points(moteGeometry, moteMaterial);
    qualityDetails.push(motes);
    world.add(motes);

    const spots: ParkingSpot[] = [];
    let parkingMeterIndex = 0;
    const addParkingSpot = (axis: "x" | "z", side: number, along: number) => {
      worldCollision.add(
        createParkingMeterCollider(`parking-meter:${parkingMeterIndex++}`, {
          axis,
          side,
          along,
        }),
      );
      if (axis === "z") {
        const meter = createMeter(side);
        meter.group.position.set(side * 7.4, 0.2, along + 2.3);
        world.add(meter.group);
        spots.push({
          axis,
          x: side * 5.35,
          z: along,
          side,
          meterLight: meter.light,
          car: null,
          respawnAt: 0,
        });

        const marking = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(2.8, 0.02, 6.8)),
          new THREE.LineBasicMaterial({ color: 0xf7e9a7 }),
        );
        marking.position.set(side * 5.35, 0.025, along);
        world.add(marking);
        return;
      }

      const meter = createMeter(side);
      meter.group.rotation.y = Math.PI / 2;
      meter.group.position.set(along + 2.3, 0.2, side * 7.4);
      world.add(meter.group);
      spots.push({
        axis,
        x: along,
        z: side * 5.35,
        side,
        meterLight: meter.light,
        car: null,
        respawnAt: 0,
      });

      const marking = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(6.8, 0.02, 2.8)),
        new THREE.LineBasicMaterial({ color: 0xf7e9a7 }),
      );
      marking.position.set(along, 0.025, side * 5.35);
      world.add(marking);
    };

    for (const side of [-1, 1]) {
      for (const z of [-36, -12, 12, 36]) addParkingSpot("z", side, z);
      for (const x of [-35, -18, 18, 35]) addParkingSpot("x", side, x);
    }

    const officer = createOfficer();
    officer.root.position.set(-8.5, 0.15, -9);
    world.add(officer.root);

    const ghostOfficer = officer.root.clone(true);
    ghostOfficer.name = "Personal best ghost";
    ghostOfficer.visible = false;
    ghostOfficer.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = false;
      object.receiveShadow = false;
      const sourceMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      const ghostMaterials = sourceMaterials.map((sourceMaterial) => {
        const material = sourceMaterial.clone();
        material.transparent = true;
        material.opacity = 0.24;
        material.depthWrite = false;
        return material;
      });
      object.material = Array.isArray(object.material) ? ghostMaterials : ghostMaterials[0];
    });
    world.add(ghostOfficer);

    const movingCars: MovingCar[] = [];
    const initialCarColors = CITY_THEME_BY_ID[cityIdRef.current].palette.cars;
    for (let i = 0; i < 6; i++) {
      const group = createCar(initialCarColors[(i + 2) % initialCarColors.length]);
      group.scale.setScalar(0.82);
      const lane = i % 2 === 0 ? -1.9 : 1.9;
      group.position.set(lane, 0.08, -50 + i * 20);
      if (lane > 0) group.rotation.y = Math.PI;
      world.add(group);
      const cruiseSpeed = lane < 0 ? 5.2 + i * 0.45 : -(5.2 + i * 0.45);
      movingCars.push({
        group,
        speed: cruiseSpeed,
        cruiseSpeed,
        axis: "z",
        initialPosition: group.position.clone(),
      });
    }
    for (let i = 0; i < 4; i++) {
      const group = createCar(initialCarColors[(i + 4) % initialCarColors.length]);
      group.scale.setScalar(0.82);
      const lane = i % 2 === 0 ? -1.9 : 1.9;
      const speed = lane < 0 ? 5.6 + i * 0.4 : -(5.6 + i * 0.4);
      group.position.set(-48 + i * 30, 0.08, lane);
      group.rotation.y = speed > 0 ? Math.PI / 2 : -Math.PI / 2;
      world.add(group);
      movingCars.push({
        group,
        speed,
        cruiseSpeed: speed,
        axis: "x",
        initialPosition: group.position.clone(),
      });
    }

    const repaintCar = (group: THREE.Group, color: number) => {
      const materials = group.userData.paintMaterials as
        | THREE.MeshStandardMaterial[]
        | undefined;
      materials?.forEach((material) => material.color.setHex(color));
    };

    const applyCity = (nextCityId: CityId) => {
      const nextCity = CITY_THEME_BY_ID[nextCityId];
      const palette = nextCity.palette;
      if (scene.background instanceof THREE.Color) scene.background.setHex(palette.sky);
      if (scene.fog instanceof THREE.Fog) scene.fog.color.setHex(palette.fog);
      hemi.color.setHex(palette.hemisphereSky);
      hemi.groundColor.setHex(palette.hemisphereGround);
      sun.color.setHex(palette.sunlight);
      ground.material.color.setHex(palette.ground);
      roadMaterial.color.setHex(palette.road);
      sidewalkMaterial.color.setHex(palette.sidewalk);
      stripeMaterial.color.setHex(palette.stripe);
      plaza.material.color.setHex(palette.plaza);
      fountainStone.color.setHex(palette.fountainStone);
      fountainWater.color.setHex(palette.fountainWater);
      fountainWater.emissive.setHex(palette.fountainGlow);
      moteMaterial.color.setHex(palette.mote);
      cloudMaterials.forEach((material) => material.color.setHex(palette.cloud));
      windowMaterials.forEach((material) => {
        material.color.setHex(palette.window);
        material.emissive.setHex(palette.windowGlow);
      });
      buildingThemeTargets.forEach((target) => {
        target.body.color.setHex(
          palette.buildings[target.index % palette.buildings.length],
        );
        target.accents.forEach((material) => {
          material.color.setHex(palette.accents[target.index % palette.accents.length]);
        });
      });
      treeTrunkMaterials.forEach((material) => material.color.setHex(palette.treeTrunk));
      treeMaterials.forEach((material, index) => {
        material.color.setHex(palette.trees[index % palette.trees.length]);
      });
      lampPoleMaterials.forEach((material) => material.color.setHex(palette.lampPole));
      lampBulbMaterials.forEach((material) => {
        material.color.setHex(palette.lampBulb);
        material.emissive.setHex(palette.lampGlow);
      });
      movingCars.forEach((traffic, index) => {
        repaintCar(traffic.group, palette.cars[(index + 2) % palette.cars.length]);
      });
      spots.forEach((spot, index) => {
        if (spot.car) repaintCar(spot.car.group, palette.cars[index % palette.cars.length]);
      });
      if (chunkManifest) {
        setStreamStatus(
          `${loadedChunks.size}/${chunkManifest.chunks.length} ${nextCity.name} blocks ready`,
        );
      }
    };
    applyCityRef.current = applyCity;
    applyCity(cityIdRef.current);

    const applyGraphics = (mode: GraphicsMode) => {
      const profile = resolveGraphicsProfile(mode);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, profile.pixelRatio));
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      renderer.shadowMap.enabled = profile.shadows;
      sun.castShadow = profile.shadows;
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = profile.fogNear;
        scene.fog.far = profile.fogFar;
      }
      qualityDetails.forEach((detail) => {
        detail.visible = profile.details;
      });
      setGraphicsLabel(profile.label);
    };
    applyGraphicsRef.current = applyGraphics;
    applyGraphics(graphicsModeRef.current);

    const initializeWorld = async () => {
      const loadStarted = performance.now();
      setLoadProgress(6);
      let manifest: WorldManifest;
      try {
        const response = await fetch(assetPath("/world/downtown/manifest.json"));
        if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
        manifest = (await response.json()) as WorldManifest;
      } catch {
        manifest = {
          district: "Downtown",
          chunks: [-48, -24, 0, 24, 48].map((centerZ, index) => ({
            id: `block-${index + 1}`,
            name: `Downtown block ${index + 1}`,
            centerZ,
            file: `/world/downtown/block-${index + 1}.json`,
            initial: Math.abs(centerZ) <= 24,
          })),
        };
      }
      if (disposed) return;
      chunkManifest = manifest;
      setLoadProgress(18);
      setStreamStatus(`Loading ${CITY_THEME_BY_ID[cityIdRef.current].name}`);
      const initialChunks = manifest.chunks.filter((chunk) => chunk.initial);
      let completed = 0;
      await Promise.all(
        initialChunks.map(async (definition) => {
          await loadChunk(definition);
          completed += 1;
          if (!disposed) {
            setLoadProgress(18 + Math.round((completed / Math.max(initialChunks.length, 1)) * 76));
          }
        }),
      );
      const minimumWait = Math.max(0, 900 - (performance.now() - loadStarted));
      await new Promise((resolve) => window.setTimeout(resolve, minimumWait));
      if (disposed) return;
      setLoadProgress(100);
      setStreamStatus(
        `${loadedChunks.size}/${manifest.chunks.length} ${
          CITY_THEME_BY_ID[cityIdRef.current].name
        } blocks ready`,
      );
      window.setTimeout(() => {
        if (!disposed) setScreen("home");
      }, 180);
    };
    void initializeWorld();

    let elapsed = 0;
    let lastTime = performance.now();
    let gameTime = 0;
    let score = 0;
    let tickets = 0;
    let boots = 0;
    let combo = 0;
    let lastTicketTime = -20;
    let actionKind: ActionKind | null = null;
    let actionTime = 0;
    let runningSpeed = 0;
    let keyboardScheme: KeyboardScheme = "arrows";
    let nearest: CarData | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let lastContextKey = "";
    let lastStatsPush = 0;
    let fpsWindow = 60;
    let fpsFrames = 0;
    let fpsTime = 0;
    let lastStreamCheck = 0;
    let simulationAccumulator = 0;
    let gamepadWasConnected = false;
    let previousGamepadActions = { ticket: false, lookup: false, boot: false };
    let objectiveMetrics: ObjectiveMetrics = {
      tickets: 0,
      boots: 0,
      maxCombo: 0,
      firstTicketAtSeconds: null,
      distanceMeters: 0,
    };
    let objectiveEvaluation = evaluateObjective(dailyChallenge.objective, objectiveMetrics);
    let objectiveAwarded = false;
    let lastObjectiveKey = "";
    let incidentApplied = false;
    let incidentAnnounced = false;
    let runRanked = false;
    let rankedReason = "Finish the full shift to enter the daily board.";
    let finishInProgress = false;
    let activeGhost: GhostRun | null = null;
    let recordedGhostSamples: GhostRun["samples"] = [];
    let nextGhostSampleAt = 0;

    const isWalkable = (x: number, z: number) =>
      (Math.abs(x) <= 11.2 && Math.abs(z) <= 54) ||
      (Math.abs(z) <= 11.2 && Math.abs(x) <= 49) ||
      (Math.abs(z - 32) <= 10 && Math.abs(x) <= 38) ||
      (x >= 14 && x <= 44 && z >= 36 && z <= 54);

    const vehicleDistances = (
      position: THREE.Vector3,
      axis: TrafficAxis,
      direction: number,
    ) => {
      const along = axis === "z" ? position.z : position.x;
      const across = axis === "z" ? position.x : position.z;
      const officerAlong = axis === "z" ? officer.root.position.z : officer.root.position.x;
      const officerAcross = axis === "z" ? officer.root.position.x : officer.root.position.z;
      return {
        lateral: Math.abs(officerAcross - across),
        ahead: (officerAlong - along) * direction,
        officerAlong,
      };
    };

    const shouldBrakeForOfficer = (
      position: THREE.Vector3,
      axis: TrafficAxis,
      direction: number,
    ) => {
      const { lateral, ahead } = vehicleDistances(position, axis, direction);
      return lateral < 1.9 && ahead > -2.8 && ahead < 10;
    };

    const officerBlocksVehiclePath = (
      position: THREE.Vector3,
      nextCoordinate: number,
      axis: TrafficAxis,
      direction: number,
    ) => {
      const { lateral, ahead, officerAlong } = vehicleDistances(position, axis, direction);
      const nextAhead = (officerAlong - nextCoordinate) * direction;
      return lateral < 1.65 && ahead > -2.8 && ahead < 12 && nextAhead < 2.8;
    };

    const officerClearsVehicle = (
      x: number,
      z: number,
      position: { x: number; z: number },
      axis: TrafficAxis,
      scale = 1,
    ) => !circleIntersectsCollider(
      x,
      z,
      OFFICER_COLLISION_RADIUS,
      createVehicleCollider("candidate-vehicle", axis, position.x, position.z, scale),
    );

    const canOfficerStandAt = (x: number, z: number) => {
      if (!circleFitsWalkableArea(x, z, OFFICER_COLLISION_RADIUS, isWalkable)) {
        return false;
      }
      const vehicleColliders = movingCars.map((traffic) =>
        createVehicleCollider(
          `traffic:${traffic.group.uuid}`,
          traffic.axis,
          traffic.group.position.x,
          traffic.group.position.z,
          traffic.group.scale.x,
        ),
      );
      for (const spot of spots) {
        if (!spot.car) continue;
        vehicleColliders.push(
          createVehicleCollider(
            `parking:${spot.car.group.uuid}`,
            spot.axis,
            spot.car.group.position.x,
            spot.car.group.position.z,
            spot.car.group.scale.x,
          ),
        );
      }
      return !worldCollision.blocksCircle(
        x,
        z,
        OFFICER_COLLISION_RADIUS,
        vehicleColliders,
      );
    };

    const vehiclePosition = (
      group: THREE.Group,
      axis: TrafficAxis,
      x = group.position.x,
      z = group.position.z,
    ): TrafficVehiclePosition => ({
      axis,
      x,
      z,
      scale: group.scale.x,
    });

    const trafficPosition = (
      traffic: MovingCar,
      nextCoordinate?: number,
    ) => vehiclePosition(
      traffic.group,
      traffic.axis,
      traffic.axis === "x" && nextCoordinate !== undefined
        ? nextCoordinate
        : traffic.group.position.x,
      traffic.axis === "z" && nextCoordinate !== undefined
        ? nextCoordinate
        : traffic.group.position.z,
    );

    const allVehiclePositions = (excludedGroup?: THREE.Group) => {
      const positions: TrafficVehiclePosition[] = [];
      for (const traffic of movingCars) {
        if (traffic.group === excludedGroup) continue;
        positions.push(trafficPosition(traffic));
      }
      for (const spot of spots) {
        const car = spot.car;
        if (!car || car.group === excludedGroup) continue;
        positions.push(vehiclePosition(car.group, spot.axis));
      }
      return positions;
    };

    const shouldBrakeForTraffic = (
      group: THREE.Group,
      position: TrafficVehiclePosition,
      direction: number,
    ) => {
      return nearestTrafficGap(position, direction, allVehiclePositions(group))
        < TRAFFIC_BRAKE_DISTANCE;
    };

    const trafficPositionIsClear = (
      nextPosition: TrafficVehiclePosition,
      excludedGroup?: THREE.Group,
    ) => {
      return allVehiclePositions(excludedGroup).every(
        (other) => !trafficVehiclesOverlap(nextPosition, other),
      );
    };

    const trafficClearsVehicle = (
      group: THREE.Group,
      nextPosition: TrafficVehiclePosition,
    ) => trafficPositionIsClear(nextPosition, group);

    const feedback = new GameFeedback();
    const playCue = (
      cue: Parameters<GameFeedback["play"]>[0],
      position?: THREE.Vector3,
    ) => {
      feedback.setEnabled(audioOnRef.current);
      feedback.play(
        cue,
        position ? { x: position.x, y: position.y, z: position.z } : undefined,
      );
    };

    const removeCar = (spot: ParkingSpot) => {
      if (!spot.car) return;
      const removedGroup = spot.car.group;
      world.remove(removedGroup);
      disposeObject(removedGroup);
      spot.car = null;
      spot.respawnAt = gameTime + 3 + gameplayRandom() * 4;
    };

    const spawnCar = (spot: ParkingSpot, initial = false) => {
      const carColors = CITY_THEME_BY_ID[cityIdRef.current].palette.cars;
      const color = carColors[Math.floor(gameplayRandom() * carColors.length)];
      const group = createCar(color);
      const routeStart = parkingRoutePosition(spot, "arriving", 0);
      group.position.set(
        initial ? spot.x : routeStart.x,
        0.08,
        initial ? spot.z : routeStart.z,
      );
      const direction = parkingTravelDirection(spot.side);
      group.rotation.y = spot.axis === "x"
        ? direction > 0 ? Math.PI / 2 : -Math.PI / 2
        : direction > 0 ? 0 : Math.PI;
      world.add(group);
      const priorsPool = [0, 0, 1, 2, 3, 4, 5];
      const overdue = initial && gameplayRandom() < 0.46;
      spot.car = {
        plate: makePlate(gameplayRandom),
        priors: priorsPool[Math.floor(gameplayRandom() * priorsPool.length)],
        color,
        expireAt: gameTime + (overdue ? -(2 + gameplayRandom() * 8) : 6 + gameplayRandom() * 20),
        departAt: gameTime + 24 + gameplayRandom() * 22,
        ticketed: false,
        booted: false,
        lookedUp: false,
        priority: false,
        phase: initial ? "parked" : "arriving",
        phaseTime: 0,
        driveRate: initial ? 0 : 1,
        group,
      };
    };

    spots.forEach((spot, index) => {
      if (index < 12) {
        spawnCar(spot, true);
        if (index === 1 && spot.car) {
          spot.car.expireAt = gameTime - 4;
          spot.car.priors = 4;
        }
      }
      else spot.respawnAt = 4 + (index % 4) * 2;
    });

    const orderedIncidentTargets = (minimum: number) => {
      const candidates = spots.filter(
        (spot) =>
          spot.car &&
          spot.car.phase === "parked" &&
          !spot.car.ticketed &&
          !spot.car.booted,
      );
      if (candidates.length < minimum) return [];
      const startIndex = Math.floor(incidentRandom() * candidates.length);
      return candidates.slice(startIndex).concat(candidates.slice(0, startIndex));
    };

    const applyDailyIncident = () => {
      const incident = dailyChallenge.incident;
      switch (incident.kind) {
        case "meter-surge": {
          const targets = orderedIncidentTargets(3).filter(
            (spot) => (spot.car?.expireAt ?? 0) > gameTime,
          );
          if (targets.length < 3) return false;
          targets.slice(0, 3).forEach((spot) => {
            if (spot.car) spot.car.expireAt = gameTime - 1;
          });
          return true;
        }
        case "repeat-alert": {
          const target = orderedIncidentTargets(1)[0]?.car;
          if (!target) return false;
          target.priors = Math.max(3, target.priors);
          target.expireAt = gameTime - 1;
          target.departAt = Math.max(
            target.departAt,
            gameTime + incident.durationSeconds,
          );
          return true;
        }
        case "rush-hour":
          return true;
        case "street-sweep": {
          const targets = orderedIncidentTargets(1);
          if (targets.length === 0) return false;
          targets.forEach((spot) => {
            if (!spot.car) return;
            spot.car.departAt = Math.min(
              spot.car.departAt,
              gameTime + incident.durationSeconds,
            );
          });
          return true;
        }
        case "priority-expiry": {
          const target = orderedIncidentTargets(1)[0]?.car;
          if (!target) return false;
          target.priority = true;
          target.expireAt = gameTime - 1;
          target.departAt = Math.min(
            target.departAt,
            gameTime + incident.durationSeconds,
          );
          return true;
        }
      }
    };

    const reserveIncidentTargets = () => {
      const incident = dailyChallenge.incident;
      let count = 0;
      if (incident.kind === "meter-surge") count = 3;
      if (incident.kind === "repeat-alert" || incident.kind === "priority-expiry") {
        count = 1;
      }
      if (count === 0) return;
      spots
        .filter((spot) => spot.car)
        .slice(-count)
        .forEach((spot) => {
          if (!spot.car) return;
          spot.car.expireAt = incident.startsAtSeconds + 10;
          spot.car.departAt = Math.max(
            spot.car.departAt,
            incident.startsAtSeconds + incident.durationSeconds + 5,
          );
        });
    };

    const pushStats = () => {
      const timeLeft = Math.max(0, SHIFT_DURATION_SECONDS - gameTime);
      setStats({ score, tickets, boots, combo, timeLeft, fps: Math.round(fpsWindow) });
    };

    const pushObjective = (awardBonus = true) => {
      const nextEvaluation = evaluateObjective(dailyChallenge.objective, objectiveMetrics);
      const nextKey = `${nextEvaluation.complete}:${Math.floor(nextEvaluation.current * 10)}`;
      const completedNow = awardBonus && nextEvaluation.complete && !objectiveAwarded;
      objectiveEvaluation = nextEvaluation;
      if (nextKey !== lastObjectiveKey) {
        lastObjectiveKey = nextKey;
        setObjectiveStatus(nextEvaluation);
      }
      if (completedNow) {
        objectiveAwarded = true;
        score += dailyChallenge.bonus;
        showToast(`Dispatch objective complete +${dailyChallenge.bonus}`, 4_500);
        playCue("objective");
        pushStats();
      }
    };

    const pushContext = () => {
      const next: CarContext =
        nearest && nearest.phase === "parked"
          ? {
              plate: nearest.plate,
              seconds: nearest.expireAt - gameTime,
              expired: nearest.expireAt <= gameTime,
              priors: nearest.priors,
              lookedUp: nearest.lookedUp,
              ticketed: nearest.ticketed,
              booted: nearest.booted,
              priority: nearest.priority,
            }
          : null;
      const key = JSON.stringify(next);
      if (key !== lastContextKey) {
        lastContextKey = key;
        setContext(next);
      }
    };

    const finishGame = (completedShift: boolean) => {
      if (!gameActiveRef.current || finishInProgress) return;
      finishInProgress = true;
      gameActiveRef.current = false;
      const completedFullShift =
        completedShift && gameTime >= SHIFT_DURATION_SECONDS - FIXED_STEP_SECONDS * 1.5;
      if (!completedFullShift) {
        runRanked = false;
        rankedReason = "Practice result. Finish the full 90-second shift to rank.";
      }
      const bestKey = `meter-mayhem-best:${dailyChallenge.id}`;
      const previousBest = Number(window.localStorage.getItem(bestKey) ?? 0);
      const best = runRanked ? Math.max(previousBest, score) : previousBest;
      if (runRanked) window.localStorage.setItem(bestKey, String(best));
      const session = shiftSessionRef.current;
      const resultRunId = session?.runId ?? crypto.randomUUID();
      const nextResult: GameResult = {
        runId: resultRunId,
        issuedAt: session?.issuedAt ?? 0,
        token: session?.token ?? "",
        score,
        tickets,
        boots,
        best,
        challengeId: session?.challengeId ?? dailyChallenge.id,
        rulesetVersion: session?.rulesetVersion ?? DAILY_RULESET_VERSION,
        objectiveId: dailyChallenge.objective.id,
        objectiveCompleted: objectiveEvaluation.complete,
        objectiveBonus: objectiveEvaluation.complete ? dailyChallenge.bonus : 0,
        ranked: runRanked,
        rankedReason,
        ghostSaved: false,
      };
      setResult(nextResult);
      if (!runRanked) {
        setScoreStatus({ kind: "idle", message: rankedReason });
      } else if (!session) {
        setScoreStatus({
          kind: "error",
          message: "Dispatch was offline. Your daily best and ghost are still saved locally.",
        });
      }
      setScreen("gameover");
      playCue("finish");
      ghostOfficer.visible = false;

      if (
        runRanked &&
        recordedGhostSamples.length >= 2 &&
        (!activeGhost || score > activeGhost.score)
      ) {
        const ghostRun: GhostRun = {
          version: GHOST_RUN_VERSION,
          challengeId: dailyChallenge.id,
          rulesetVersion: DAILY_RULESET_VERSION,
          score,
          samples: recordedGhostSamples,
        };
        void savePersonalBestGhost(ghostRun).then((saved) => {
          if (!saved) return;
          ghostRunRef.current = ghostRun;
          setGhostAvailable(true);
          setResult((current) =>
            current.runId === resultRunId ? { ...current, ghostSaved: true } : current,
          );
        });
      }
    };

    const startGame = () => {
      spots.forEach((spot) => removeCar(spot));
      gameplayRandom = createSeededRandom(dailyChallenge.seed);
      incidentRandom = createSeededRandom(dailyChallenge.seed ^ 0xc8013ea4);
      gameTime = 0;
      score = 0;
      tickets = 0;
      boots = 0;
      combo = 0;
      lastTicketTime = -20;
      objectiveMetrics = {
        tickets: 0,
        boots: 0,
        maxCombo: 0,
        firstTicketAtSeconds: null,
        distanceMeters: 0,
      };
      objectiveEvaluation = evaluateObjective(dailyChallenge.objective, objectiveMetrics);
      objectiveAwarded = false;
      lastObjectiveKey = "";
      incidentApplied = false;
      incidentAnnounced = false;
      runRanked = !document.hidden;
      rankedReason = runRanked
        ? "Ranked daily shift"
        : "Practice result. The shift started while this tab was hidden.";
      finishInProgress = false;
      activeGhost = ghostRunRef.current?.challengeId === dailyChallenge.id
        ? ghostRunRef.current
        : null;
      recordedGhostSamples = [
        { timeSeconds: 0, x: -8.5, z: -9, rotation: 0 },
      ];
      nextGhostSampleAt = 0.1;
      keyboardScheme = "arrows";
      keysRef.current.clear();
      runningSpeed = 0;
      simulationAccumulator = 0;
      officer.root.position.set(-8.5, 0.15, -9);
      officer.root.rotation.y = 0;
      ghostOfficer.visible = Boolean(activeGhost);
      if (activeGhost) {
        const firstSample = sampleGhostAt(activeGhost, 0);
        if (firstSample) {
          ghostOfficer.position.set(firstSample.x, 0.15, firstSample.z);
          ghostOfficer.rotation.y = firstSample.rotation;
        }
      }
      movingCars.forEach((traffic) => {
        traffic.group.position.copy(traffic.initialPosition);
        traffic.speed = traffic.cruiseSpeed;
      });
      spots.forEach((spot, index) => {
        if (index < 12) {
          spawnCar(spot, true);
          if (index === 1 && spot.car) {
            spot.car.expireAt = gameTime - 4;
            spot.car.priors = 4;
          }
        }
        else spot.respawnAt = 4 + (index % 4) * 2;
      });
      reserveIncidentTargets();
      pushStats();
      pushObjective(false);
      setContext(null);
      clearToast();
      setObjectiveOpen(false);
      setBriefingOpen(false);
      startAttemptRef.current = false;
      setLastSavedScore(null);
      setBoardScope("daily");
      setScoreStatus({
        kind: "idle",
        message: "Finish the full shift to enter today’s board.",
      });
      gameActiveRef.current = true;
      setScreen("playing");
      playCue("start");
    };

    const addTicketVisual = (car: CarData) => {
      if (car.ticketMesh) return;
      const ticket = new THREE.Mesh(
        new THREE.BoxGeometry(0.42, 0.03, 0.62),
        new THREE.MeshStandardMaterial({ color: 0xfff7c7 }),
      );
      ticket.position.set(0.55, 1.56, 0.45);
      ticket.rotation.z = 0.15;
      car.group.add(ticket);
      car.ticketMesh = ticket;
    };

    const addBootVisual = (car: CarData, spot: ParkingSpot) => {
      if (car.bootMesh) return;
      const boot = new THREE.Mesh(
        new THREE.TorusGeometry(0.38, 0.12, 8, 16, Math.PI * 1.55),
        new THREE.MeshStandardMaterial({ color: 0xffd45b, roughness: 0.6 }),
      );
      boot.rotation.y = Math.PI / 2;
      boot.rotation.z = Math.PI / 2;
      boot.position.set(-spot.side * 1.15, 0.42, 1.35);
      car.group.add(boot);
      car.bootMesh = boot;
    };

    const doAction = (kind: ActionKind) => {
      if (!gameActiveRef.current || !nearest || nearestDistance > 3.75 || nearest.phase !== "parked") {
        showToast("Move closer to a parked car");
        playCue("error");
        return;
      }
      const car = nearest;
      const spot = spots.find((candidate) => candidate.car === car);
      if (!spot) return;

      actionKind = kind;
      actionTime = 0;
      if (kind === "lookup") {
        car.lookedUp = true;
        showToast(car.priors >= 3 ? `${car.plate}: repeat offender — boot eligible` : `${car.plate}: ${car.priors} prior violations`);
        playCue("lookup", car.group.position);
        pushContext();
        return;
      }

      if (kind === "ticket") {
        if (car.ticketed) {
          showToast("Already ticketed this parking stay");
          playCue("error", car.group.position);
        } else if (car.expireAt > gameTime) {
          score = Math.max(0, score - 75);
          combo = 0;
          showToast("Too early! −75");
          playCue("error", car.group.position);
        } else {
          combo = gameTime - lastTicketTime <= 12 ? combo + 1 : 1;
          const points = 100 + Math.max(0, combo - 1) * 20;
          score += points;
          tickets += 1;
          lastTicketTime = gameTime;
          objectiveMetrics.tickets = tickets;
          objectiveMetrics.maxCombo = Math.max(objectiveMetrics.maxCombo, combo);
          if (objectiveMetrics.firstTicketAtSeconds === null) {
            objectiveMetrics.firstTicketAtSeconds = gameTime;
          }
          car.ticketed = true;
          addTicketVisual(car);
          showToast(combo > 1 ? `Valid ticket +${points} · ${combo}× combo!` : `Valid ticket +${points}`);
          playCue("ticket", car.group.position);
          pushObjective();
        }
      }

      if (kind === "boot") {
        if (!car.lookedUp) {
          showToast("Look up the plate first");
          playCue("error", car.group.position);
        } else if (!car.ticketed) {
          showToast("Write the expired-meter ticket first");
          playCue("error", car.group.position);
        } else if (car.priors < 3) {
          score = Math.max(0, score - 150);
          combo = 0;
          showToast("Not a repeat offender! −150");
          playCue("error", car.group.position);
        } else if (car.booted) {
          showToast("This vehicle is already immobilized");
        } else {
          car.booted = true;
          boots += 1;
          score += 250;
          objectiveMetrics.boots = boots;
          addBootVisual(car, spot);
          showToast("Boot secured +250");
          playCue("boot", car.group.position);
          pushObjective();
        }
      }
      pushStats();
      pushContext();
    };

    actionsRef.current = doAction;
    startRef.current = startGame;
    endRef.current = () => finishGame(false);

    const onKeyDown = (event: KeyboardEvent) => {
      if (!gameActiveRef.current) return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.repeat) return;
      if (event.code.startsWith("Arrow")) {
        keyboardScheme = "arrows";
        keysRef.current.delete("KeyW");
      }
      if (["KeyA", "KeyS", "KeyD"].includes(event.code)) keyboardScheme = "wasd";

      if (event.code === "KeyQ") doAction("ticket");
      if (event.code === "KeyW" && keyboardScheme === "arrows") {
        doAction("lookup");
        keysRef.current.delete("KeyW");
        return;
      }
      if (event.code === "KeyE") doAction("boot");
      if (event.code === "KeyF") doAction("lookup");
      if (event.code === "KeyB") doAction("boot");

      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "KeyW",
          "KeyA",
          "KeyS",
          "KeyD",
          "ShiftLeft",
          "ShiftRight",
        ].includes(event.code)
      ) {
        keysRef.current.add(event.code);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.code);
    const clearHeldInput = () => keysRef.current.clear();
    const markInterrupted = () => {
      clearHeldInput();
      simulationAccumulator = 0;
      lastTime = performance.now();
      if (!gameActiveRef.current) return;
      runRanked = false;
      rankedReason = "Practice result. Leaving this tab made the shift ineligible for ranking.";
      showToast("Shift paused · this run is now practice", 4_500);
    };
    const onVisibilityChange = () => {
      if (document.hidden) markInterrupted();
      else {
        simulationAccumulator = 0;
        lastTime = performance.now();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearHeldInput);
    window.addEventListener("pagehide", markInterrupted);
    document.addEventListener("visibilitychange", onVisibilityChange);

    let resizeFrame = 0;
    const resize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        renderer.setSize(width, height, false);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const updateCameraOcclusion = () => {
      const activeOccluders = new Set<THREE.Group>();
      cameraFocus.set(cameraTarget.x, 1.35, cameraTarget.z - 0.6);
      cameraRay.subVectors(camera.position, cameraFocus);
      const cameraDistance = cameraRay.length();
      if (cameraDistance > 1) {
        world.updateMatrixWorld(true);
        cameraRaycaster.set(cameraFocus, cameraRay.normalize());
        cameraRaycaster.far = cameraDistance - 0.75;
        const intersections = cameraRaycaster.intersectObjects(cameraOccluders, true);
        for (const intersection of intersections) {
          let object: THREE.Object3D | null = intersection.object;
          while (object && object !== world) {
            if (object.userData.cameraOccluder) {
              activeOccluders.add(object as THREE.Group);
              break;
            }
            object = object.parent;
          }
        }
      }

      for (const group of cameraOccluders) {
        group.visible = !activeOccluders.has(group);
      }
    };

    const render = () => {
      if (disposed) return;
      requestAnimationFrame(render);
      const now = performance.now();
      const rawDt = Math.min((now - lastTime) / 1000, 0.25);
      lastTime = now;
      const frameDt = Math.max(rawDt, 1 / 240);
      fpsFrames += 1;
      fpsTime += frameDt;
      if (fpsTime >= 0.5) {
        fpsWindow = damp(fpsWindow, fpsFrames / fpsTime, 5, fpsTime);
        fpsFrames = 0;
        fpsTime = 0;
      }

      const gamepad = firstConnectedGamepad();
      const gamepadConnected = Boolean(gamepad);
      if (gamepadConnected !== gamepadWasConnected) {
        gamepadWasConnected = gamepadConnected;
        setControllerConnected(gamepadConnected);
      }
      const analogX = Math.abs(gamepad?.axes[0] ?? 0) >= 0.18
        ? gamepad?.axes[0] ?? 0
        : 0;
      const analogZ = Math.abs(gamepad?.axes[1] ?? 0) >= 0.18
        ? gamepad?.axes[1] ?? 0
        : 0;
      const gamepadAxisX = THREE.MathUtils.clamp(
        analogX + (gamepad?.buttons[15]?.pressed ? 1 : 0) -
          (gamepad?.buttons[14]?.pressed ? 1 : 0),
        -1,
        1,
      );
      const gamepadAxisZ = THREE.MathUtils.clamp(
        analogZ + (gamepad?.buttons[13]?.pressed ? 1 : 0) -
          (gamepad?.buttons[12]?.pressed ? 1 : 0),
        -1,
        1,
      );
      const gamepadActions = {
        ticket: Boolean(gamepad?.buttons[0]?.pressed),
        lookup: Boolean(gamepad?.buttons[2]?.pressed),
        boot: Boolean(gamepad?.buttons[1]?.pressed),
      };

      simulationAccumulator = Math.min(
        simulationAccumulator + rawDt,
        0.25,
      );
      while (simulationAccumulator >= FIXED_STEP_SECONDS) {
        const dt = FIXED_STEP_SECONDS;
        elapsed += dt;

        if (gameActiveRef.current) {
          gameTime = Math.min(SHIFT_DURATION_SECONDS, gameTime + dt);
          if (gameTime >= SHIFT_DURATION_SECONDS) {
            pushStats();
            finishGame(true);
            simulationAccumulator = 0;
            break;
          }
          if (
            !incidentApplied &&
            gameTime >= dailyChallenge.incident.startsAtSeconds &&
            applyDailyIncident()
          ) {
            incidentApplied = true;
            if (!incidentAnnounced) {
              incidentAnnounced = true;
              showToast(dailyChallenge.incident.message, 5_000);
              playCue("incident");
            }
          }
        }

        const rushHourActive =
          gameActiveRef.current &&
          dailyChallenge.incident.kind === "rush-hour" &&
          gameTime >= dailyChallenge.incident.startsAtSeconds &&
          gameTime <
            dailyChallenge.incident.startsAtSeconds + dailyChallenge.incident.durationSeconds;
        const trafficSpeedMultiplier = rushHourActive ? 1.3 : 1;

      for (const traffic of movingCars) {
        const coordinate = traffic.axis === "z" ? "z" : "x";
        const direction = Math.sign(traffic.cruiseSpeed) || 1;
        const brakingForOfficer = shouldBrakeForOfficer(
          traffic.group.position,
          traffic.axis,
          direction,
        );
        const brakingForTraffic = shouldBrakeForTraffic(
          traffic.group,
          trafficPosition(traffic),
          direction,
        );
        const braking = brakingForOfficer || brakingForTraffic;
        traffic.speed = damp(
          traffic.speed,
          braking ? 0 : traffic.cruiseSpeed * trafficSpeedMultiplier,
          braking ? 7.5 : 2.4,
          dt,
        );
        const currentCoordinate = traffic.group.position[coordinate];
        let nextCoordinate = currentCoordinate + traffic.speed * dt;
        const wrappedCoordinate =
          nextCoordinate > TRAFFIC_LOOP_MAX
            ? TRAFFIC_LOOP_MIN
            : nextCoordinate < TRAFFIC_LOOP_MIN
              ? TRAFFIC_LOOP_MAX
              : nextCoordinate;
        const isWrapping = wrappedCoordinate !== nextCoordinate;
        nextCoordinate = wrappedCoordinate;

        const blockedOnPath = officerBlocksVehiclePath(
          traffic.group.position,
          nextCoordinate,
          traffic.axis,
          direction,
        );
        const blockedAtWrap =
          isWrapping &&
          shouldBrakeForOfficer(
            new THREE.Vector3(
              traffic.axis === "x" ? nextCoordinate : traffic.group.position.x,
              traffic.group.position.y,
              traffic.axis === "z" ? nextCoordinate : traffic.group.position.z,
            ),
            traffic.axis,
            direction,
          );
        const blockedByTraffic = !trafficClearsVehicle(
          traffic.group,
          trafficPosition(traffic, nextCoordinate),
        );
        if (blockedOnPath || blockedAtWrap || blockedByTraffic) {
          traffic.speed = 0;
        } else {
          traffic.group.position[coordinate] = nextCoordinate;
        }
      }
      clouds.forEach((cloud, index) => {
        cloud.position.x += (0.12 + index * 0.014) * dt;
        if (cloud.position.x > 34) cloud.position.x = -34;
      });
      animatedTrees.forEach((tree) => {
        tree.rotation.z = Math.sin(elapsed * 1.25 + tree.userData.windPhase) * 0.018;
      });
      motes.rotation.y = elapsed * 0.012;

      if (chunkManifest && now - lastStreamCheck > 400) {
        lastStreamCheck = now;
        for (const definition of chunkManifest.chunks) {
          if (Math.abs(definition.centerZ - officer.root.position.z) <= 34) {
            void loadChunk(definition);
          }
        }
      }

      if (gameActiveRef.current) {
        if (gamepadActions.ticket && !previousGamepadActions.ticket) doAction("ticket");
        if (gamepadActions.lookup && !previousGamepadActions.lookup) doAction("lookup");
        if (gamepadActions.boot && !previousGamepadActions.boot) doAction("boot");
        previousGamepadActions = gamepadActions;

        const keys = keysRef.current;
        const keyboardX =
          (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
          (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
        const keyboardZ =
          (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) -
          (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
        const inputX = THREE.MathUtils.clamp(keyboardX + gamepadAxisX, -1, 1);
        const inputZ = THREE.MathUtils.clamp(keyboardZ + gamepadAxisZ, -1, 1);
        const length = Math.hypot(inputX, inputZ);
        const sprinting =
          keys.has("ShiftLeft") ||
          keys.has("ShiftRight") ||
          Boolean(gamepad?.buttons[4]?.pressed) ||
          Boolean(gamepad?.buttons[5]?.pressed) ||
          Boolean(gamepad?.buttons[10]?.pressed);
        const targetSpeed = length > 0 ? (sprinting ? 8.2 : 5.7) : 0;
        runningSpeed = damp(runningSpeed, targetSpeed, length > 0 ? 9 : 12, dt);
        if (length > 0) {
          const previousX = officer.root.position.x;
          const previousZ = officer.root.position.z;
          const moveX = inputX / length;
          const moveZ = inputZ / length;
          const nextX = officer.root.position.x + moveX * runningSpeed * dt;
          const nextZ = officer.root.position.z + moveZ * runningSpeed * dt;
          if (canOfficerStandAt(nextX, nextZ)) {
            officer.root.position.x = nextX;
            officer.root.position.z = nextZ;
          } else if (canOfficerStandAt(nextX, officer.root.position.z)) {
            officer.root.position.x = nextX;
          } else if (canOfficerStandAt(officer.root.position.x, nextZ)) {
            officer.root.position.z = nextZ;
          }
          const targetAngle = Math.atan2(moveX, moveZ);
          officer.root.rotation.y = dampAngle(officer.root.rotation.y, targetAngle, 13, dt);
          const acceptedDistance = Math.hypot(
            officer.root.position.x - previousX,
            officer.root.position.z - previousZ,
          );
          if (acceptedDistance > 0) {
            objectiveMetrics.distanceMeters += acceptedDistance;
            pushObjective();
          }
        }

        if (activeGhost) {
          const ghostSample = sampleGhostAt(activeGhost, gameTime);
          if (ghostSample) {
            ghostOfficer.visible = true;
            ghostOfficer.position.set(ghostSample.x, 0.15, ghostSample.z);
            ghostOfficer.rotation.y = ghostSample.rotation;
          }
        }
        if (gameTime + FIXED_STEP_SECONDS / 2 >= nextGhostSampleAt) {
          recordedGhostSamples.push({
            timeSeconds: Number(gameTime.toFixed(3)),
            x: officer.root.position.x,
            z: officer.root.position.z,
            rotation: officer.root.rotation.y,
          });
          nextGhostSampleAt += 0.1;
        }

        spots.forEach((spot) => {
          const car = spot.car;
          if (!car) {
            const spawnPosition = parkingRoutePosition(spot, "arriving", 0);
            if (
              gameTime >= spot.respawnAt &&
              Math.hypot(
                officer.root.position.x - spawnPosition.x,
                officer.root.position.z - spawnPosition.z,
              ) > 3.5 &&
              trafficPositionIsClear({ ...spawnPosition, scale: 1 })
            ) {
              spawnCar(spot);
            }
            return;
          }
          if (car.phase === "arriving") {
            const direction = parkingTravelDirection(spot.side);
            const routeStart = parkingRoutePosition(spot, "arriving", 0);
            const routeEnd = parkingRoutePosition(spot, "arriving", 1);
            const startAlong = spot.axis === "z" ? routeStart.z : routeStart.x;
            const endAlong = spot.axis === "z" ? routeEnd.z : routeEnd.x;
            const duration = Math.max(2.2, Math.abs(endAlong - startAlong) / 7);
            const currentPosition = vehiclePosition(car.group, spot.axis);
            const brakingForOfficer = shouldBrakeForOfficer(
              car.group.position,
              spot.axis,
              direction,
            );
            const brakingForTraffic = shouldBrakeForTraffic(
              car.group,
              currentPosition,
              direction,
            );
            const braking = brakingForOfficer || brakingForTraffic;
            car.driveRate = damp(car.driveRate, braking ? 0 : 1, braking ? 8 : 2.5, dt);
            const nextPhaseTime = car.phaseTime + dt * car.driveRate;
            const progress = Math.min(1, nextPhaseTime / duration);
            const routePosition = parkingRoutePosition(spot, "arriving", progress);
            const nextPosition = {
              ...routePosition,
              scale: car.group.scale.x,
            };
            let reachedSpot = progress >= 1;
            const blockedByOfficer = !officerClearsVehicle(
              officer.root.position.x,
              officer.root.position.z,
              routePosition,
              spot.axis,
              car.group.scale.x,
            );
            const blockedByTraffic = !trafficClearsVehicle(car.group, nextPosition);
            if (blockedByOfficer || blockedByTraffic) {
              car.driveRate = 0;
              reachedSpot = false;
            } else {
              car.phaseTime = nextPhaseTime;
              car.group.position.x = routePosition.x;
              car.group.position.z = routePosition.z;
            }
            if (reachedSpot) {
              car.phase = "parked";
              car.phaseTime = 0;
              car.driveRate = 0;
              car.expireAt = gameTime + 7 + gameplayRandom() * 18;
              car.departAt = gameTime + 30 + gameplayRandom() * 18;
            }
          } else if (car.phase === "parked") {
            if (gameTime >= car.departAt && !car.booted) {
              car.phase = "leaving";
              car.phaseTime = 0;
              car.driveRate = 0;
            }
          } else {
            const direction = parkingTravelDirection(spot.side);
            const routeStart = parkingRoutePosition(spot, "leaving", 0);
            const routeEnd = parkingRoutePosition(spot, "leaving", 1);
            const startAlong = spot.axis === "z" ? routeStart.z : routeStart.x;
            const endAlong = spot.axis === "z" ? routeEnd.z : routeEnd.x;
            const duration = Math.max(2.4, Math.abs(endAlong - startAlong) / 7);
            const currentPosition = vehiclePosition(car.group, spot.axis);
            const brakingForOfficer = shouldBrakeForOfficer(
              car.group.position,
              spot.axis,
              direction,
            );
            const brakingForTraffic = shouldBrakeForTraffic(
              car.group,
              currentPosition,
              direction,
            );
            const braking = brakingForOfficer || brakingForTraffic;
            car.driveRate = damp(car.driveRate, braking ? 0 : 1, braking ? 8 : 2.5, dt);
            const nextPhaseTime = car.phaseTime + dt * car.driveRate;
            const progress = Math.min(1, nextPhaseTime / duration);
            const routePosition = parkingRoutePosition(spot, "leaving", progress);
            const nextPosition = {
              ...routePosition,
              scale: car.group.scale.x,
            };
            let leftDistrict = progress >= 1;
            const blockedByOfficer = !officerClearsVehicle(
              officer.root.position.x,
              officer.root.position.z,
              routePosition,
              spot.axis,
              car.group.scale.x,
            );
            const blockedByTraffic = !trafficClearsVehicle(car.group, nextPosition);
            if (blockedByOfficer || blockedByTraffic) {
              car.driveRate = 0;
              leftDistrict = false;
            } else {
              car.phaseTime = nextPhaseTime;
              car.group.position.x = routePosition.x;
              car.group.position.z = routePosition.z;
            }
            if (leftDistrict) removeCar(spot);
          }
          const meterMaterial = spot.meterLight.material as THREE.MeshStandardMaterial;
          const expired = car.expireAt <= gameTime;
          meterMaterial.color.setHex(expired ? 0xff5368 : 0x48d6c8);
          meterMaterial.emissive.setHex(expired ? 0x8e1629 : 0x1a6e63);
          const pulseStrength = car.priority ? 0.24 : 0.12;
          spot.meterLight.scale.setScalar(
            expired ? 1 + Math.sin(elapsed * 7) * pulseStrength : 1,
          );
        });

        nearest = null;
        nearestDistance = Number.POSITIVE_INFINITY;
        for (const spot of spots) {
          if (!spot.car || spot.car.phase !== "parked") continue;
          const distance = Math.hypot(
            officer.root.position.x - spot.car.group.position.x,
            officer.root.position.z - spot.car.group.position.z,
          );
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = spot.car;
          }
        }
        if (nearestDistance > 3.75) nearest = null;
        pushContext();

        if (gameTime - lastTicketTime > 12 && combo > 0) combo = 0;
        if (now - lastStatsPush > 150) {
          pushStats();
          lastStatsPush = now;
        }
      } else {
        previousGamepadActions = gamepadActions;
        runningSpeed = damp(runningSpeed, 0, 10, dt);
      }

      const gait = Math.min(1, runningSpeed / 5.5);
      const cycle = elapsed * (7.4 + gait * 2.1);
      let armSwing = Math.sin(cycle) * 0.68 * gait;
      let legSwing = Math.sin(cycle) * 0.82 * gait;
      let crouch = 0;
      if (actionKind) {
        actionTime += dt;
        const actionDuration = actionKind === "boot" ? 1.15 : 0.78;
        const phase = Math.min(1, actionTime / actionDuration);
        const pulse = Math.sin(phase * Math.PI);
        if (actionKind === "ticket") {
          officer.rightArm.rotation.x = damp(officer.rightArm.rotation.x, -1.25 * pulse, 18, dt);
          officer.rightArm.rotation.z = -0.25 * pulse;
        } else if (actionKind === "lookup") {
          officer.leftArm.rotation.x = damp(officer.leftArm.rotation.x, -1.05 * pulse, 18, dt);
          officer.rightArm.rotation.x = damp(officer.rightArm.rotation.x, -0.8 * pulse, 18, dt);
        } else {
          crouch = pulse * 0.42;
          officer.rightArm.rotation.x = damp(officer.rightArm.rotation.x, -1.5 * pulse, 18, dt);
          officer.leftArm.rotation.x = damp(officer.leftArm.rotation.x, -1.1 * pulse, 18, dt);
        }
        armSwing *= 1 - pulse;
        legSwing *= 1 - pulse;
        if (phase >= 1) {
          actionKind = null;
          actionTime = 0;
        }
      }
      officer.leftArm.rotation.x = damp(officer.leftArm.rotation.x, armSwing, 16, dt);
      officer.rightArm.rotation.x = damp(officer.rightArm.rotation.x, -armSwing, 16, dt);
      officer.leftLeg.rotation.x = damp(officer.leftLeg.rotation.x, -legSwing, 16, dt);
      officer.rightLeg.rotation.x = damp(officer.rightLeg.rotation.x, legSwing, 16, dt);
      officer.root.position.y = 0.15 + Math.sin(cycle * 2) * 0.035 * gait - crouch;
      officer.body.rotation.z = Math.sin(cycle) * 0.035 * gait;

      cameraTarget.x = damp(cameraTarget.x, officer.root.position.x, 4.2, dt);
      cameraTarget.z = damp(cameraTarget.z, officer.root.position.z, 4.2, dt);
      const desiredCamera = new THREE.Vector3(
        cameraTarget.x + 13.5,
        20.5,
        cameraTarget.z + 18,
      );
      camera.position.lerp(desiredCamera, 1 - Math.exp(-3.5 * dt));
      camera.lookAt(cameraTarget.x, 1.3, cameraTarget.z - 1);
      feedback.updateListener(camera.position);

      world.rotation.y = gameActiveRef.current ? 0 : Math.sin(elapsed * 0.18) * 0.025;
        simulationAccumulator -= FIXED_STEP_SECONDS;
      }
      updateCameraOcclusion();
      renderer.render(scene, camera);
    };
    render();

    return () => {
      disposed = true;
      observer.disconnect();
      window.cancelAnimationFrame(resizeFrame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearHeldInput);
      window.removeEventListener("pagehide", markInterrupted);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      worldCollision.clear();
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      feedback.dispose();
      actionsRef.current = null;
      startRef.current = null;
      endRef.current = null;
      applyGraphicsRef.current = null;
      applyCityRef.current = null;
    };
  }, [clearToast, dailyChallenge, showToast]);

  const pressControl = useCallback((code: string, pressed: boolean) => {
    if (pressed) keysRef.current.add(code);
    else keysRef.current.delete(code);
  }, []);

  const requestBriefing = () => {
    if (startAttemptRef.current || briefingOpen) return;
    const normalizedName = playerName.trim().replace(/\s+/g, " ");
    if (
      normalizedName.length < 2 ||
      normalizedName.length > 18 ||
      !/^[\p{L}\p{N} ._'-]+$/u.test(normalizedName)
    ) {
      setNameError("Use 2–18 letters, numbers, spaces, or . _ ' -");
      if (screen !== "home") setScreen("home");
      return;
    }
    setNameError("");
    setPlayerName(normalizedName);
    window.localStorage.setItem("meter-mayhem-player-name", normalizedName);
    clearToast();
    setObjectiveOpen(false);
    setBriefingOpen(true);
  };

  const cancelBriefing = () => {
    if (startAttemptRef.current) return;
    setBriefingOpen(false);
  };

  const start = async () => {
    if (!briefingOpen || startAttemptRef.current) return;
    startAttemptRef.current = true;
    setStarting(true);
    shiftSessionRef.current = null;
    try {
      const storedGhost = await loadPersonalBestGhost(dailyChallenge.id);
      const matchingGhost = storedGhost?.rulesetVersion === DAILY_RULESET_VERSION
        ? storedGhost
        : null;
      ghostRunRef.current = matchingGhost;
      setGhostAvailable(Boolean(matchingGhost));
      const response = await fetchWithTimeout("/api/scores/session", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          challengeId: dailyChallenge.id,
          rulesetVersion: DAILY_RULESET_VERSION,
        }),
      });
      if (!response.ok) throw new Error("Dispatch unavailable");
      const payload = (await response.json()) as { session?: ShiftSession };
      if (
        !payload.session ||
        typeof payload.session.runId !== "string" ||
        typeof payload.session.issuedAt !== "number" ||
        typeof payload.session.token !== "string" ||
        payload.session.challengeId !== dailyChallenge.id ||
        payload.session.rulesetVersion !== DAILY_RULESET_VERSION
      ) {
        throw new Error("Invalid shift session");
      }
      shiftSessionRef.current = payload.session;
    } catch {
      shiftSessionRef.current = null;
    } finally {
      setStarting(false);
    }
    const startGame = startRef.current;
    if (startGame) startGame();
    else startAttemptRef.current = false;
  };
  const act = (kind: ActionKind) => actionsRef.current?.(kind);
  const cityStyle = {
    "--city-sky": colorToCss(city.palette.sky),
    "--city-accent": colorToCss(city.palette.uiAccent),
    "--city-deep": colorToCss(city.palette.uiDeep),
    "--city-highlight": colorToCss(city.palette.uiHighlight),
  } as CSSProperties;

  return (
    <main
      className={styles.shell}
      data-screen={screen}
      data-city={city.id}
      style={cityStyle}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-label="Colorful 3D city game view" />
      <div className={styles.sunGlow} />

      {screen === "loading" && (
        <section className={styles.loading} aria-live="polite">
          <div className={styles.loadingMark} aria-hidden="true">
            <span className={styles.tire} />
            <span className={styles.bootIcon}>★</span>
          </div>
          <p className={styles.eyebrow}>CITY SERVICES PRESENTS</p>
          <h1>Meter Mayhem</h1>
          <p className={styles.loadingLine}>Officer Graham is checking the meter map…</p>
          <small className={styles.streamLine}>{streamStatus}</small>
          <div className={styles.progressTrack}>
            <span style={{ width: `${loadProgress}%` }} />
          </div>
          <strong>{loadProgress}%</strong>
        </section>
      )}

      {screen === "home" && (
        <section className={styles.home}>
          <div className={styles.homeCard}>
            <p className={styles.eyebrow}>OFFICER GRAHAM NEEDS YOU</p>
            <h1>
              Meter
              <span>Mayhem</span>
            </h1>
            <div className={styles.grahamIntro}>
              <span className={styles.grahamAvatar} aria-hidden="true">OG</span>
              <div>
                <strong>Officer Graham</strong>
                <p>
                  “Dispatch just handed me the busiest block downtown. The
                  meters are turning red, and repeat offenders are circling.
                  Will you help me patrol?”
                </p>
              </div>
            </div>
            <section className={styles.dailyBriefing} data-testid="daily-dispatch">
              <header>
                <div>
                  <span>Daily dispatch · {dailyChallenge.date}</span>
                  <h2>{dailyChallenge.title}</h2>
                </div>
                <b>+{dailyChallenge.bonus}</b>
              </header>
              <p>{dailyChallenge.briefing}</p>
              <div className={styles.briefingObjective}>
                <span>Objective</span>
                <strong>{dailyChallenge.objective.label}</strong>
                <small>{dailyChallenge.objective.detail}</small>
              </div>
              <div className={styles.briefingIncident}>
                <span>{dailyChallenge.incident.title}</span>
                <small>Dispatch update at {dailyChallenge.incident.startsAtSeconds}s</small>
              </div>
              {ghostAvailable && (
                <p className={styles.ghostReady}>Personal-best ghost ready for this patrol</p>
              )}
            </section>
            <fieldset className={styles.cityPicker}>
              <legend>
                <span>Choose patrol city</span>
                <small>Same streets and challenge</small>
              </legend>
              <div className={styles.cityOptions}>
                {CITY_THEMES.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    className={cityId === choice.id ? styles.cityActive : ""}
                    onClick={() => selectCity(choice.id)}
                    aria-pressed={cityId === choice.id}
                    data-testid={`city-${choice.id}`}
                  >
                    <span className={styles.citySwatches} aria-hidden="true">
                      {choice.palette.buildings.slice(0, 3).map((color) => (
                        <i key={color} style={{ backgroundColor: colorToCss(color) }} />
                      ))}
                    </span>
                    <strong>{choice.name}</strong>
                    <small>{choice.description}</small>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className={styles.playerIdentity}>
              <label htmlFor="player-name">
                <span>Officer name</span>
                <input
                  id="player-name"
                  data-testid="player-name"
                  value={playerName}
                  maxLength={18}
                  autoComplete="nickname"
                  spellCheck={false}
                  placeholder="Enter your name"
                  onChange={(event) => {
                    setPlayerName(event.target.value);
                    setNameError("");
                  }}
                  aria-describedby={nameError ? "player-name-error" : undefined}
                  aria-invalid={Boolean(nameError)}
                />
              </label>
              <div>
                <b>DAILY SCORES</b>
                <small>Ranked after a full shift</small>
              </div>
              {nameError && <p id="player-name-error" role="alert">{nameError}</p>}
            </div>
            <div className={styles.graphicsPicker}>
              <div className={styles.graphicsHeading}>
                <span>Graphics mode</span>
                <small>{graphicsLabel}</small>
              </div>
              <div className={styles.graphicsOptions}>
                {GRAPHICS_CHOICES.map((choice) => (
                  <button
                    key={choice.mode}
                    className={graphicsMode === choice.mode ? styles.graphicsActive : ""}
                    onClick={() => selectGraphicsMode(choice.mode)}
                    aria-pressed={graphicsMode === choice.mode}
                    title={choice.note}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className={styles.primaryButton}
              onClick={requestBriefing}
              data-testid="start-game"
            >
              Review shift briefing <span>→</span>
            </button>
            <p className={styles.shiftNote}>
              {city.name} · {SHIFT_DURATION_SECONDS}-second shift · Same seeded challenge in every city
            </p>
          </div>

          <aside className={styles.instructions} aria-label="How to play">
            <div className={styles.instructionsTitle}>
              <span>How to play</span>
              <b>3 steps</b>
            </div>
            <ol>
              <li>
                <i>1</i>
                <div>
                  <strong>Explore downtown</strong>
                  <span>Use arrows, WASD, touch, or a controller. Hold Shift, Run, or a bumper to sprint.</span>
                </div>
              </li>
              <li>
                <i>2</i>
                <div>
                  <strong>Watch the meters</strong>
                  <span>Red means expired. Get close and press Q to ticket.</span>
                </div>
              </li>
              <li>
                <i>3</i>
                <div>
                  <strong>Catch repeat offenders</strong>
                  <span>Press W to look up a plate. Ticket first, then E to boot.</span>
                </div>
              </li>
            </ol>
            <div className={styles.scoreGuide}>
              <span><b>+100</b> valid ticket</span>
              <span><b>+250</b> valid boot</span>
            </div>
          </aside>
        </section>
      )}

      <dialog
        ref={briefingDialogRef}
        className={styles.shiftBriefingDialog}
        aria-labelledby="shift-briefing-title"
        aria-describedby="shift-briefing-summary shift-briefing-timing"
        data-testid="pre-shift-briefing"
        onCancel={(event) => {
          event.preventDefault();
          cancelBriefing();
        }}
        onClose={() => {
          if (briefingOpen) setBriefingOpen(false);
        }}
      >
        <div className={styles.shiftBriefingCard}>
          <header className={styles.shiftBriefingHeader}>
            <div>
              <span>Daily dispatch · {dailyChallenge.date}</span>
              <h1 id="shift-briefing-title">{dailyChallenge.title}</h1>
            </div>
            <b>{city.name}</b>
          </header>

          <p id="shift-briefing-summary" className={styles.shiftBriefingSummary}>
            {dailyChallenge.briefing}
          </p>

          <section className={styles.briefingMission} aria-labelledby="briefing-objective-title">
            <div>
              <span>Your objective</span>
              <h2 id="briefing-objective-title">{dailyChallenge.objective.label}</h2>
              <p>{dailyChallenge.objective.detail}</p>
            </div>
            <strong>+{dailyChallenge.bonus}<small>bonus points</small></strong>
          </section>

          <div className={styles.briefingDetails}>
            <article>
              <span>Dispatch event</span>
              <h3>{dailyChallenge.incident.title}</h3>
              <p>{dailyChallenge.incident.message}</p>
              <small>
                Starts {dailyChallenge.incident.startsAtSeconds}s into the shift
                {dailyChallenge.incident.durationSeconds > 0
                  ? ` · lasts ${dailyChallenge.incident.durationSeconds}s`
                  : ""}
              </small>
            </article>
            <article>
              <span>Shift plan</span>
              <h3>{SHIFT_DURATION_SECONDS} seconds on patrol</h3>
              <p>Move with arrows, WASD, touch, or a controller. Scan plates before booting.</p>
              <small>{ghostAvailable ? "Your personal-best ghost will join this run." : "Complete the full shift to rank."}</small>
            </article>
          </div>

          <p id="shift-briefing-timing" className={styles.briefingTiming}>
            The timer starts only after you press Start shift.
          </p>

          <div className={styles.briefingActions}>
            <button
              type="button"
              className={styles.briefingBackButton}
              onClick={cancelBriefing}
              disabled={starting}
            >
              Back
            </button>
            <button
              ref={briefingStartRef}
              type="button"
              className={styles.primaryButton}
              onClick={() => void start()}
              data-testid="confirm-shift"
              disabled={starting}
            >
              {starting ? "Calling dispatch…" : `Start ${SHIFT_DURATION_SECONDS}-second shift`}
              <span>→</span>
            </button>
          </div>
        </div>
      </dialog>

      {screen === "playing" && (
        <>
          <header className={styles.hud}>
            <div className={styles.brandMini}>
              <span className={styles.miniMark}>M</span>
              <div><b>Meter Mayhem</b><small>{city.name} patrol</small></div>
            </div>
            <div className={styles.hudStats}>
              <div><small>Score</small><strong data-testid="score">{stats.score.toLocaleString()}</strong></div>
              <div><small>Tickets</small><strong data-testid="tickets">{stats.tickets}</strong></div>
              <div className={stats.combo > 1 ? styles.comboLive : ""}><small>Combo</small><strong>{Math.max(1, stats.combo)}×</strong></div>
              <div className={stats.timeLeft <= 15 ? styles.timeUrgent : ""}><small>Shift ends</small><strong data-testid="timer">{Math.ceil(stats.timeLeft)}s</strong></div>
            </div>
            <div className={styles.hudButtons}>
              <button
                onClick={() => setGraphicsOpen((value) => !value)}
                aria-label="Graphics settings"
                aria-expanded={graphicsOpen}
              >
                ◐
              </button>
              <button onClick={() => setAudioOn((value) => !value)} aria-label={audioOn ? "Mute sound" : "Turn on sound"}>
                {audioOn ? "♫" : "♩"}
              </button>
              <button onClick={() => endRef.current?.()} aria-label="End shift">×</button>
            </div>
          </header>

          <section
            className={styles.objectiveDock}
            data-complete={objectiveStatus.complete}
            data-open={objectiveOpen}
            data-testid="objective-reminder"
          >
            <button
              type="button"
              className={styles.objectiveSummary}
              aria-expanded={objectiveOpen}
              aria-controls="objective-details"
              onClick={() => setObjectiveOpen((value) => !value)}
              data-testid="objective-toggle"
            >
              <span className={styles.objectiveSummaryText}>
                <small>{objectiveStatus.complete ? "Objective complete" : "Daily objective"}</small>
                <strong>{dailyChallenge.objective.label}</strong>
              </span>
              <b className={styles.objectiveCount}>
                {Math.floor(objectiveStatus.current)} / {objectiveStatus.target}
              </b>
              <span className={styles.objectiveChevron} aria-hidden="true">⌄</span>
            </button>
            <div
              className={styles.objectiveProgress}
              role="progressbar"
              aria-label="Daily objective progress"
              aria-valuemin={0}
              aria-valuemax={objectiveStatus.target}
              aria-valuenow={Math.floor(objectiveStatus.current)}
            >
              <span style={{ width: `${objectiveStatus.progress * 100}%` }} />
            </div>
            <div
              id="objective-details"
              className={styles.objectiveDetails}
              data-testid="objective-details"
              hidden={!objectiveOpen}
            >
              <p>{dailyChallenge.objective.detail}</p>
              <div className={styles.incidentStatus}>
                <span>{dailyChallenge.incident.title}</span>
                <small>
                  {SHIFT_DURATION_SECONDS - stats.timeLeft < dailyChallenge.incident.startsAtSeconds
                    ? `Incoming in ${Math.ceil(
                        dailyChallenge.incident.startsAtSeconds -
                          (SHIFT_DURATION_SECONDS - stats.timeLeft),
                      )}s`
                    : SHIFT_DURATION_SECONDS - stats.timeLeft <
                        dailyChallenge.incident.startsAtSeconds +
                          dailyChallenge.incident.durationSeconds
                      ? "Active now"
                      : "Dispatch handled"}
                </small>
              </div>
              {ghostAvailable && <b className={styles.ghostBadge}>PB GHOST ACTIVE</b>}
            </div>
          </section>

          {graphicsOpen && (
            <aside className={styles.graphicsDrawer} aria-label="Graphics settings">
              <div>
                <span>Graphics</span>
                <button onClick={() => setGraphicsOpen(false)} aria-label="Close graphics settings">×</button>
              </div>
              <p>{streamStatus}</p>
              {GRAPHICS_CHOICES.map((choice) => (
                <button
                  key={choice.mode}
                  className={graphicsMode === choice.mode ? styles.graphicsActive : ""}
                  onClick={() => selectGraphicsMode(choice.mode)}
                  aria-pressed={graphicsMode === choice.mode}
                >
                  <span>{choice.label}</span>
                  <small>{choice.note}</small>
                </button>
              ))}
            </aside>
          )}

          {toast && <div className={styles.toast} role="status" aria-live="polite">{toast}</div>}

          <aside className={`${styles.vehiclePanel} ${context ? styles.vehiclePanelOpen : ""}`} aria-live="polite">
            {context ? (
              <>
                <div className={styles.plateRow}>
                  <span>Nearby vehicle</span>
                  <strong>{context.plate}</strong>
                </div>
                <div className={`${styles.meterStatus} ${context.expired ? styles.expired : styles.paid}`}>
                  <span className={styles.statusDot} />
                  <div><small>Parking meter</small><strong>{formatMeter(context.seconds)}</strong></div>
                </div>
                {context.priority && <b className={styles.priorityBadge}>PRIORITY TARGET</b>}
                {context.lookedUp && (
                  <div className={styles.record}>
                    <span>Plate record</span>
                    <strong>{context.priors} prior violation{context.priors === 1 ? "" : "s"}</strong>
                    {context.priors >= 3 && <b>BOOT ELIGIBLE</b>}
                  </div>
                )}
                <div className={styles.actionButtons}>
                  <button onClick={() => act("ticket")} disabled={context.ticketed}>
                    <kbd>Q</kbd>{context.ticketed ? "Ticketed" : "Write ticket"}
                  </button>
                  <button onClick={() => act("lookup")}>
                    <kbd>W</kbd>{context.lookedUp ? "Record open" : "Look up plate"}
                  </button>
                  {context.lookedUp && context.priors >= 3 && (
                    <button onClick={() => act("boot")} disabled={context.booted}>
                      <kbd>E</kbd>{context.booted ? "Booted" : "Place boot"}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.walkHint}>
                <span>←</span>
                <div><strong>Keep patrolling</strong><small>Walk near a parked vehicle</small></div>
              </div>
            )}
          </aside>

          <div className={styles.movementHint}>
            <div className={styles.keyGrid} aria-hidden="true">
              <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd>
            </div>
            <span>
              {controllerConnected
                ? "Controller: stick moves · A tickets · X scans · B boots · bumper runs"
                : "Arrow keys move · Q W E act · Shift runs"}
            </span>
          </div>

          <div className={styles.touchControls} aria-label="Touch controls">
            <div className={styles.touchPad}>
              <button
                aria-label="Move up"
                onPointerDown={() => pressControl("KeyW", true)}
                onPointerUp={() => pressControl("KeyW", false)}
                onPointerCancel={() => pressControl("KeyW", false)}
                onPointerLeave={() => pressControl("KeyW", false)}
              >↑</button>
              <button
                className={styles.touchRun}
                onPointerDown={() => pressControl("ShiftLeft", true)}
                onPointerUp={() => pressControl("ShiftLeft", false)}
                onPointerCancel={() => pressControl("ShiftLeft", false)}
                onPointerLeave={() => pressControl("ShiftLeft", false)}
              >Run</button>
              <button
                aria-label="Move left"
                onPointerDown={() => pressControl("KeyA", true)}
                onPointerUp={() => pressControl("KeyA", false)}
                onPointerCancel={() => pressControl("KeyA", false)}
                onPointerLeave={() => pressControl("KeyA", false)}
              >←</button>
              <button
                aria-label="Move down"
                onPointerDown={() => pressControl("KeyS", true)}
                onPointerUp={() => pressControl("KeyS", false)}
                onPointerCancel={() => pressControl("KeyS", false)}
                onPointerLeave={() => pressControl("KeyS", false)}
              >↓</button>
              <button
                aria-label="Move right"
                onPointerDown={() => pressControl("KeyD", true)}
                onPointerUp={() => pressControl("KeyD", false)}
                onPointerCancel={() => pressControl("KeyD", false)}
                onPointerLeave={() => pressControl("KeyD", false)}
              >→</button>
            </div>
            <div className={styles.touchActions}>
              <button onClick={() => act("ticket")}>Ticket</button>
              <button onClick={() => act("lookup")}>Scan</button>
              <button onClick={() => act("boot")}>Boot</button>
            </div>
          </div>
          <output className={styles.fps} data-testid="fps">{stats.fps} FPS</output>
        </>
      )}

      {screen === "gameover" && (
        <section className={styles.gameOver}>
          <div className={styles.confetti} aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => <i key={index} />)}
          </div>
          <div className={styles.resultsWrap}>
            <div className={styles.resultCard}>
              <p className={styles.eyebrow}>
                {city.name.toUpperCase()} {result.ranked ? "SHIFT COMPLETE" : "PRACTICE RESULT"}
              </p>
              <h1>{resultTitle(result.score)}</h1>
              <p className={styles.resultLead}>
                {result.ranked
                  ? "The full patrol is logged. Dispatch has your final report."
                  : result.rankedReason}
              </p>
              <div className={styles.finalScore}>
                <span>{playerName}&apos;s final score</span>
                <strong data-testid="final-score">{result.score.toLocaleString()}</strong>
                {result.ranked && result.score >= result.best && result.score > 0 && <b>NEW BEST!</b>}
              </div>
              <div className={styles.resultStats}>
                <div><strong>{result.tickets}</strong><span>Tickets</span></div>
                <div><strong>{result.boots}</strong><span>Boots</span></div>
                <div><strong>{result.best.toLocaleString()}</strong><span>Daily best</span></div>
              </div>
              <div className={styles.objectiveResult} data-complete={result.objectiveCompleted}>
                <div>
                  <span>Daily objective</span>
                  <strong>{dailyChallenge.objective.label}</strong>
                </div>
                <b>
                  {result.objectiveCompleted
                    ? `Complete · +${result.objectiveBonus}`
                    : "Not completed"}
                </b>
              </div>
              {result.ghostSaved && (
                <p className={styles.ghostSaved}>New personal-best ghost saved for today.</p>
              )}
              <div className={styles.scoreStatus} data-kind={scoreStatus.kind} aria-live="polite">
                <span>{scoreStatus.message}</span>
                {scoreStatus.kind === "error" && result.token && result.ranked && (
                  <button onClick={() => void submitScore(result)}>Retry score</button>
                )}
              </div>
              <button
                className={styles.primaryButton}
                onClick={requestBriefing}
                data-testid="play-again"
              >
                Review next patrol <span>↻</span>
              </button>
              <button className={styles.textButton} onClick={() => setScreen("home")}>Back to instructions</button>
            </div>

            <aside className={styles.leaderboard} aria-label="Global leaderboard">
              <header>
                <div>
                  <span>All patrol cities</span>
                  <h2>Top officers</h2>
                </div>
                <b>{boardScope === "daily" ? "TODAY" : "ALL TIME"}</b>
              </header>
              <div className={styles.boardTabs} aria-label="Leaderboard range">
                <button
                  data-active={boardScope === "daily"}
                  onClick={() => setBoardScope("daily")}
                >Today</button>
                <button
                  data-active={boardScope === "all"}
                  onClick={() => setBoardScope("all")}
                >All time</button>
              </div>
              {scoresLoading && globalScores.length === 0 ? (
                <p className={styles.boardMessage}>Calling dispatch…</p>
              ) : scoresError && globalScores.length === 0 ? (
                <p className={styles.boardMessage}>Dispatch could not load global scores.</p>
              ) : globalScores.length > 0 ? (
                <ol>
                  {globalScores.map((entry, index) => (
                    <li
                      key={entry.entryId}
                      data-player={
                        lastSavedScore && entry.entryId === lastSavedScore.entryId
                          ? "current"
                          : undefined
                      }
                    >
                      <i>{index + 1}</i>
                      <div>
                        <strong>{entry.playerName}</strong>
                        <small>{entry.tickets} tickets · {entry.boots} boots</small>
                      </div>
                      <b>{entry.score.toLocaleString()}</b>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className={styles.boardMessage}>
                  No {boardScope === "daily" ? "daily" : "global"} scores yet. Take the first spot.
                </p>
              )}
              <button onClick={() => void refreshScores(boardScope)}>Refresh scores</button>
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}
