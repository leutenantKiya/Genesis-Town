use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{NearToken, testing_env};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId { acc("owner.testnet") }
fn minter() -> AccountId { acc("minter.testnet") }
fn alice() -> AccountId { acc("alice.testnet") }
fn bob() -> AccountId { acc("bob.testnet") }

fn ctx(predecessor: AccountId, deposit: u128, day: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("game.testnet"))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(day * NANOS_PER_DAY + 1_000);
    testing_env!(b.build());
}

fn tokens() -> Vec<TokenMeta> {
    let t = |id: &str, name: &str, kind| TokenMeta { token_id: id.into(), name: name.into(), kind };
    vec![
        t("coin", "Koin", TokenKind::Currency),
        t("fish", "Ikan", TokenKind::Raw),
        t("ore", "Bijih", TokenKind::Raw),
        t("bread", "Roti", TokenKind::Crafted),
    ]
}

fn limits() -> Limits {
    Limits { daily_gather_cap: U128(10), daily_sends: 2, max_send_amount: U128(5), max_batch: 5, max_players: 3 }
}

fn setup() -> Contract {
    ctx(owner(), 0, 1);
    let mut c = Contract::new(owner(), minter(), acc("town.testnet"), tokens(), limits());
    ctx(minter(), 0, 1);
    assert!(c.register_player(alice()));
    assert!(c.register_player(bob()));
    c
}

fn mint(c: &mut Contract, who: AccountId, token: &str, n: u128, id: &str) {
    ctx(minter(), 0, 1);
    c.mint_gathered(vec![MintEntry { account_id: who, token_id: token.into(), amount: U128(n) }], id.into());
}

#[test]
fn minter_mints_and_emits_nep245_event() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 3, "m1");
    assert_eq!(c.mt_balance_of(alice(), "fish".into()).0, 3);
    assert_eq!(c.mt_supply("fish".into()).unwrap().0, 3);
    let logs = get_logs();
    assert!(logs[0].starts_with("EVENT_JSON:"), "{logs:?}");
    assert!(logs[0].contains(r#""standard":"nep245""#) && logs[0].contains(r#""event":"mt_mint""#) && logs[0].contains(r#""memo":"m1""#));
    assert!(c.is_mint_id_used("m1".into()));
}

#[test]
#[should_panic(expected = "only the minter")]
fn non_minter_cannot_mint() {
    let mut c = setup();
    ctx(alice(), 0, 1);
    c.mint_gathered(vec![MintEntry { account_id: alice(), token_id: "fish".into(), amount: U128(1) }], "x".into());
}

#[test]
#[should_panic(expected = "mint_id already used")]
fn mint_id_is_single_use() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 1, "same");
    mint(&mut c, alice(), "fish", 1, "same");
}

#[test]
#[should_panic(expected = "cannot be gathered")]
fn coin_cannot_be_minted_by_gathering() {
    let mut c = setup();
    mint(&mut c, alice(), "coin", 100, "c1");
}

#[test]
#[should_panic(expected = "cannot be gathered")]
fn crafted_items_cannot_be_minted_by_gathering() {
    let mut c = setup();
    mint(&mut c, alice(), "bread", 1, "b1");
}

#[test]
#[should_panic(expected = "is not registered")]
fn mint_to_unregistered_fails() {
    let mut c = setup();
    mint(&mut c, acc("stranger.testnet"), "fish", 1, "s1");
}

#[test]
fn daily_gather_cap_resets_next_day() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 10, "a");
    assert_eq!(c.gather_allowance(alice(), "fish".into()).0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| mint(&mut c, alice(), "fish", 1, "b")));
    assert!(r.is_err(), "11th fish on the same day must fail");
    ctx(minter(), 0, 2);
    c.mint_gathered(vec![MintEntry { account_id: alice(), token_id: "fish".into(), amount: U128(10) }], "c".into());
    assert_eq!(c.mt_balance_of(alice(), "fish".into()).0, 20);
}

#[test]
fn send_item_moves_items_and_counts_per_day() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 5, "m");
    ctx(alice(), 0, 1);
    c.send_item(bob(), "fish".into(), U128(2));
    c.send_item(bob(), "fish".into(), U128(1));
    assert_eq!(c.mt_batch_balance_of(alice(), vec!["fish".into()])[0].0, 2);
    assert_eq!(c.mt_balance_of(bob(), "fish".into()).0, 3);
    assert_eq!(c.mt_supply("fish".into()).unwrap().0, 5, "transfers never change supply");
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.send_item(bob(), "fish".into(), U128(1))));
    assert!(r.is_err(), "third send in a day must fail");
    ctx(alice(), 0, 2);
    c.send_item(bob(), "fish".into(), U128(1));
}

