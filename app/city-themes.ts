export const CITY_IDS = ["port-alder", "ironlake", "juniper-ridge"] as const;

export type CityId = (typeof CITY_IDS)[number];

export type CityTheme = {
  id: CityId;
  name: string;
  description: string;
  palette: {
    sky: number;
    fog: number;
    hemisphereSky: number;
    hemisphereGround: number;
    sunlight: number;
    ground: number;
    road: number;
    sidewalk: number;
    stripe: number;
    plaza: number;
    fountainStone: number;
    fountainWater: number;
    fountainGlow: number;
    window: number;
    windowGlow: number;
    cloud: number;
    mote: number;
    treeTrunk: number;
    lampPole: number;
    lampBulb: number;
    lampGlow: number;
    buildings: readonly number[];
    accents: readonly number[];
    trees: readonly number[];
    cars: readonly number[];
    uiAccent: number;
    uiDeep: number;
    uiHighlight: number;
  };
};

export const CITY_THEMES: readonly CityTheme[] = [
  {
    id: "port-alder",
    name: "Port Alder",
    description: "Brick, harbor blue, and autumn color",
    palette: {
      sky: 0x92c9dc,
      fog: 0xb8d8df,
      hemisphereSky: 0xffe6c2,
      hemisphereGround: 0x657c91,
      sunlight: 0xffd9a3,
      ground: 0x77945d,
      road: 0x4c5962,
      sidewalk: 0xc8a581,
      stripe: 0xf5dfab,
      plaza: 0xcdb79e,
      fountainStone: 0xd7d0c2,
      fountainWater: 0x4f9fb2,
      fountainGlow: 0x236f82,
      window: 0xffedc9,
      windowGlow: 0xd99b57,
      cloud: 0xf5eee4,
      mote: 0xf1bf65,
      treeTrunk: 0x6e4932,
      lampPole: 0x263a43,
      lampBulb: 0xffd48a,
      lampGlow: 0xd98743,
      buildings: [0x8e453b, 0xb45f45, 0xd0a77c, 0x687a85, 0x9f5948],
      accents: [0xe8d7b9, 0x315f73, 0xc98555, 0x586c4b],
      trees: [0x8d9b45, 0xb16b3c, 0xc49542, 0x647b46],
      cars: [0x9f403f, 0x2e7686, 0xd29b49, 0x5c7187, 0x6d8751, 0xe4d2ae],
      uiAccent: 0xc86546,
      uiDeep: 0x263f4b,
      uiHighlight: 0xf2c46d,
    },
  },
  {
    id: "ironlake",
    name: "Ironlake",
    description: "Steel, lake teal, and warm copper",
    palette: {
      sky: 0x79b8d1,
      fog: 0x9fc9d5,
      hemisphereSky: 0xddebf0,
      hemisphereGround: 0x53677a,
      sunlight: 0xffe4b8,
      ground: 0x6f8b72,
      road: 0x3f4d5a,
      sidewalk: 0xb8ad98,
      stripe: 0xeedb9b,
      plaza: 0xb9b2a5,
      fountainStone: 0xcbd1d1,
      fountainWater: 0x3b9cad,
      fountainGlow: 0x176f7c,
      window: 0xd8f2f4,
      windowGlow: 0x58b6bf,
      cloud: 0xe7eef0,
      mote: 0xc7d7d6,
      treeTrunk: 0x5f4738,
      lampPole: 0x23323b,
      lampBulb: 0xffd681,
      lampGlow: 0xd59034,
      buildings: [0x405b70, 0x697984, 0x8a8172, 0x315363, 0x9f684d],
      accents: [0xd7d3c5, 0xb87c43, 0x4f9899, 0x283d4e],
      trees: [0x55765f, 0x698968, 0x3f6c62, 0x7e8d57],
      cars: [0x315f73, 0xa95d44, 0x5d7181, 0xd39b4f, 0x45888a, 0xd7d1bd],
      uiAccent: 0xb76d45,
      uiDeep: 0x273b4b,
      uiHighlight: 0x56a8a6,
    },
  },
  {
    id: "juniper-ridge",
    name: "Juniper Ridge",
    description: "Terracotta, alpine green, and clear cobalt",
    palette: {
      sky: 0x72c8ed,
      fog: 0xa9d7e4,
      hemisphereSky: 0xffedc5,
      hemisphereGround: 0x71806b,
      sunlight: 0xffd58f,
      ground: 0x7f9b5c,
      road: 0x596069,
      sidewalk: 0xd1ad7c,
      stripe: 0xffe2a1,
      plaza: 0xd7bb8b,
      fountainStone: 0xd9cbb7,
      fountainWater: 0x3ca6bd,
      fountainGlow: 0x187f94,
      window: 0xe8f5ef,
      windowGlow: 0x62b8b1,
      cloud: 0xfff5e2,
      mote: 0xffcf78,
      treeTrunk: 0x714c32,
      lampPole: 0x34434b,
      lampBulb: 0xffda86,
      lampGlow: 0xe09236,
      buildings: [0xc15f3e, 0xd3894b, 0x879676, 0xd1aa69, 0x537993],
      accents: [0xf0d3a1, 0x2f8e91, 0xf5eee0, 0x617c51],
      trees: [0x416d4f, 0x587c52, 0x718d4d, 0x355f4a],
      cars: [0xbe593f, 0x357e93, 0xd89847, 0x637c53, 0x6b70a1, 0xead6ad],
      uiAccent: 0xc35f3f,
      uiDeep: 0x34536a,
      uiHighlight: 0xe5a54f,
    },
  },
] as const;

export const DEFAULT_CITY_ID: CityId = "port-alder";

export const CITY_THEME_BY_ID = Object.fromEntries(
  CITY_THEMES.map((city) => [city.id, city]),
) as Record<CityId, CityTheme>;

export function isCityId(value: unknown): value is CityId {
  return typeof value === "string" && CITY_IDS.includes(value as CityId);
}

export function colorToCss(color: number) {
  return `#${color.toString(16).padStart(6, "0")}`;
}
