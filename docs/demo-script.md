# Genesis Town: demo video script

About 3 minutes, English voiceover. Record in the live game on testnet (genesistown.up.railway.app).
Shot notes are in brackets. The voiceover is what you read aloud. Roughly 140 words a minute.

---

## 0:00 to 0:20, the hook

[Title card for two seconds, then the village at dawn in the 2.5D view. Walk the character past the four merchant stalls.]

This is Genesis Town. You fish, chop wood, mine ore, farm wheat and sell it to four shopkeepers.
Their prices move with their stock, what people bought this week and how much cash they have left.
Every item and every coin in your bag is a token on NEAR. You never see that unless you go looking.

## 0:20 to 0:45, sign in without a wallet

[Click "Sign in with Google". Land on the character screen, type a name, pick a look, press Start.]

I sign in with Google. No seed phrase, no wallet popup.
Behind that button the game creates a NEAR account for me and keeps a game key in the browser.
That key can only call the game contract, and a relayer pays the gas, so playing never asks me to sign anything.

## 0:45 to 1:25, the economy loop

[Chop a tree, mine a rock, catch a fish. Open the bag. Walk to Budi's stall, sell five fish, then sell five more and point at the price dropping.]

Gathering, crafting and shop sales happen off chain, checked by the server against where I am standing.
Watch Budi's price for fish. I sell five, he pays less for the next five. He has more fish now and less cash.
Once a game day, at six in the morning, the server writes everyone's net changes to the contract in one settlement,
along with a Merkle root of the day's ledger. Anyone can check a trade against that root.
The contract also caps how much new coin can enter the town each day, so selling more can't simply print money.

## 1:25 to 1:55, what lives on chain

[Open the Market (Pasar): list an item, show the listing. Open a merchant's shop shares. Show the explorer page of the game contract with recent settle and market events.]

Some things go on chain right away: market listings between players, gifts, shares in a shop and town projects.
If a shopkeeper goes broke, players can buy shares to reopen the shop and earn dividends when it does well.
Here is the same contract on the explorer: settlements, listings and transfers, all public.

## 1:55 to 2:30, your own town

[Walk through the portal into your Homeland. Open the Town Hall, start an upgrade, hire a worker, show the builder timer.]

Every player also gets a Homeland. You raise the Town Hall, open new land, hire workers and build a mine or a sawmill.
Workers get tired and need beds and food from your restaurant, so running a town costs real resources.
Friends can visit, help you gather or build, and trade with you face to face.

## 2:30 to 2:50, coin with a real price

[Click the coin counter. Show the top-up window, pick 100 coin for 0.1 NEAR, approve in the NEAR Auth window. Then show the explorer: the buy_coin call.]

Coin can also be bought with NEAR, at a thousand coin per NEAR.
The coin comes out of the town treasury, the contract doesn't mint it, and the purchase is one public call you can audit.

## 2:50 to 3:00, close

[Wide shot of the market square at night: lanterns, the concert stage, players walking around.]

Genesis Town: a small market town where the prices are earned and the ledger is public.
Built on NEAR testnet. Come and sell us some fish.

---

## Notes for recording

- Before recording, make sure the town treasury has coin and the coin sale is on (`coin_sale` view), and use an
  account made with NEAR Auth for the top-up shot.
- The Budi price drop shows best with a quiet shop: sell fish in two batches and keep the price visible between them.
- Keep the explorer tab open in advance: `testnet.nearblocks.io/address/game.genesistown.testnet`.
- If a shot runs long, cut the Homeland section first; the economy loop and the on-chain section matter most for the
  "Games With Real Economies" track.
