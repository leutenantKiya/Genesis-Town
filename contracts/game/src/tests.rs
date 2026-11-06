use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{NearToken, testing_env};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId { acc("owner.testnet") }
fn settler() -> AccountId { acc("settler.testnet") }
fn town() -> AccountId { acc("town.testnet") }
fn alice() -> AccountId { acc("alice.testnet") }
fn bob() -> AccountId { acc("bob.testnet") }
fn budi() -> AccountId { acc("budi.testnet") }
const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn ctx(predecessor: AccountId, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("game.testnet"))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_000);
    testing_env!(b.build());
}

fn tokens() -> Vec<TokenMeta> {
    let t = |id: &str, name: &str, kind, base: u128| TokenMeta { token_id: id.into(), name: name.into(), kind, base: U128(base) };
    vec![
        t("coin", "Koin", TokenKind::Currency, 1),
        t("fish", "Ikan", TokenKind::Raw, 8),
        t("ore", "Bijih", TokenKind::Raw, 12),
        t("wood", "Kayu", TokenKind::Raw, 6),
        t("tool", "Alat", TokenKind::Crafted, 45),
    ]
}

fn limits() -> Limits {
    Limits {
        daily_gain_cap: U128(50),
        daily_coin_gain_cap: U128(1000),
        daily_sends: 2,
        max_send_amount: U128(5),
        max_chunk: 10,
        max_players: 10,
        faucet_w0: U128(1200),
        money_cap0: U128(25_000),
        active_divisor: 10,
        max_k: 6,
        rent: U128(40),
        initial_shares: U128(1000),
        max_contributors: 3,
    }
}

fn line(t: &str, n: u128) -> RestoreLine {
    RestoreLine { token_id: t.into(), amount: U128(n) }
}

fn d(a: AccountId, t: &str, n: i128) -> Delta {
    Delta { account_id: a, token_id: t.into(), delta: n.to_string() }
}

fn setup() -> Contract {
    ctx(owner(), 0);
    let mut c = Contract::new(owner(), settler(), town(), tokens(), limits(), U128(5000));
    c.register_merchant(budi(), "Bengkel Budi".into(), vec![line("coin", 200), line("ore", 10), line("wood", 5)], vec![line("coin", 600), line("ore", 15)]);
    ctx(settler(), 0);
    assert!(c.register_player(alice()));
    assert!(c.register_player(bob()));
    c
}

fn settle(c: &mut Contract, day: u64, chunk: u32, entries: Vec<Delta>) {
    ctx(settler(), 0);
    c.settle_day(day, chunk, entries, ROOT.into(), 1);
}

fn bal(c: &Contract, a: AccountId, t: &str) -> u128 {
    c.mt_balance_of(a, t.into()).0
}

/* ------------------------------------------------------------ settlement */

#[test]
fn init_mints_treasury_and_merchant_stock() {
    let c = setup();
    assert_eq!(bal(&c, town(), "coin"), 5000);
    assert_eq!(bal(&c, budi(), "coin"), 600);
    assert_eq!(bal(&c, budi(), "ore"), 15);
    assert_eq!(c.mt_supply("coin".into()).unwrap().0, 5600);
    assert_eq!(c.get_holding(budi(), town()).shares.0, 1000);
}

#[test]
fn settlement_applies_net_deltas_and_stores_root() {
    let mut c = setup();
    // Day 1: starter kit from the treasury, alice gathered 6 fish and sold 4 to budi for 24 coin.
    settle(&mut c, 1, 0, vec![
        d(town(), "coin", -100), d(alice(), "coin", 100 + 24), d(alice(), "fish", 2),
        d(budi(), "fish", 4), d(budi(), "coin", -24),
    ]);
    assert_eq!(bal(&c, alice(), "coin"), 124);
    assert_eq!(bal(&c, alice(), "fish"), 2);
    assert_eq!(bal(&c, budi(), "fish"), 4);
    assert_eq!(bal(&c, budi(), "coin"), 576);
    assert_eq!(c.get_day_root(1).as_deref(), Some(ROOT));
    assert!(c.is_chunk_applied(1, 0));
    assert_eq!(c.mt_supply("coin".into()).unwrap().0, 5600, "coin only moved, none created");
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains(r#""event":"mt_burn""#)));
    assert!(logs.iter().any(|l| l.contains(r#""standard":"genesis-town""#) && l.contains(r#""event":"settle""#)));
}

#[test]
#[should_panic(expected = "chunk already applied")]
fn chunk_applies_once() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)]);
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)]);
}

