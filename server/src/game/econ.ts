// Loads economy/config.json (the single source of tuning values) with types.
import type { MonsterConfig } from './monsters.ts';
import { readFileSync } from 'node:fs';
import type { PricingConfig, Personality } from '../../../economy/pricing.ts';
import type { TimeConfig } from '../../../economy/time.ts';

export interface ItemDef { name: string; kind: 'currency' | 'raw' | 'crafted'; base: number; needsTool?: boolean; energy?: number; durability?: number }
export interface ToolDef { name: string; use: string; durability: number; make: Cost; makeAlt?: Cost; repair: Cost }
export interface MissionDef { id: string; name: string; hint: string; counter: string; need: number; reward: Cost }
export interface MallItem { id: string; name: string; slot: string; price: number; color: string; color2: string; shape: string }
export interface Recipe { inputs: Record<string, number>; output: string; fee: number; energy?: number }
export interface MerchantDef {
  name: string; shop: string; personality: string;
  buys: string[]; sells: string[]; target: Record<string, number>; crafts: string[];
  startCash: number; startStock: Record<string, number>;
  restore: { coin: number; items: Record<string, number> };
}
export interface SeasonDef { yield: Record<string, number>; demand: Record<string, number>; harvestBonus?: number }

export type Cost = Record<string, number>;
export interface TownhallStep { level: number; cost: Cost; secs: number }
export interface ChunkStep { n: number; th: number; cost: Cost; secs: number }
/** The Town Hall's Lighting project: level 1 lamps on the centre island, level 2 on every open island (homeland.js places them). */
export interface LightStep { level: number; name: string; th: number; cost: Cost; secs: number; covers: 'centre' | 'open' }
export interface BuildingDef { name: string; th: number; cost: Cost; secs: number; produces?: string; perGameHour?: number; capacity?: number; cooks?: string; needsChunk?: boolean; furniture?: Record<string, FurnitureDef>; maxLevel?: number; healGameHours?: number[]; upgrade?: Array<{ cost: Cost; secs: number }>; storeBonus?: number[] }
export interface FurnitureDef { name: string; max: number; names?: string[]; levels: Array<{ cost: Cost; secs: number }> }
export interface ForageDef { items: string[]; perGameHour: number; capacity: number; winterFactor: number }
export interface BotDef { name: string; rarity: string; price: number; max: number; th?: number; effect: { builders?: number; farmGrowFactor?: number; fishRate?: number; woodBonus?: number; chef?: boolean; forage?: ForageDef } }
export interface HomelandConfig {
  builders: number;
  bots: Record<string, BotDef>;
  fatigue: { perJobMinute: number; idleRecoverPerGameHour: number; collapseAt: number; slowdownAt100: number; sickGameHoursWithoutHospital: number };
  cosmetics: Record<string, { name: string; price: number; boost: number; color: string }>;
  motivation: { tukang: number; base: number; perHiburan: number; factorBase: number; factorSpan: number };
  restoran: { pantryMax: number; serveEveryGameHours: number; serveRelief: number; serveMinFatigue: number; chefServeFactor: number };
  publicTradeOnly: boolean;
  /** Fishing, chopping and mining are allowed in the public area even when it is otherwise trade-only (no farming, no monsters). */
  publicGather?: boolean;
  /** Every area of the public village is open from the start, without waiting for its town project. */
  publicOpenAll?: boolean;
  townhall: TownhallStep[];
  chunks: ChunkStep[];
  lighting?: LightStep[];
  buildings: Record<string, BuildingDef>;
}

export interface Econ {
  time: TimeConfig;
  items: Record<string, ItemDef>;
  recipes: Record<string, Recipe>;
  /** Merchants have no energy; they pay this coin fee per crafted unit. */
  craft: { merchantFee: number };
  gather: { tiles: Record<string, string>; charges: number; respawnGameHours: number; energyCost: number; energyMax: number; energyRegenPerHour: number };
  /** Searching grass for a Wheat seed (act `grass`): next to a grass tile, a small chance per try, a few finds a day. The seed is the farm's own token (no new token). */
  grass?: { token: string; tiles: string[]; chance: number; energyCost: number; dailyMax: number; cooldownSecs: number };
  farm: { plots: number; seed: string; growDays: number; harvest: number; noGrowthSeasons: string[]; energyCost: number; villageSeedsPerDay?: number };
  seasons: Record<string, SeasonDef>;
  merchants: Record<string, MerchantDef>;
  personalities: Record<string, Personality>;
  pricing: PricingConfig & { dailyBuyCapPerTarget: number; quoteValidMs: number };
  town: { dailyUnits: Record<string, number>; maxPriceMult: number; faucetW0: number; moneyCap0: number; activePlayerDivisor: number; maxK: number; shippingBoxMult: number };
  shops: { rent: number; storageFeePerUnit: number; dividendShare: number; initialShares: number; minSharePrice: number };
  fees: { marketPct: number };
  starter: Record<string, number>;
  caps: { dailyGainPerItem: number; dailySends: number; maxSendAmount: number };
  /** Admin coin grants from the town treasury (admingrant.ts): the most one grant may send and one admin may send per ledger day. */
  adminGrant?: { maxPerGrant: number; maxPerDay: number };
  /** Town projects; the contract holds the live state (create_project with these values). */
  projects: Array<{ id: string; name: string; chunk: string; need: Record<string, number>; /** why it was stopped: no new pledges, withdrawals still work */ retired?: string }>;
  monsters: MonsterConfig;
  homeland: HomelandConfig;
  trade: { expireSecs: number; maxLines: number; inviteSecs: number; sessionIdleSecs: number; countdownMs: number };
  guest: { max: number; idleSecs: number; helloPerMinute: number; perIp: number; maxMinutes: number };
  party: { max: number; inviteSecs: number; maxPendingInvites: number };
  coop: { partyRoleDefault: 'none' | 'visitor' | 'helper' | 'builder'; guestGatherPerHostDay: number; guestLeavesCharges: number; guestPlotsPerHost: number; assistEnergy: number; assistSecs: number; assistMaxShare: number };
  consign: { merchant: string; feeBps: number; maxPerItem: number; sellPerGameHour: number };
  /** Off-chain equipment with durability (no tokens): the starter kit gives every player one of each. */
  tools: Record<string, ToolDef>;
  /** Entertainment is paid in coin: the carousel ride, and the casino entry that gives a timed pass. */
  fun: { ride: number; rideSecs: number; casino: number; casinoPassMinutes: number };
  /** Casino chips (chips.ts): bought with coin at `perCoin` chips per coin, sold back (bought chips only) minus `sellFeePct`; chips won at the tables can never be sold. Daily limits per account. */
  chips: ChipsConfig;
  missions: MissionDef[];
  mall: { slots: string[]; items: MallItem[] };
}

export interface ChipsConfig {
  perCoin: number; sellFeePct: number; minStake: number; maxStake: number;
  buyMaxCoinPerDay: number; sellMaxChipsPerDay: number; stakeMaxPerDay: number;
  luckWin: number; slot: { weights: number[]; pays: number[] }; cardsEdge: number; cardsMaxSteps: number;
}

export function loadEcon(): Econ {
  return JSON.parse(readFileSync(new URL('../../../economy/config.json', import.meta.url), 'utf8')) as Econ;
}

export const ITEM_IDS = (e: Econ) => Object.keys(e.items).filter((t) => t !== 'coin');
