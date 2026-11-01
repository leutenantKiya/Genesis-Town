//! Sandbox integration test: deploys the real wasm to a local near-sandbox and checks the M1 flows.
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::serde_json::{Value, json};

async fn create_subaccount(sandbox: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<near_api::Account> {
    let account_id: AccountId = name.parse().unwrap();
    sandbox.create_account(account_id.clone()).initial_balance(NearToken::from_near(10)).send().await?;
    Ok(near_api::Account(account_id))
}

#[tokio::test]
async fn game_contract_flows() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let wasm = std::fs::read(wasm_path)?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = near_api::NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = near_api::Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse().unwrap())?;

    let owner = create_subaccount(&sandbox, "owner.sandbox").await?;
    let settler = create_subaccount(&sandbox, "settler.sandbox").await?;
    let town = create_subaccount(&sandbox, "town.sandbox").await?;
    let budi = create_subaccount(&sandbox, "budi.sandbox").await?;
    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let contract = create_subaccount(&sandbox, "game.sandbox").await?.as_contract();

    let tokens = json!([
        {"token_id": "coin", "name": "Koin", "kind": "Currency", "base": "1"},
        {"token_id": "fish", "name": "Ikan", "kind": "Raw", "base": "8"},
        {"token_id": "ore", "name": "Bijih", "kind": "Raw", "base": "12"}
    ]);
    let limits = json!({"daily_gain_cap": "200", "daily_coin_gain_cap": "5000", "daily_sends": 20, "max_send_amount": "10",
        "max_chunk": 50, "max_players": 100, "faucet_w0": "1200", "money_cap0": "25000", "active_divisor": 10, "max_k": 6,
        "rent": "40", "initial_shares": "1000", "max_contributors": 20});
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({
            "owner_id": owner.account_id(), "settler_id": settler.account_id(), "town_id": town.account_id(),
            "tokens": tokens, "limits": limits, "treasury_coin": "5000"
        }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let call = |method: &str, args: Value, who: &near_api::Account, deposit: u128| {
        contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(150))
            .deposit(NearToken::from_yoctonear(deposit))
            .with_signer(who.account_id().clone(), signer.clone())
    };
    let root = "a".repeat(64);

    call("register_merchant", json!({"account_id": budi.account_id(), "name": "Bengkel Budi",
        "restore": [{"token_id": "coin", "amount": "200"}, {"token_id": "ore", "amount": "10"}],
        "start": [{"token_id": "coin", "amount": "600"}, {"token_id": "ore", "amount": "15"}]}), &owner, 0)
        .send_to(&net).await?.assert_success();
    for p in [&alice, &bob] {
        call("register_player", json!({"account_id": p.account_id()}), &settler, 0).send_to(&net).await?.assert_success();
    }
    call("register_player", json!({"account_id": "mallory.sandbox"}), &alice, 0).send_to(&net).await?.assert_failure();

    // Day 1 settlement: starter coin from the treasury, 3 fish gathered, budi pays alice 570 coin for 20 ore.
    let day1 = json!([
        {"account_id": town.account_id(), "token_id": "coin", "delta": "-100"},
        {"account_id": alice.account_id(), "token_id": "coin", "delta": "670"},
        {"account_id": alice.account_id(), "token_id": "fish", "delta": "3"},
        {"account_id": alice.account_id(), "token_id": "ore", "delta": "20"},
        {"account_id": budi.account_id(), "token_id": "coin", "delta": "-570"}
    ]);
    let settle = |entries: &Value, chunk: u32| call("settle_day", json!({"day": 1, "chunk": chunk, "entries": entries, "ledger_root": root, "active_players": 2}), &settler, 0);
    settle(&day1, 0).send_to(&net).await?.assert_success();
    settle(&day1, 0).send_to(&net).await?.assert_failure(); // same chunk twice
    call("settle_day", json!({"day": 1, "chunk": 1, "entries": day1, "ledger_root": root, "active_players": 2}), &alice, 0)
        .send_to(&net).await?.assert_failure(); // not the settler

    let balance = |acct: AccountId, token: &'static str| {
        let contract = contract.clone();
        let net = net.clone();
        async move {
            let r: near_api::Data<String> = contract
                .call_function("mt_balance_of", json!({"account_id": acct, "token_id": token}))
                .read_only()
                .fetch_from(&net)
                .await
                .unwrap();
            r.data.parse::<u128>().unwrap()
        }
    };
    assert_eq!(balance(alice.account_id().clone(), "coin").await, 670);
    assert_eq!(balance(budi.account_id().clone(), "coin").await, 30);

    // send_item works with no deposit; mt_transfer requires exactly 1 yoctoNEAR.
    call("send_item", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 0).send_to(&net).await?.assert_success();
    call("mt_transfer", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 0).send_to(&net).await?.assert_failure();
    call("mt_transfer", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 1).send_to(&net).await?.assert_success();
    // mt_transfer_call to an account with no contract: the transfer is refunded.
    call("mt_transfer_call", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1", "msg": ""}), &alice, 1)
        .send_to(&net).await?.assert_success();
    assert_eq!(balance(alice.account_id().clone(), "fish").await, 1);
    assert_eq!(balance(bob.account_id().clone(), "fish").await, 2);

    // Budi cannot pay rent (30 < 40): the settler closes the shop; alice restores it and gets shares.
    call("close_shop", json!({"merchant": budi.account_id()}), &settler, 0).send_to(&net).await?.assert_success();
    call("restore_contribute", json!({"merchant": budi.account_id(), "contribution": [
        {"token_id": "coin", "amount": "200"}, {"token_id": "ore", "amount": "10"}]}), &alice, 0).send_to(&net).await?.assert_success();
    let shop: near_api::Data<Value> = contract.call_function("get_shop", json!({"merchant": budi.account_id()})).read_only().fetch_from(&net).await?;
    assert_eq!(shop.data["open"], json!(true), "restored shop reopens");
    let holding: near_api::Data<Value> = contract.call_function("get_holding", json!({"merchant": budi.account_id(), "holder": alice.account_id()})).read_only().fetch_from(&net).await?;
    assert!(holding.data["shares"].as_str().unwrap().parse::<u128>().unwrap() > 0);
    assert_eq!(balance(budi.account_id().clone(), "coin").await, 230);
    Ok(())
}
