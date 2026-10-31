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
    let minter = create_subaccount(&sandbox, "minter.sandbox").await?;
    let alice = create_subaccount(&sandbox, "alice.sandbox").await?;
    let bob = create_subaccount(&sandbox, "bob.sandbox").await?;
    let contract = create_subaccount(&sandbox, "game.sandbox").await?.as_contract();

    let tokens = json!([
        {"token_id": "coin", "name": "Koin", "kind": "Currency"},
        {"token_id": "fish", "name": "Ikan", "kind": "Raw"},
        {"token_id": "wood", "name": "Kayu", "kind": "Raw"}
    ]);
    let limits = json!({"daily_gather_cap": "100", "daily_sends": 20, "max_send_amount": "10", "max_batch": 50, "max_players": 100});
    near_api::Contract::deploy(contract.account_id().clone())
        .use_code(wasm)
        .with_init_call("new", json!({
            "owner_id": owner.account_id(), "minter_id": minter.account_id(), "town_id": owner.account_id(),
            "tokens": tokens, "limits": limits
        }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let call = |method: &str, args: Value, who: &near_api::Account, deposit: u128| {
        contract
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(100))
            .deposit(NearToken::from_yoctonear(deposit))
            .with_signer(who.account_id().clone(), signer.clone())
    };

    // The minter registers both players; a player cannot register anyone.
    for p in [&alice, &bob] {
        call("register_player", json!({"account_id": p.account_id()}), &minter, 0).send_to(&net).await?.assert_success();
    }
    call("register_player", json!({"account_id": "mallory.sandbox"}), &alice, 0).send_to(&net).await?.assert_failure();

    // Gathered items are minted by the minter only, and a mint_id can only be used once.
    let batch = json!([{"account_id": alice.account_id(), "token_id": "fish", "amount": "3"}]);
    call("mint_gathered", json!({"batch": batch, "mint_id": "batch-1"}), &minter, 0).send_to(&net).await?.assert_success();
    call("mint_gathered", json!({"batch": batch, "mint_id": "batch-1"}), &minter, 0).send_to(&net).await?.assert_failure();
    call("mint_gathered", json!({"batch": batch, "mint_id": "batch-2"}), &alice, 0).send_to(&net).await?.assert_failure();
    let coin = json!([{"account_id": alice.account_id(), "token_id": "coin", "amount": "1000"}]);
    call("mint_gathered", json!({"batch": coin, "mint_id": "batch-3"}), &minter, 0).send_to(&net).await?.assert_failure();

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
    assert_eq!(balance(alice.account_id().clone(), "fish").await, 3);

    // send_item works with no deposit; mt_transfer requires exactly 1 yoctoNEAR.
    call("send_item", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 0).send_to(&net).await?.assert_success();
    call("mt_transfer", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 0).send_to(&net).await?.assert_failure();
    call("mt_transfer", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1"}), &alice, 1).send_to(&net).await?.assert_success();
    assert_eq!(balance(alice.account_id().clone(), "fish").await, 1);
    assert_eq!(balance(bob.account_id().clone(), "fish").await, 2);

    // mt_transfer_call to an account with no contract: the receiver call fails and the transfer is refunded.
    call("mt_transfer_call", json!({"receiver_id": bob.account_id(), "token_id": "fish", "amount": "1", "msg": ""}), &alice, 1)
        .send_to(&net)
        .await?
        .assert_success();
    assert_eq!(balance(alice.account_id().clone(), "fish").await, 1, "refunded after failed mt_on_transfer");
    assert_eq!(balance(bob.account_id().clone(), "fish").await, 2);

    // Supply equals what was minted.
    let supply: near_api::Data<Option<String>> = contract.call_function("mt_supply", json!({"token_id": "fish"})).read_only().fetch_from(&net).await?;
    assert_eq!(supply.data.as_deref(), Some("3"));
    Ok(())
}