#[test]
#[should_panic(expected = "ledger_root differs")]
fn day_root_cannot_change() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)]);
    ctx(settler(), 0);
    c.settle_day(1, 1, vec![d(alice(), "fish", 1)], ROOT2.into(), 1);
}

#[test]
#[should_panic(expected = "day already closed")]
fn old_days_cannot_be_settled() {
    let mut c = setup();
    settle(&mut c, 2, 0, vec![d(alice(), "fish", 1)]);
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)]);
}

#[test]
#[should_panic(expected = "only the settler")]
fn only_settler_settles() {
    let mut c = setup();
    ctx(alice(), 0);
    c.settle_day(1, 0, vec![d(alice(), "fish", 10)], ROOT.into(), 1);
}

#[test]
#[should_panic(expected = "not enough fish")]
fn spending_needs_settled_balance() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", -1)]);
}

#[test]
#[should_panic(expected = "daily gain cap reached")]
fn player_gain_cap_per_day() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 30)]);
    settle(&mut c, 1, 1, vec![d(alice(), "fish", 21)]);
}

#[test]
fn gain_cap_resets_next_day_and_does_not_apply_to_merchants() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 50), d(budi(), "fish", 500)]);
    settle(&mut c, 2, 0, vec![d(alice(), "fish", 50)]);
    assert_eq!(bal(&c, alice(), "fish"), 100);
}

#[test]
fn faucet_shrinks_as_supply_grows_and_stops_at_the_cap() {
    let c = setup();
    // supply 5600, k = 1 (1 active player), Mcap = 25000: allowed = 1200 * (25000-5600)/25000 = 931
    assert_eq!(c.faucet_allowed(5600, 1), 931);
    assert!(c.faucet_allowed(20_000, 1) < c.faucet_allowed(5_600, 1));
    assert_eq!(c.faucet_allowed(25_000, 1), 0);
    // k grows with active players (bounded by registered players: 2 here)
    assert_eq!(c.faucet_allowed(5600, 100), c.faucet_allowed(5600, 2));
}

#[test]
#[should_panic(expected = "coin faucet exceeded")]
fn new_coin_beyond_the_faucet_is_refused() {
    let mut c = setup();
    // 931 allowed today (see above); merchants may receive new coin from the town, players are capped separately.
    settle(&mut c, 1, 0, vec![d(budi(), "coin", 900)]);
    settle(&mut c, 1, 1, vec![d(budi(), "coin", 32)]);
}

#[test]
fn coin_moving_between_accounts_is_not_new_money() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(budi(), "coin", -500), d(alice(), "coin", 500)]);
    assert_eq!(c.faucet_status(1, 1).minted_today.0, 0);
}

#[test]
fn faucet_counts_day_net_across_chunks() {
    let mut c = setup();
    c.limits.faucet_w0 = U128(400); // allowed today = 310, below the 498 that moves
    settle(&mut c, 1, 0, vec![d(budi(), "coin", -498)]);
    settle(&mut c, 1, 1, vec![d(alice(), "coin", 498)]);
    assert_eq!(c.faucet_status(1, 1).minted_today.0, 0);
    assert_eq!(bal(&c, budi(), "coin"), 102);
}

#[test]
#[should_panic(expected = "coin faucet exceeded")]
fn faucet_still_caps_real_minting() {
    let mut c = setup();
    c.limits.faucet_w0 = U128(1200);
    settle(&mut c, 1, 0, vec![d(budi(), "coin", 900)]);
    settle(&mut c, 1, 1, vec![d(budi(), "coin", 1100)]);
}