#[test]
#[should_panic(expected = "coins cannot be sent")]
fn send_item_rejects_coin() {
    let mut c = setup();
    ctx(alice(), 0, 1);
    c.send_item(bob(), "coin".into(), U128(1));
}

#[test]
#[should_panic(expected = "amount out of range")]
fn send_item_caps_amount() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 10, "m");
    ctx(alice(), 0, 1);
    c.send_item(bob(), "fish".into(), U128(6));
}

#[test]
#[should_panic(expected = "not enough fish")]
fn send_item_needs_balance() {
    let mut c = setup();
    ctx(alice(), 0, 1);
    c.send_item(bob(), "fish".into(), U128(1));
}

#[test]
#[should_panic(expected = "is not registered")]
fn send_item_to_unregistered_fails() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 1, "m");
    ctx(alice(), 0, 1);
    c.send_item(acc("stranger.testnet"), "fish".into(), U128(1));
}

#[test]
#[should_panic(expected = "sender and receiver must differ")]
fn send_to_self_fails() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 1, "m");
    ctx(alice(), 0, 1);
    c.send_item(alice(), "fish".into(), U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn mt_transfer_requires_one_yocto() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 1, "m");
    ctx(alice(), 0, 1);
    c.mt_transfer(bob(), "fish".into(), U128(1), None, None);
}

#[test]
fn mt_transfer_and_batch_with_one_yocto() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 3, "m1");
    mint(&mut c, alice(), "ore", 2, "m2");
    ctx(alice(), 1, 1);
    c.mt_transfer(bob(), "fish".into(), U128(1), None, Some("hi".into()));
    c.mt_batch_transfer(bob(), vec!["fish".into(), "ore".into()], vec![U128(2), U128(2)], None, None);
    assert_eq!(c.mt_batch_balance_of(bob(), vec!["fish".into(), "ore".into()]).iter().map(|x| x.0).collect::<Vec<_>>(), vec![3, 2]);
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"mt_transfer""#)));
}

#[test]
#[should_panic(expected = "approval management is not supported")]
fn approvals_are_rejected() {
    let mut c = setup();
    mint(&mut c, alice(), "fish", 1, "m");
    ctx(alice(), 1, 1);
    c.mt_transfer(bob(), "fish".into(), U128(1), Some((alice(), 1)), None);
}

#[test]
#[should_panic(expected = "same length")]
fn batch_length_mismatch_fails() {
    let mut c = setup();
    ctx(alice(), 1, 1);
    c.mt_batch_transfer(bob(), vec!["fish".into()], vec![], None, None);
}

#[test]
fn views_follow_the_standard() {
    let c = setup();
    let t = c.mt_token(vec!["fish".into(), "nope".into()]);
    assert_eq!(t[0].as_ref().unwrap().token_id, "fish");
    assert!(t[0].as_ref().unwrap().owner_id.is_none());
    assert!(t[1].is_none());
    assert_eq!(c.mt_supply("nope".into()), None);
    assert_eq!(c.mt_batch_supply(vec!["coin".into()])[0].unwrap().0, 0);
}

#[test]
#[should_panic(expected = "player limit reached")]
fn register_player_is_capped() {
    let mut c = setup(); // 2 of 3 used
    ctx(minter(), 0, 1);
    assert!(c.register_player(acc("carol.testnet")));
    assert!(!c.register_player(acc("carol.testnet")), "second registration is a no-op");
    c.register_player(acc("dave.testnet"));
}

#[test]
#[should_panic(expected = "only the minter or owner")]
fn players_cannot_register_others() {
    let mut c = setup();
    ctx(alice(), 0, 1);
    c.register_player(acc("carol.testnet"));
}

#[test]
fn storage_deposit_registers_and_bounds_are_fixed() {
    let mut c = setup();
    let min = c.storage_balance_bounds().min.0;
    ctx(acc("wallet.testnet"), min, 1);
    let b = c.storage_deposit(None, None);
    assert_eq!(b.total.0, min);
    assert!(c.is_registered(acc("wallet.testnet")));
    assert!(c.storage_balance_of(acc("nobody.testnet")).is_none());
}

#[test]
#[should_panic(expected = "minimum storage deposit")]
fn storage_deposit_too_small_fails() {
    let mut c = setup();
    ctx(acc("wallet.testnet"), 1, 1);
    c.storage_deposit(None, None);
}

#[test]
fn pause_blocks_minting_and_sends() {
    let mut c = setup();
    ctx(owner(), 0, 1);
    c.set_paused(true);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| mint(&mut c, alice(), "fish", 1, "p")));
    assert!(r.is_err());
    ctx(owner(), 0, 1);
    c.set_paused(false);
    mint(&mut c, alice(), "fish", 1, "p");
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_owner_can_change_minter() {
    let mut c = setup();
    ctx(minter(), 0, 1);
    c.set_minter(alice());
}
