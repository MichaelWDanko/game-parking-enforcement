"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import styles from "./parking-game.module.css";

type Screen = "loading" | "home" | "playing" | "gameover";
type ActionKind = "ticket" | "lookup" | "boot";
type GraphicsMode = "auto" | "performance" | "balanced" | "quality";

type GraphicsProfile = {
  label: string;
  pixelRatio: number;
  shadows: boolean;
  fogNear: number;
  fogFar: number;
  trafficCount: number;
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
} | null;

type GameResult = {
  runId: string;
  issuedAt: number;
  token: string;
  score: number;
  tickets: number;
  boots: number;
  best: number;
};

type ShiftSession = Pick<GameResult, "runId" | "issuedAt" | "token">;

type GlobalScore = {
  entryId: string;
  playerName: string;
  score: number;
  tickets: number;
  boots: number;
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
  phase: "arriving" | "parked" | "leaving";
  phaseTime: number;
  group: THREE.Group;
  ticketMesh?: THREE.Mesh;
  bootMesh?: THREE.Mesh;
};

type ParkingSpot = {
  x: number;
  z: number;
  side: number;
  meterLight: THREE.Mesh;
  car: CarData | null;
  respawnAt: number;
};

const INITIAL_STATS: Stats = {
  score: 0,
  tickets: 0,
  boots: 0,
  combo: 0,
  timeLeft: 90,
  fps: 60,
};