#[test]
fn settle_skips_unregistered_account() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 3), d(acc("ghost.testnet"), "fish", 4)]);
    assert_eq!(bal(&c, alice(), "fish"), 3);
    assert_eq!(bal(&c, acc("ghost.testnet"), "fish"), 0);
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"settle_skip""#) && l.contains("ghost.testnet")));
    assert!(c.is_chunk_applied(1, 0));
}

/* ------------------------------------------------------------ shops */

fn bankrupt_budi(c: &mut Contract) {
    // Budi pays 570 coin to alice for ore over the day, then rent: 600 - 570 - 0 = 30 < 40.
    settle(c, 1, 0, vec![d(budi(), "coin", -570), d(alice(), "coin", 570), d(alice(), "ore", 20), d(alice(), "wood", 10)]);
    ctx(settler(), 0);
    c.close_shop(budi());
}

#[test]
#[should_panic(expected = "shop can still pay rent")]
fn healthy_shop_cannot_be_closed() {
    let mut c = setup();
    ctx(settler(), 0);
    c.close_shop(budi());
}

#[test]
fn restoration_pledges_reopen_the_shop_and_issue_shares() {
    let mut c = setup();
    bankrupt_budi(&mut c);
    assert!(!c.get_shop(budi()).open);

    // Alice pledges 100 coin and 25 ore: only the missing 10 ore are accepted.
    ctx(alice(), 0);
    c.restore_contribute(budi(), vec![line("coin", 100), line("ore", 25)]);
    assert_eq!(bal(&c, alice(), "ore"), 10);
    let shop = c.get_shop(budi());
    assert!(!shop.open);
    assert_eq!(shop.contributors, 1);

    // Bob is registered but has nothing settled; the settler gives him coin first.
    settle(&mut c, 2, 0, vec![d(alice(), "coin", -100), d(bob(), "coin", 100)]);
    ctx(bob(), 0);
    c.restore_contribute(budi(), vec![line("coin", 100)]);
    // Wood still missing.
    assert!(!c.get_shop(budi()).open);
    ctx(alice(), 0);
    c.restore_contribute(budi(), vec![line("wood", 5)]);

    let shop = c.get_shop(budi());
    assert!(shop.open, "board complete -> reopened");
    assert_eq!(bal(&c, budi(), "ore"), 25, "15 left + 10 pledged");
    assert_eq!(bal(&c, budi(), "coin"), 230, "30 left + 200 pledged");
    // Book at close: 30 coin + 15 ore * 12 = 210 for 1000 shares. Alice's pledge was worth 100 + 120 + 30 = 250.
    assert_eq!(c.get_holding(budi(), alice()).shares.0, 250 * 1000 / 210);
    assert_eq!(c.get_holding(budi(), bob()).shares.0, 100 * 1000 / 210);
    assert_eq!(shop.total_shares.0, 1000 + 1190 + 476);
}

#[test]
fn withdrawing_a_pledge_returns_it() {
    let mut c = setup();
    bankrupt_budi(&mut c);
    ctx(alice(), 0);
    c.restore_contribute(budi(), vec![line("coin", 50)]);
    assert_eq!(bal(&c, alice(), "coin"), 520);
    c.restore_withdraw(budi());
    assert_eq!(bal(&c, alice(), "coin"), 570);
    assert_eq!(c.get_shop(budi()).contributors, 0);
}

#[test]
#[should_panic(expected = "shop is open")]
fn cannot_pledge_to_an_open_shop() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "ore", 5)]);
    ctx(alice(), 0);
    c.restore_contribute(budi(), vec![line("ore", 5)]);
}

