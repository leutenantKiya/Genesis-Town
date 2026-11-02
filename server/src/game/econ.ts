// Loads economy/config.json (the single source of tuning values) with types.
import { readFileSync } from 'node:fs';
import type { PricingConfig, Personality } from '../../../economy/pricing.ts';
import type { TimeConfig } from '../../../economy/time.ts';

export interface ItemDef { name: string; kind: 'currency' | 'raw' | 'crafted'; base: number; needsTool?: boolean; energy?: number; durability?: number }
export interface Recipe { inputs: Record<string, number>; output: string; fee: number }
export interface MerchantDef {
  name: string; shop: string; personality: string;
  buys: string[]; sells: string[]; target: Record<string, number>; crafts: string[];
  startCash: number; startStock: Record<string, number>;
  restore: { coin: number; items: Record<string, number> };
}
export interface SeasonDef { yield: Record<string, number>; demand: Record<string, number>; harvestBonus?: number }

export interface Econ {
  time: TimeConfig;
  items: Record<string, ItemDef>;
  recipes: Record<string, Recipe>;
  gather: { tiles: Record<string, string>; charges: number; respawnGameHours: number; energyCost: number; energyMax: number; energyRegenPerHour: number };
  farm: { plots: number; seed: string; growDays: number; harvest: number; noGrowthSeasons: string[]; energyCost: number };
  seasons: Record<string, SeasonDef>;
  merchants: Record<string, MerchantDef>;
  personalities: Record<string, Personality>;
  pricing: PricingConfig & { dailyBuyCapPerTarget: number; quoteValidMs: number };
  town: { dailyUnits: Record<string, number>; maxPriceMult: number; faucetW0: number; moneyCap0: number; activePlayerDivisor: number; maxK: number; shippingBoxMult: number };
  shops: { rent: number; storageFeePerUnit: number; dividendShare: number; initialShares: number; minSharePrice: number };
  fees: { marketPct: number };
  starter: Record<string, number>;
  caps: { dailyGainPerItem: number; dailySends: number; maxSendAmount: number };
  /** Town projects; the contract holds the live state (create_project with these values). */
  projects: Array<{ id: string; name: string; chunk: string; need: Record<string, number> }>;
}

export function loadEcon(): Econ {
  return JSON.parse(readFileSync(new URL('../../../economy/config.json', import.meta.url), 'utf8')) as Econ;
}

export const ITEM_IDS = (e: Econ) => Object.keys(e.items).filter((t) => t !== 'coin');
