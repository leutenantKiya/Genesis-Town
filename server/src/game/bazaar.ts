// The two sides of the player market (on top of the contract's escrowed listings):
// - Lapak: the seller's name shows, and every unit sold earns them popularity (a ranking and a title).
// - Pasar Gelap: the seller stays anonymous in the game and earns no popularity. No shop is needed for either.
// The choice is the seller's, made when listing, and kept here (the contract has no field for it). Anonymous means
// hidden inside the game only: listings and sales are public on chain, and the UI says so.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ListingInfo } from '../chain.ts';

export const TITLES: Array<[number, string]> = [[100, 'Market Legend'], [30, 'Famous'], [10, 'Known'], [1, 'Merchant'], [0, 'New merchant']];
export function titleFor(points: number) { return (TITLES.find(([p]) => points >= p) ?? TITLES[TITLES.length - 1])[1]; }
/** A tag that lets a seller's own browser recognise its anonymous listings without revealing the account to others. */
export function sellerTag(account: string) { return createHash('sha256').update('gt-seller:' + account).digest('hex').slice(0, 16); }

export class Bazaar {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS listing_side (listing_id INTEGER PRIMARY KEY, seller TEXT NOT NULL, anonymous INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS popularity (account TEXT PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0, sales INTEGER NOT NULL DEFAULT 0);
    `);
  }
  isAnonymous(id: number) { return !!(this.db.prepare('SELECT anonymous FROM listing_side WHERE listing_id = ?').get(id) as { anonymous: number } | undefined)?.anonymous; }
  known(id: number) { return !!this.db.prepare('SELECT 1 FROM listing_side WHERE listing_id = ?').get(id); }
  /** After a list_item relay: find the new listing (the seller's newest unknown one with these terms) and record the side. */
  recordListing(listings: ListingInfo[], seller: string, args: Record<string, unknown>, anonymous: boolean) {
    const l = listings.filter((x) => x.seller === seller && x.token_id === args.token_id && String(x.amount) === String(args.amount) && String(x.price_each) === String(args.price_each) && !this.known(x.id)).sort((a, b) => b.id - a.id)[0];
    if (!l) return null;
    this.db.prepare('INSERT OR IGNORE INTO listing_side (listing_id, seller, anonymous, created_at) VALUES (?, ?, ?, ?)').run(l.id, seller, anonymous ? 1 : 0, Date.now());
    return l.id;
  }
  /** After a buy_listing relay: a named listing earns its seller one point per unit sold. */
  recordSale(listingId: number, seller: string, units: number) {
    if (this.isAnonymous(listingId) || !(units > 0)) return 0;
    this.db.prepare('INSERT INTO popularity (account, points, sales) VALUES (?, ?, 1) ON CONFLICT(account) DO UPDATE SET points = points + excluded.points, sales = sales + 1').run(seller, units);
    return units;
  }
  points(account: string) { return (this.db.prepare('SELECT points FROM popularity WHERE account = ?').get(account) as { points: number } | undefined)?.points ?? 0; }
  top(n = 10) {
    return (this.db.prepare('SELECT account, points, sales FROM popularity ORDER BY points DESC, sales DESC LIMIT ?').all(n) as Array<{ account: string; points: number; sales: number }>)
      .map((r) => ({ ...r, title: titleFor(r.points) }));
  }
  /** What the game shows: anonymous sellers are replaced by a tag only their own browser can match. */
  view(listings: ListingInfo[]) {
    return listings.map((l) => {
      const anon = this.isAnonymous(l.id);
      return anon ? { ...l, seller: null, anonymous: true, sellerTag: sellerTag(l.seller) } : { ...l, anonymous: false, popularity: this.points(l.seller), title: titleFor(this.points(l.seller)) };
    });
  }
}