#[test]
fn dividends_are_paid_pro_rata_and_once_per_day() {
    let mut c = setup();
    bankrupt_budi(&mut c);
    ctx(alice(), 0);
    c.restore_contribute(budi(), vec![line("coin", 200), line("ore", 10), line("wood", 5)]);
    let total = c.get_shop(budi()).total_shares.0;
    let alice_shares = c.get_holding(budi(), alice()).shares.0;
    ctx(settler(), 0);
    c.pay_dividend(budi(), 3, U128(100));
    let expected = 100 * alice_shares / total;
    let claimable = c.get_holding(budi(), alice()).claimable.0;
    assert!(claimable + 1 >= expected && claimable <= expected, "{claimable} vs {expected}");
    let before = bal(&c, alice(), "coin");
    ctx(alice(), 0);
    assert_eq!(c.claim_dividends(budi()).0, claimable);
    assert_eq!(bal(&c, alice(), "coin"), before + claimable);
    assert_eq!(c.claim_dividends(budi()).0, 0, "nothing left to claim");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx(settler(), 0);
        c.pay_dividend(budi(), 3, U128(10));
    }));
    assert!(r.is_err(), "second dividend on the same day must fail");
}

/* ------------------------------------------------------------ player methods and NEP-245 */

#[test]
fn send_item_moves_items_with_daily_limit() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 5)]);
    ctx(alice(), 0);
    c.send_item(bob(), "fish".into(), U128(2));
    c.send_item(bob(), "fish".into(), U128(1));
    assert_eq!(bal(&c, bob(), "fish"), 3);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.send_item(bob(), "fish".into(), U128(1))));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "use the shop")]
fn send_item_to_merchant_rejected() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 5)]);
    ctx(alice(), 0);
    c.send_item(budi(), "fish".into(), U128(1));
}

#[test]
#[should_panic(expected = "coins cannot be sent")]
fn send_item_rejects_coin() {
    let mut c = setup();
    ctx(alice(), 0);
    c.send_item(bob(), "coin".into(), U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn mt_transfer_requires_one_yocto() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)]);
    ctx(alice(), 0);
    c.mt_transfer(bob(), "fish".into(), U128(1), None, None);
}

#[test]
fn mt_transfer_with_one_yocto_and_views() {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 3)]);
    ctx(alice(), 1);
    c.mt_transfer(bob(), "fish".into(), U128(1), None, None);
    assert_eq!(c.mt_batch_balance_of(alice(), vec!["fish".into()])[0].0, 2);
    let t = c.mt_token(vec!["fish".into(), "nope".into()]);
    assert!(t[0].as_ref().unwrap().owner_id.is_none() && t[1].is_none());
}

#[test]
#[should_panic(expected = "only the settler or owner")]
fn players_cannot_register_others() {
    let mut c = setup();
    ctx(alice(), 0);
    c.register_player(acc("carol.testnet"));
}

#[test]
fn pause_blocks_settlement() {
    let mut c = setup();
    ctx(owner(), 0);
    c.set_paused(true);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| settle(&mut c, 1, 0, vec![d(alice(), "fish", 1)])));
    assert!(r.is_err());
}

#[test]
fn storage_deposit_registers() {
    let mut c = setup();
    let min = c.storage_balance_bounds().min.0;
    ctx(acc("wallet.testnet"), min);
    c.storage_deposit(None, None);
    assert!(c.is_registered(acc("wallet.testnet")));
}

/* ------------------------------------------------------------ player market */

fn market_setup() -> Contract {
    let mut c = setup();
    settle(&mut c, 1, 0, vec![d(alice(), "fish", 20), d(bob(), "coin", 500), d(town(), "coin", -500)]);
    c
}

#[test]
fn list_and_buy_moves_goods_and_burns_the_fee() {
    let mut c = market_setup();
    ctx(alice(), 0);
    let id = c.list_item("fish".into(), U128(10), U128(8));
    assert_eq!(bal(&c, alice(), "fish"), 10, "escrowed");
    let supply_before = c.mt_supply("coin".into()).unwrap().0;
    ctx(bob(), 0);
    c.buy_listing(id, U128(4), U128(8));
    assert_eq!(bal(&c, bob(), "fish"), 4);
    assert_eq!(bal(&c, bob(), "coin"), 500 - 32);
    assert_eq!(bal(&c, alice(), "coin"), 32 - 1, "5% of 32 = 1 coin burned (integer)");
    assert_eq!(c.mt_supply("coin".into()).unwrap().0, supply_before - 1);
    assert_eq!(c.get_listing(id).unwrap().amount.0, 6);
    c.buy_listing(id, U128(6), U128(8));
    assert!(c.get_listing(id).is_none(), "sold out listings close");
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"market""#)));
}