const CAR_COLORS = [0xff6577, 0x48d6c8, 0x7667e8, 0xffa447, 0x3e8bea, 0xf3f0d0];
const PLATE_STARTS = ["ZIP", "MTR", "BEEP", "PARK", "TKT", "VROOM", "CITY"];
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const GRAPHICS_PROFILES: Record<Exclude<GraphicsMode, "auto">, GraphicsProfile> = {
  performance: {
    label: "Performance",
    pixelRatio: 0.9,
    shadows: false,
    fogNear: 30,
    fogFar: 64,
    trafficCount: 2,
    details: false,
  },
  balanced: {
    label: "Balanced",
    pixelRatio: 1.25,
    shadows: true,
    fogNear: 44,
    fogFar: 88,
    trafficCount: 4,
    details: true,
  },
  quality: {
    label: "Quality",
    pixelRatio: 1.8,
    shadows: true,
    fogNear: 56,
    fogFar: 118,
    trafficCount: 6,
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

function makePlate() {
  const word = PLATE_STARTS[Math.floor(Math.random() * PLATE_STARTS.length)];
  return `${word}-${Math.floor(100 + Math.random() * 900)}`;
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef(new Set<string>());
  const actionsRef = useRef<((kind: ActionKind) => void) | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const endRef = useRef<(() => void) | null>(null);
  const gameActiveRef = useRef(false);
  const audioOnRef = useRef(true);
  const applyGraphicsRef = useRef<((mode: GraphicsMode) => void) | null>(null);
  const lastSubmittedRunRef = useRef("");
  const submissionInFlightRef = useRef("");
  const shiftSessionRef = useRef<ShiftSession | null>(null);
  const [screen, setScreen] = useState<Screen>("loading");
  const [loadProgress, setLoadProgress] = useState(0);
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);
  const [context, setContext] = useState<CarContext>(null);
  const [toast, setToast] = useState("Find an expired meter");
  const [result, setResult] = useState<GameResult>({
    runId: "",
    issuedAt: 0,
    token: "",
    score: 0,
    tickets: 0,
    boots: 0,
    best: 0,
  });
  const [audioOn, setAudioOn] = useState(true);
  const [graphicsMode, setGraphicsMode] = useState<GraphicsMode>("auto");
  const graphicsModeRef = useRef<GraphicsMode>("auto");
  const [graphicsOpen, setGraphicsOpen] = useState(false);
  const [graphicsLabel, setGraphicsLabel] = useState("Auto");
  const [streamStatus, setStreamStatus] = useState("Opening the downtown map");
  const [playerName, setPlayerName] = useState("");
  const [nameError, setNameError] = useState("");
  const [globalScores, setGlobalScores] = useState<GlobalScore[]>([]);
  const [scoresLoading, setScoresLoading] = useState(true);
  const [scoresError, setScoresError] = useState(false);
  const [lastSavedScore, setLastSavedScore] = useState<GlobalScore | null>(null);
  const [starting, setStarting] = useState(false);
  const [scoreStatus, setScoreStatus] = useState<ScoreStatus>({
    kind: "idle",
    message: "Your result will be added to the global board.",
  });

  useEffect(() => {
    const saved = window.localStorage.getItem("meter-mayhem-graphics") as GraphicsMode | null;
    const savedName = window.localStorage.getItem("meter-mayhem-player-name");
    if (!saved && !savedName) return;
    const timer = window.setTimeout(() => {
      if (saved && ["auto", "performance", "balanced", "quality"].includes(saved)) {
        graphicsModeRef.current = saved;
        setGraphicsMode(saved);
        applyGraphicsRef.current?.(saved);
      }
      if (savedName) setPlayerName(savedName.slice(0, 18));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const refreshScores = useCallback(async () => {
    setScoresLoading(true);
    setScoresError(false);
    try {
      const response = await fetchWithTimeout("/api/scores", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Scores unavailable");
      const payload = (await response.json()) as { scores?: GlobalScore[] };
      setGlobalScores(Array.isArray(payload.scores) ? payload.scores.slice(0, 10) : []);
    } catch {
      setScoresError(true);
    } finally {
      setScoresLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshScores(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshScores]);

  const submitScore = useCallback(async (gameResult: GameResult) => {
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
      await refreshScores();
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
    if (screen !== "gameover" || !result.runId) return;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const initialProfile = resolveGraphicsProfile(graphicsModeRef.current);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialProfile.pixelRatio));
    renderer.shadowMap.enabled = initialProfile.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7bdcf4);
    scene.fog = new THREE.Fog(0x8de3f4, initialProfile.fogNear, initialProfile.fogFar);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 150);
    camera.position.set(19, 20, 24);
    const cameraTarget = new THREE.Vector3(0, 0, 7);

    const hemi = new THREE.HemisphereLight(0xfff1bf, 0x7f87c7, 2.4);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0c8, 4.2);
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

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 138),
      new THREE.MeshStandardMaterial({ color: 0x88c96e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.07;
    ground.receiveShadow = true;
    world.add(ground);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(13.8, 112),
      new THREE.MeshStandardMaterial({ color: 0x52657b, roughness: 0.96 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0;
    road.receiveShadow = true;
    world.add(road);

    const sidewalkMaterial = new THREE.MeshStandardMaterial({ color: 0xffc987, roughness: 1 });
    for (const x of [-9.25, 9.25]) {
      const sidewalk = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.24, 112), sidewalkMaterial);
      sidewalk.position.set(x, 0.08, 0);
      sidewalk.receiveShadow = true;
      world.add(sidewalk);
    }

    const stripeMaterial = new THREE.MeshBasicMaterial({ color: 0xffefb0 });
    for (let z = -52; z <= 52; z += 8) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 3.9), stripeMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, 0.015, z);
      world.add(stripe);
    }

    const animatedTrees: THREE.Group[] = [];
    const qualityDetails: THREE.Object3D[] = [];
    const loadedChunks = new Map<string, THREE.Group>();
    const loadingChunks = new Set<string>();
    let chunkManifest: WorldManifest | null = null;
    let disposed = false;

    const createCityChunk = (data: WorldChunkData) => {
      const chunk = new THREE.Group();
      chunk.name = `city-chunk-${data.id}`;

      for (const item of data.buildings) {
        const color = Number.parseInt(item.color.replace("#", ""), 16);
        const accent = Number.parseInt(item.accent.replace("#", ""), 16);
        const building = roundedBox(item.width, item.height, item.depth, color);
        building.position.set(item.side * 17, item.height / 2, item.z);
        chunk.add(building);

        const crown = roundedBox(item.width * 0.72, 0.5, item.depth * 0.72, accent, 0.7);
        crown.position.set(item.side * 17, item.height + 0.18, item.z);
        chunk.add(crown);

        const awning = roundedBox(item.width * 0.68, 0.32, 1.2, accent);
        awning.position.set(
          item.side * 17 - item.side * (item.width / 2 + 0.15),
          2.15,
          item.z,
        );
        awning.rotation.z = item.side * -0.18;
        chunk.add(awning);

        const windowMaterial = new THREE.MeshStandardMaterial({
          color: 0xeafcff,
          emissive: 0x6ad5e3,
          emissiveIntensity: 0.5,
          roughness: 0.3,
        });
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
            chunk.add(windowMesh);
            qualityDetails.push(windowMesh);
          }
        }
        addShadow(building);
      }

      for (const item of data.trees) {
        const tree = new THREE.Group();
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.24, 1.7, 8),
          new THREE.MeshStandardMaterial({ color: 0x865938 }),
        );
        trunk.position.y = 0.85;
        const crown = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1.1, 1),
          new THREE.MeshStandardMaterial({
            color: Number.parseInt(item.color.replace("#", ""), 16),
            roughness: 0.94,
          }),
        );
        crown.position.y = 2.2;
        tree.add(trunk, crown);
        tree.position.set(item.side * 10.4, 0.2, item.z);
        tree.userData.windPhase = item.z * 0.37 + item.side;
        addShadow(tree);
        animatedTrees.push(tree);
        chunk.add(tree);
      }

      for (const item of data.lamps) {
        const lamp = new THREE.Group();
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.07, 0.11, 3.9, 10),
          new THREE.MeshStandardMaterial({ color: 0x2d4059, metalness: 0.35 }),
        );
        pole.position.y = 1.95;
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.22, 12, 8),
          new THREE.MeshStandardMaterial({
            color: 0xffefaf,
            emissive: 0xffbd45,
            emissiveIntensity: 2.2,
          }),
        );
        bulb.position.y = 3.95;
        lamp.add(pole, bulb);
        lamp.position.set(item.side * 11.25, 0.2, item.z);
        addShadow(lamp);
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
      loadedChunks.set(definition.id, chunk);
      loadingChunks.delete(definition.id);
      setStreamStatus(`${loadedChunks.size}/${chunkManifest?.chunks.length ?? 5} city blocks ready`);
    };

    const clouds: THREE.Group[] = [];
    for (let index = 0; index < 7; index++) {
      const cloud = new THREE.Group();
      const cloudMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.72,
        roughness: 1,
      });
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
      cloud.position.set(-28 + index * 9, 17 + (index % 3) * 2.2, -42 + index * 15);
      cloud.scale.setScalar(1.2 + (index % 2) * 0.5);
      clouds.push(cloud);
      qualityDetails.push(cloud);
      world.add(cloud);
    }

    const motePositions = new Float32Array(90 * 3);
    for (let index = 0; index < 90; index++) {
      motePositions[index * 3] = (Math.random() - 0.5) * 26;
      motePositions[index * 3 + 1] = 0.4 + Math.random() * 7;
      motePositions[index * 3 + 2] = (Math.random() - 0.5) * 105;
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
    const motes = new THREE.Points(
      moteGeometry,
      new THREE.PointsMaterial({
        color: 0xfff0a8,
        size: 0.12,
        transparent: true,
        opacity: 0.58,
      }),
    );
    qualityDetails.push(motes);
    world.add(motes);

    const spots: ParkingSpot[] = [];
    for (const side of [-1, 1]) {
      for (const z of [-27, -9, 9, 27]) {
        const meter = createMeter(side);
        meter.group.position.set(side * 7.4, 0.2, z + 2.3);
        world.add(meter.group);
        spots.push({ x: side * 5.35, z, side, meterLight: meter.light, car: null, respawnAt: 0 });

        const marking = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(2.8, 0.02, 6.8)),
          new THREE.LineBasicMaterial({ color: 0xf7e9a7 }),
        );
        marking.position.set(side * 5.35, 0.025, z);
        world.add(marking);
      }
    }

    const officer = createOfficer();
    officer.root.position.set(-8.5, 0.15, -9);
    world.add(officer.root);

    const movingCars: { group: THREE.Group; speed: number; lane: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const group = createCar(CAR_COLORS[(i + 2) % CAR_COLORS.length]);
      group.scale.setScalar(0.82);
      const lane = i % 2 === 0 ? -1.9 : 1.9;
      group.position.set(lane, 0.08, -50 + i * 20);
      if (lane > 0) group.rotation.y = Math.PI;
      world.add(group);
      movingCars.push({ group, speed: lane < 0 ? 5.2 + i * 0.45 : -(5.2 + i * 0.45), lane });
    }

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
      movingCars.forEach((traffic, index) => {
        traffic.group.visible = index < profile.trafficCount;
      });
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
      setStreamStatus(`Loading ${manifest.district}`);
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
      setStreamStatus(`${loadedChunks.size}/${manifest.chunks.length} city blocks ready`);
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
    let nearest: CarData | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let lastContextKey = "";
    let lastStatsPush = 0;
    let fpsWindow = 60;
    let fpsFrames = 0;
    let fpsTime = 0;
    let lastStreamCheck = 0;

    const audioContextRef: { value: AudioContext | null } = { value: null };
    const playTone = (frequency: number, duration: number, type: OscillatorType = "sine") => {
      if (!audioOnRef.current) return;
      try {
        audioContextRef.value ??= new AudioContext();
        const audio = audioContextRef.value;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.09, audio.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + duration);
      } catch {
        // Audio is optional and browser policies may block it.
      }
    };

    const removeCar = (spot: ParkingSpot) => {
      if (!spot.car) return;
      world.remove(spot.car.group);
      spot.car = null;
      spot.respawnAt = gameTime + 3 + Math.random() * 4;
    };

    const spawnCar = (spot: ParkingSpot, initial = false) => {
      const color = CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
      const group = createCar(color);
      group.position.set(spot.x, 0.08, initial ? spot.z : -43);
      group.rotation.y = 0;
      world.add(group);
      const priorsPool = [0, 0, 1, 2, 3, 4, 5];
      const overdue = initial && Math.random() < 0.46;
      spot.car = {
        plate: makePlate(),
        priors: priorsPool[Math.floor(Math.random() * priorsPool.length)],
        color,
        expireAt: gameTime + (overdue ? -(2 + Math.random() * 8) : 6 + Math.random() * 20),
        departAt: gameTime + 24 + Math.random() * 22,
        ticketed: false,
        booted: false,
        lookedUp: false,
        phase: initial ? "parked" : "arriving",
        phaseTime: 0,
        group,
      };
    };

    spots.forEach((spot, index) => {
      if (index < 6) {
        spawnCar(spot, true);
        if (index === 1 && spot.car) {
          spot.car.expireAt = gameTime - 4;
          spot.car.priors = 4;
        }
      }
      else spot.respawnAt = index === 6 ? 5 : 11;
    });

    const pushStats = () => {
      const timeLeft = Math.max(0, 90 - gameTime);
      setStats({ score, tickets, boots, combo, timeLeft, fps: Math.round(fpsWindow) });
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
            }
          : null;
      const key = JSON.stringify(next);
      if (key !== lastContextKey) {
        lastContextKey = key;
        setContext(next);
      }
    };

    const finishGame = () => {
      if (!gameActiveRef.current) return;
      gameActiveRef.current = false;
      const previousBest = Number(window.localStorage.getItem("meter-mayhem-best") ?? 0);
      const best = Math.max(previousBest, score);
      window.localStorage.setItem("meter-mayhem-best", String(best));
      const session = shiftSessionRef.current;
      setResult({
        runId: session?.runId ?? crypto.randomUUID(),
        issuedAt: session?.issuedAt ?? 0,
        token: session?.token ?? "",
        score,
        tickets,
        boots,
        best,
      });
      setScreen("gameover");
      playTone(392, 0.16);
      window.setTimeout(() => playTone(523, 0.3), 130);
    };

    const startGame = () => {
      spots.forEach((spot) => removeCar(spot));
      gameTime = 0;
      score = 0;
      tickets = 0;
      boots = 0;
      combo = 0;
      lastTicketTime = -20;
      officer.root.position.set(-8.5, 0.15, -9);
      officer.root.rotation.y = 0;
      spots.forEach((spot, index) => {
        if (index < 6) {
          spawnCar(spot, true);
          if (index === 1 && spot.car) {
            spot.car.expireAt = gameTime - 4;
            spot.car.priors = 4;
          }
        }
        else spot.respawnAt = index === 6 ? 4 : 9;
      });
      pushStats();
      setContext(null);
      setToast("Find an expired meter");
      setLastSavedScore(null);
      setScoreStatus({
        kind: "idle",
        message: "Your result will be added to the global board.",
      });
      gameActiveRef.current = true;
      setScreen("playing");
      playTone(440, 0.08, "square");
      window.setTimeout(() => playTone(660, 0.15, "square"), 90);
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
        setToast("Move closer to a parked car");
        playTone(170, 0.12, "sawtooth");
        return;
      }
      const car = nearest;
      const spot = spots.find((candidate) => candidate.car === car);
      if (!spot) return;

      actionKind = kind;
      actionTime = 0;
      if (kind === "lookup") {
        car.lookedUp = true;
        setToast(car.priors >= 3 ? `${car.plate}: repeat offender — boot eligible` : `${car.plate}: ${car.priors} prior violations`);
        playTone(520, 0.08, "square");
        pushContext();
        return;
      }

      if (kind === "ticket") {
        if (car.ticketed) {
          setToast("Already ticketed this parking stay");
          playTone(190, 0.1, "sawtooth");
        } else if (car.expireAt > gameTime) {
          score = Math.max(0, score - 75);
          combo = 0;
          setToast("Too early! −75");
          playTone(150, 0.2, "sawtooth");
        } else {
          combo = gameTime - lastTicketTime <= 12 ? combo + 1 : 1;
          const points = 100 + Math.max(0, combo - 1) * 20;
          score += points;
          tickets += 1;
          lastTicketTime = gameTime;
          car.ticketed = true;
          addTicketVisual(car);
          setToast(combo > 1 ? `Valid ticket +${points} · ${combo}× combo!` : `Valid ticket +${points}`);
          playTone(740, 0.08, "square");
          window.setTimeout(() => playTone(920, 0.12, "square"), 70);
        }
      }

      if (kind === "boot") {
        if (!car.lookedUp) {
          setToast("Look up the plate first");
          playTone(190, 0.1, "sawtooth");
        } else if (!car.ticketed) {
          setToast("Write the expired-meter ticket first");
          playTone(190, 0.1, "sawtooth");
        } else if (car.priors < 3) {
          score = Math.max(0, score - 150);
          combo = 0;
          setToast("Not a repeat offender! −150");
          playTone(125, 0.22, "sawtooth");
        } else if (car.booted) {
          setToast("This vehicle is already immobilized");
        } else {
          car.booted = true;
          boots += 1;
          score += 250;
          addBootVisual(car, spot);
          setToast("Boot secured +250");
          playTone(260, 0.08, "square");
          window.setTimeout(() => playTone(390, 0.16, "square"), 90);
        }
      }
      pushStats();
      pushContext();
    };

    actionsRef.current = doAction;
    startRef.current = startGame;
    endRef.current = finishGame;

    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.repeat) return;
      keysRef.current.add(event.code);
      if (event.code === "KeyE") doAction("ticket");
      if (event.code === "KeyF") doAction("lookup");
      if (event.code === "KeyB") doAction("boot");
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = () => {
      if (disposed) return;
      requestAnimationFrame(render);
      const now = performance.now();
      const rawDt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const dt = Math.max(rawDt, 1 / 240);
      elapsed += dt;
      fpsFrames += 1;
      fpsTime += dt;
      if (fpsTime >= 0.5) {
        fpsWindow = damp(fpsWindow, fpsFrames / fpsTime, 5, fpsTime);
        fpsFrames = 0;
        fpsTime = 0;
      }

      for (const traffic of movingCars) {
        traffic.group.position.z += traffic.speed * dt;
        if (traffic.group.position.z > 58) traffic.group.position.z = -58;
        if (traffic.group.position.z < -58) traffic.group.position.z = 58;
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
        gameTime += dt;
        if (gameTime >= 90) finishGame();

        const keys = keysRef.current;
        const inputX =
          (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
          (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
        const inputZ =
          (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) -
          (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
        const length = Math.hypot(inputX, inputZ);
        const targetSpeed = length > 0 ? (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 8.2 : 5.7) : 0;
        runningSpeed = damp(runningSpeed, targetSpeed, length > 0 ? 9 : 12, dt);
        if (length > 0) {
          const moveX = inputX / length;
          const moveZ = inputZ / length;
          officer.root.position.x += moveX * runningSpeed * dt;
          officer.root.position.z += moveZ * runningSpeed * dt;
          const targetAngle = Math.atan2(moveX, moveZ);
          officer.root.rotation.y = dampAngle(officer.root.rotation.y, targetAngle, 13, dt);
        }
        officer.root.position.x = THREE.MathUtils.clamp(officer.root.position.x, -11.2, 11.2);
        officer.root.position.z = THREE.MathUtils.clamp(officer.root.position.z, -50, 50);

        spots.forEach((spot) => {
          const car = spot.car;
          if (!car) {
            if (gameTime >= spot.respawnAt) spawnCar(spot);
            return;
          }
          car.phaseTime += dt;
          if (car.phase === "arriving") {
            const progress = Math.min(1, car.phaseTime / 2.2);
            const eased = 1 - Math.pow(1 - progress, 3);
            car.group.position.z = THREE.MathUtils.lerp(-43, spot.z, eased);
            if (progress >= 1) {
              car.phase = "parked";
              car.phaseTime = 0;
              car.expireAt = gameTime + 7 + Math.random() * 18;
              car.departAt = gameTime + 30 + Math.random() * 18;
            }
          } else if (car.phase === "parked") {
            if (gameTime >= car.departAt && !car.booted) {
              car.phase = "leaving";
              car.phaseTime = 0;
            }
          } else {
            const progress = Math.min(1, car.phaseTime / 2.4);
            const eased = progress * progress;
            car.group.position.z = THREE.MathUtils.lerp(spot.z, 43, eased);
            if (progress >= 1) removeCar(spot);
          }
          const meterMaterial = spot.meterLight.material as THREE.MeshStandardMaterial;
          const expired = car.expireAt <= gameTime;
          meterMaterial.color.setHex(expired ? 0xff5368 : 0x48d6c8);
          meterMaterial.emissive.setHex(expired ? 0x8e1629 : 0x1a6e63);
          spot.meterLight.scale.setScalar(expired ? 1 + Math.sin(elapsed * 7) * 0.12 : 1);
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

        if (now - lastStatsPush > 150) {
          if (gameTime - lastTicketTime > 12 && combo > 0) combo = 0;
          pushStats();
          lastStatsPush = now;
        }
      } else {
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
      const desiredCamera = new THREE.Vector3(cameraTarget.x + 17, 19, cameraTarget.z + 22);
      camera.position.lerp(desiredCamera, 1 - Math.exp(-3.5 * dt));
      camera.lookAt(cameraTarget.x, 1.3, cameraTarget.z - 1);

      world.rotation.y = gameActiveRef.current ? 0 : Math.sin(elapsed * 0.18) * 0.025;
      renderer.render(scene, camera);
    };
    render();

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      audioContextRef.value?.close();
      actionsRef.current = null;
      startRef.current = null;
      endRef.current = null;
      applyGraphicsRef.current = null;
    };
  }, []);

  const pressControl = useCallback((code: string, pressed: boolean) => {
    if (pressed) keysRef.current.add(code);
    else keysRef.current.delete(code);
  }, []);

  const start = async () => {
    if (starting) return;
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
    setStarting(true);
    shiftSessionRef.current = null;
    try {
      const response = await fetchWithTimeout("/api/scores/session", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Dispatch unavailable");
      const payload = (await response.json()) as { session?: ShiftSession };
      if (
        !payload.session ||
        typeof payload.session.runId !== "string" ||
        typeof payload.session.issuedAt !== "number" ||
        typeof payload.session.token !== "string"
      ) {
        throw new Error("Invalid shift session");
      }
      shiftSessionRef.current = payload.session;
    } catch {
      shiftSessionRef.current = null;
    } finally {
      setStarting(false);
    }
    startRef.current?.();
  };
  const act = (kind: ActionKind) => actionsRef.current?.(kind);

  return (
    <main className={styles.shell} data-screen={screen}>
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
                <b>GLOBAL SCORES</b>
                <small>Saved after each shift</small>
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
              onClick={() => void start()}
              data-testid="start-game"
              disabled={starting}
            >
              {starting ? "Calling dispatch…" : "Help Officer Graham"} <span>→</span>
            </button>
            <p className={styles.shiftNote}>90-second shift · Best score wins</p>
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
                  <strong>Patrol the block</strong>
                  <span>Move with WASD or arrow keys. Hold Shift to run.</span>
                </div>
              </li>
              <li>
                <i>2</i>
                <div>
                  <strong>Watch the meters</strong>
                  <span>Red means expired. Get close and press E to ticket.</span>
                </div>
              </li>
              <li>
                <i>3</i>
                <div>
                  <strong>Catch repeat offenders</strong>
                  <span>Press F to look up a plate. Ticket first, then B to boot.</span>
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

      {screen === "playing" && (
        <>
          <header className={styles.hud}>
            <div className={styles.brandMini}>
              <span className={styles.miniMark}>M</span>
              <div><b>Meter Mayhem</b><small>Downtown patrol</small></div>
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

          <div className={styles.toast} aria-live="polite">{toast}</div>

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
                {context.lookedUp && (
                  <div className={styles.record}>
                    <span>Plate record</span>
                    <strong>{context.priors} prior violation{context.priors === 1 ? "" : "s"}</strong>
                    {context.priors >= 3 && <b>BOOT ELIGIBLE</b>}
                  </div>
                )}
                <div className={styles.actionButtons}>
                  <button onClick={() => act("ticket")} disabled={context.ticketed}>
                    <kbd>E</kbd>{context.ticketed ? "Ticketed" : "Write ticket"}
                  </button>
                  <button onClick={() => act("lookup")}>
                    <kbd>F</kbd>{context.lookedUp ? "Record open" : "Look up plate"}
                  </button>
                  {context.lookedUp && context.priors >= 3 && (
                    <button onClick={() => act("boot")} disabled={context.booted}>
                      <kbd>B</kbd>{context.booted ? "Booted" : "Place boot"}
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
              <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            </div>
            <span>Move · Hold Shift to run</span>
          </div>

          <div className={styles.touchControls} aria-label="Touch controls">
            <div className={styles.touchPad}>
              <button
                aria-label="Move up"
                onPointerDown={() => pressControl("KeyW", true)}
                onPointerUp={() => pressControl("KeyW", false)}
                onPointerCancel={() => pressControl("KeyW", false)}
              >↑</button>
              <button
                aria-label="Move left"
                onPointerDown={() => pressControl("KeyA", true)}
                onPointerUp={() => pressControl("KeyA", false)}
                onPointerCancel={() => pressControl("KeyA", false)}
              >←</button>
              <button
                aria-label="Move down"
                onPointerDown={() => pressControl("KeyS", true)}
                onPointerUp={() => pressControl("KeyS", false)}
                onPointerCancel={() => pressControl("KeyS", false)}
              >↓</button>
              <button
                aria-label="Move right"
                onPointerDown={() => pressControl("KeyD", true)}
                onPointerUp={() => pressControl("KeyD", false)}
                onPointerCancel={() => pressControl("KeyD", false)}
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
              <p className={styles.eyebrow}>SHIFT COMPLETE</p>
              <h1>{resultTitle(result.score)}</h1>
              <p className={styles.resultLead}>The block is safer, the meters are calmer, and your ticket book is considerably lighter.</p>
              <div className={styles.finalScore}>
                <span>{playerName}&apos;s final score</span>
                <strong data-testid="final-score">{result.score.toLocaleString()}</strong>
                {result.score >= result.best && result.score > 0 && <b>NEW BEST!</b>}
              </div>
              <div className={styles.resultStats}>
                <div><strong>{result.tickets}</strong><span>Tickets</span></div>
                <div><strong>{result.boots}</strong><span>Boots</span></div>
                <div><strong>{result.best.toLocaleString()}</strong><span>Local best</span></div>
              </div>
              <div className={styles.scoreStatus} data-kind={scoreStatus.kind} aria-live="polite">
                <span>{scoreStatus.message}</span>
                {scoreStatus.kind === "error" && result.token && (
                  <button onClick={() => void submitScore(result)}>Retry score</button>
                )}
              </div>
              <button
                className={styles.primaryButton}
                onClick={() => void start()}
                data-testid="play-again"
                disabled={starting}
              >
                {starting ? "Calling dispatch…" : "Patrol again"} <span>↻</span>
              </button>
              <button className={styles.textButton} onClick={() => setScreen("home")}>Back to instructions</button>
            </div>

            <aside className={styles.leaderboard} aria-label="Global leaderboard">
              <header>
                <div>
                  <span>Citywide</span>
                  <h2>Top officers</h2>
                </div>
                <b>GLOBAL</b>
              </header>
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
                <p className={styles.boardMessage}>No global scores yet. Take the first spot.</p>
              )}
              <button onClick={() => void refreshScores()}>Refresh scores</button>
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}