#[test]
#[should_panic(expected = "price is above your limit")]
fn buyer_price_guard() {
    let mut c = market_setup();
    ctx(alice(), 0);
    let id = c.list_item("fish".into(), U128(1), U128(9));
    ctx(bob(), 0);
    c.buy_listing(id, U128(1), U128(8));
}

#[test]
#[should_panic(expected = "cannot buy your own listing")]
fn no_self_buys() {
    let mut c = market_setup();
    ctx(alice(), 0);
    let id = c.list_item("fish".into(), U128(1), U128(1));
    c.buy_listing(id, U128(1), U128(1));
}

#[test]
fn cancel_returns_escrow_and_only_seller_may_cancel() {
    let mut c = market_setup();
    ctx(alice(), 0);
    let id = c.list_item("fish".into(), U128(5), U128(3));
    ctx(bob(), 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { ctx(bob(), 0); c.cancel_listing(id); }));
    assert!(r.is_err());
    ctx(alice(), 0);
    c.cancel_listing(id);
    assert_eq!(bal(&c, alice(), "fish"), 20);
    assert!(c.list_listings(None).is_empty());
}

#[test]
#[should_panic(expected = "at most 5 open listings")]
fn open_listings_are_capped() {
    let mut c = market_setup();
    ctx(alice(), 0);
    for _ in 0..6 { c.list_item("fish".into(), U128(1), U128(1)); }
}

#[test]
#[should_panic(expected = "coin cannot be listed")]
fn coin_cannot_be_listed() {
    let mut c = market_setup();
    ctx(bob(), 0);
    c.list_item("coin".into(), U128(1), U128(1));
}

/* ------------------------------------------------------------------ town projects (v4) */

fn project_setup() -> Contract {
    let mut c = market_setup();
    ctx(owner(), 0);
    c.create_project("jembatan-timur".into(), "Jembatan ke Dusun Seberang".into(), "seberang".into(), vec![line("fish", 6), line("coin", 50)]);
    c
}

#[test]
fn project_takes_only_what_it_needs_and_burns_the_pledges_when_built() {
    let mut c = project_setup();
    let fish0 = c.mt_supply("fish".into()).unwrap().0;
    let coin0 = c.mt_supply("coin".into()).unwrap().0;
    ctx(alice(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("fish", 4)]);
    assert_eq!(bal(&c, alice(), "fish"), 16);
    ctx(bob(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("coin", 80)]);
    assert_eq!(bal(&c, bob(), "coin"), 450, "only the 50 still needed");
    let p = c.get_project("jembatan-timur".into()).unwrap();
    assert!(!p.done);
    ctx(alice(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("fish", 5)]);
    let p = c.get_project("jembatan-timur".into()).unwrap();
    assert!(p.done, "all lines met");
    assert_eq!(bal(&c, alice(), "fish"), 14);
    assert_eq!(p.contributors.len(), 2);
    assert_eq!(c.mt_supply("fish".into()).unwrap().0, fish0 - 6, "built: goods burned");
    assert_eq!(c.mt_supply("coin".into()).unwrap().0, coin0 - 50);
    assert_eq!(bal(&c, acc("game.testnet"), "fish"), 0, "nothing left in escrow");
    assert!(get_logs().iter().any(|l| l.contains(r#""what":"done""#)));
}

#[test]
fn project_pledge_can_be_withdrawn_before_it_is_done() {
    let mut c = project_setup();
    ctx(alice(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("fish", 3)]);
    c.project_withdraw("jembatan-timur".into());
    assert_eq!(bal(&c, alice(), "fish"), 20);
    assert!(c.get_project("jembatan-timur".into()).unwrap().pledged.iter().all(|l| l.amount.0 == 0));
}

#[test]
#[should_panic(expected = "not enough fish")]
fn pledging_more_than_you_hold_fails_whole() {
    let mut c = project_setup();
    ctx(bob(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("fish", 2)]);
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_owner_creates_projects() {
    let mut c = market_setup();
    ctx(alice(), 0);
    c.create_project("x".into(), "X".into(), "y".into(), vec![line("fish", 1)]);
}

#[test]
#[should_panic(expected = "project is already done")]
fn done_projects_take_nothing() {
    let mut c = project_setup();
    ctx(alice(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("fish", 6)]);
    ctx(bob(), 0);
    c.project_contribute("jembatan-timur".into(), vec![line("coin", 50)]);
    c.project_contribute("jembatan-timur".into(), vec![line("coin", 1)]);
}

/* ------------------------------------------------------------------ islands (v5) */

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::{CurveType, PublicKey};

fn makelar() -> AccountId { acc("makelar.testnet") }
const EXPIRES: u64 = 10_000;

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}
fn voucher_pk() -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, signing_key().verifying_key().to_bytes().to_vec()).unwrap()
}
fn sign(msg: &str) -> Base64VecU8 {
    Base64VecU8(signing_key().sign(msg.as_bytes()).to_bytes().to_vec())
}
fn spec(size: u8, fert: u8) -> IslandSpec {
    IslandSpec { seed: 7101, size_level: size, fertility_level: fert }
}
fn buy_msg(id: u32, buyer: &AccountId, price: u128, s: &IslandSpec, exp: u64) -> String {
    format!("GT-ISLAND-BUY|game.testnet|{id}|{buyer}|{price}|{}|{}|{}|{exp}", s.seed, s.size_level, s.fertility_level)
}
fn save_msg(id: u32, owner: &AccountId, from: u32, s: &IslandSpec, exp: u64) -> String {
    format!("GT-ISLAND-SAVE|game.testnet|{id}|{owner}|{from}|{}|{}|{}|{exp}", s.seed, s.size_level, s.fertility_level)
}

/// bob holds 500 coin, the broker is registered, the voucher key is set.
fn island_setup() -> Contract {
    let mut c = market_setup();
    ctx(owner(), 0);
    c.set_broker(makelar());
    c.set_voucher_key(voucher_pk());
    c
}

fn buy(c: &mut Contract, who: AccountId, id: u32, price: u128) {
    let s = spec(1, 1);
    let sig = sign(&buy_msg(id, &who, price, &s, EXPIRES));
    ctx(who, 0);
    c.buy_island(id, s, U128(price), U64(EXPIRES), sig);
}

fn save(c: &mut Contract, who: AccountId, id: u32, from: u32, s: IslandSpec) {
    let sig = sign(&save_msg(id, &who, from, &s, EXPIRES));
    ctx(who, 0);
    c.save_island(id, from, s, U64(EXPIRES), sig);
}

#[test]
fn buy_island_mints_via_broker_and_burns_price() {
    let mut c = island_setup();
    let coin0 = c.mt_supply("coin".into()).unwrap().0;
    buy(&mut c, bob(), 1, 300);
    assert_eq!(bal(&c, bob(), "IS-1-1"), 1);
    assert_eq!(bal(&c, makelar(), "IS-1-1"), 0);
    assert_eq!(bal(&c, bob(), "coin"), 200);
    assert_eq!(bal(&c, makelar(), "coin"), 0, "price burned from the broker");
    assert_eq!(c.mt_supply("coin".into()).unwrap().0, coin0 - 300);
    assert_eq!(c.mt_supply("IS-1-1".into()).unwrap().0, 1);
    let v = c.get_island(1).unwrap();
    assert_eq!((v.owner_id, v.version, v.token_id.as_str(), v.spec), (bob(), 1, "IS-1-1", spec(1, 1)));
    assert_eq!(c.mt_token(vec!["IS-1-1".into()])[0].as_ref().unwrap().owner_id, Some(bob()));
    let logs = get_logs().join("\n");
    assert!(logs.contains(r#""event":"mt_mint""#) && logs.contains(r#""event":"mt_burn""#) && logs.contains(r#""event":"mt_transfer""#));
    assert!(logs.contains(r#""standard":"genesis-town""#) && logs.contains(r#""event":"island""#) && logs.contains(r#""what":"bought""#));
}

#[test]
#[should_panic(expected = "island already sold")]
fn buy_island_rejects_reused_voucher() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    buy(&mut c, bob(), 1, 100);
}

#[test]
#[should_panic(expected = "bad voucher signature")]
fn buy_island_rejects_wrong_signer() {
    let mut c = island_setup();
    let s = spec(1, 1);
    let other = SigningKey::from_bytes(&[8u8; 32]);
    let sig = Base64VecU8(other.sign(buy_msg(1, &bob(), 100, &s, EXPIRES).as_bytes()).to_bytes().to_vec());
    ctx(bob(), 0);
    c.buy_island(1, s, U128(100), U64(EXPIRES), sig);
}

#[test]
#[should_panic(expected = "voucher expired")]
fn buy_island_rejects_expired() {
    let mut c = island_setup();
    let s = spec(1, 1);
    let sig = sign(&buy_msg(1, &bob(), 100, &s, 999));
    ctx(bob(), 0); // block timestamp is 1_000
    c.buy_island(1, s, U128(100), U64(999), sig);
}

#[test]
#[should_panic(expected = "bad voucher signature")]
fn buy_island_rejects_other_buyer_voucher() {
    let mut c = island_setup();
    let s = spec(1, 1);
    let sig = sign(&buy_msg(1, &bob(), 100, &s, EXPIRES)); // issued for bob
    ctx(alice(), 0);
    c.buy_island(1, s, U128(100), U64(EXPIRES), sig);
}

#[test]
#[should_panic(expected = "bad voucher signature")]
fn buy_island_rejects_changed_spec() {
    let mut c = island_setup();
    let s = spec(1, 1);
    let sig = sign(&buy_msg(1, &bob(), 100, &s, EXPIRES));
    ctx(bob(), 0);
    c.buy_island(1, spec(3, 5), U128(100), U64(EXPIRES), sig);
}

#[test]
#[should_panic(expected = "not enough coin")]
fn buy_island_needs_the_coin() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 501);
}

#[test]
fn save_island_swaps_version() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    save(&mut c, bob(), 1, 1, spec(1, 2));
    assert_eq!(bal(&c, bob(), "IS-1-1"), 0);
    assert_eq!(c.mt_supply("IS-1-1".into()).unwrap().0, 0);
    assert_eq!(bal(&c, bob(), "IS-1-2"), 1);
    assert_eq!(c.mt_supply("IS-1-2".into()).unwrap().0, 1);
    let v = c.get_island(1).unwrap();
    assert_eq!((v.version, v.spec, v.token_id.as_str()), (2, spec(1, 2), "IS-1-2"));
    assert!(get_logs().join("\n").contains(r#""what":"saved""#));
}

#[test]
#[should_panic(expected = "stale island version")]
fn save_island_rejects_stale_version() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    save(&mut c, bob(), 1, 1, spec(1, 2));
    save(&mut c, bob(), 1, 1, spec(1, 3));
}

#[test]
#[should_panic(expected = "upgrades cannot be lowered")]
fn save_island_rejects_downgrade() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    save(&mut c, bob(), 1, 1, spec(1, 2));
    save(&mut c, bob(), 1, 2, spec(1, 1));
}

#[test]
#[should_panic(expected = "only the island owner")]
fn save_island_only_by_owner() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    save(&mut c, alice(), 1, 1, spec(1, 2));
}

#[test]
fn island_owner_follows_transfers() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    ctx(bob(), 1);
    c.mt_transfer(alice(), "IS-1-1".into(), U128(1), None, None);
    assert_eq!(c.get_island(1).unwrap().owner_id, alice());
    save(&mut c, alice(), 1, 1, spec(1, 2));
    assert_eq!(bal(&c, alice(), "IS-1-2"), 1);
}

#[test]
#[should_panic(expected = "island owners cannot unregister")]
fn unregister_refused_while_owning_island() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    ctx(bob(), 1);
    c.storage_unregister(None);
}

#[test]
fn unregister_allowed_after_island_transferred() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    ctx(bob(), 1);
    c.mt_transfer(alice(), "IS-1-1".into(), U128(1), None, None);
    let rest = bal(&c, bob(), COIN);
    if rest > 0 {
        ctx(bob(), 1);
        c.mt_transfer(alice(), COIN.into(), U128(rest), None, None);
    }
    ctx(bob(), 1);
    assert!(c.storage_unregister(None));
}

#[test]
#[should_panic(expected = "unknown token IS-1-1")]
fn old_version_not_transferable() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    save(&mut c, bob(), 1, 1, spec(1, 2));
    ctx(bob(), 1);
    c.mt_transfer(alice(), "IS-1-1".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "unknown token IS-1-1")]
fn settle_cannot_touch_islands() {
    let mut c = island_setup();
    buy(&mut c, bob(), 1, 100);
    settle(&mut c, 2, 0, vec![d(bob(), "IS-1-1", -1), d(alice(), "IS-1-1", 1)]);
}

#[test]
#[should_panic(expected = "unknown token IS-9-1")]
fn settle_cannot_mint_islands() {
    let mut c = island_setup();
    settle(&mut c, 2, 0, vec![d(alice(), "IS-9-1", 1)]);
}

#[test]
fn migrate_from_v4_keeps_state() {
    let mut old = project_setup();
    ctx(alice(), 0);
    let listing = old.list_item("fish".into(), U128(5), U128(8));
    // flush cached writes, then store the v4 layout exactly as the deployed contract has it
    old.balances.flush();
    old.supply.flush();
    old.listings.flush();
    old.projects.flush();
    old.shops.flush();
    old.shares.flush();
    old.open_listings.flush();
    let v4 = islands::ContractV4 {
        owner_id: old.owner_id, settler_id: old.settler_id, town_id: old.town_id, paused: old.paused, tokens: old.tokens, limits: old.limits,
        balances: old.balances, supply: old.supply, registered: old.registered, registered_count: old.registered_count, applied: old.applied,
        roots: old.roots, last_settled_day: old.last_settled_day, gain_caps: old.gain_caps, day_faucet: old.day_faucet, send_caps: old.send_caps,
        storage_paid: old.storage_paid, merchants: old.merchants, shops: old.shops, shares: old.shares, dividends_paid: old.dividends_paid,
        listings: old.listings, next_listing_id: old.next_listing_id, open_listings: old.open_listings, market_fee_bps: old.market_fee_bps,
        projects: old.projects, project_ids: old.project_ids,
    };
    env::state_write(&v4);
    let new_tokens = vec![
        TokenMeta { token_id: "emas".into(), name: "Emas".into(), kind: TokenKind::Raw, base: U128(40) },
        TokenMeta { token_id: "permata".into(), name: "Permata".into(), kind: TokenKind::Raw, base: U128(120) },
    ];
    let c = Contract::migrate(makelar(), voucher_pk(), new_tokens);
    assert_eq!(bal(&c, bob(), "coin"), 500);
    assert_eq!(bal(&c, alice(), "fish"), 15);
    assert_eq!(c.get_listing(listing).unwrap().amount.0, 5);
    assert_eq!(c.list_projects().len(), 1);
    assert_eq!(c.get_config().tokens.len(), 7);
    assert!(c.get_config().tokens.iter().any(|t| t.token_id == "permata"));
    assert!(c.is_registered(makelar()));
    assert!(c.get_island(1).is_none());
    assert_eq!(c.broker_id, makelar());
    assert_eq!(c.voucher_pk.len(), 32);
}
