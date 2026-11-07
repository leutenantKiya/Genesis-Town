> Branch `islands` contains a built alternative (Private Islands bought from the broker as versioned NFTs, see docs/superpowers/specs/2026-11-06-islands-design.md); which design ships is under discussion.

# Islands, NPC souls and schematics

Status: design, agreed 2026-11-06 after a discussion with the owner. Nothing here is built yet. One small slice (a
single NPC worker, see "Before the deadline") may be built for the hackathon; the rest is planned for after
2026-11-14.

The model borrows from Minecraft Skyblock servers: every player has a private island, and everyone meets in one shared
hub (Hypixel SkyBlock: private island plus hub, `/visit`, co-op; BentoBox: trust ranks and protection range;
SuperiorSkyblock: island level, bank, upgrades). Sources are listed at the end.

## 1. The model: private island, shared hub

| | Private island (one per player) | Shared hub (everyone) |
| --- | --- | --- |
| Holds | House, farm, buildings the player places, NPC workers | The four merchants, player booths, Balai Desa (projects, votes, announcements), forest and mine |
| Who is there | The owner and invited guests | Every player, visible to each other (presence and chat already exist) |
| Economy | Produces goods; spends goods and coin on buildings and upgrades | Prices, shop rescues, the player market, town projects: one economy for all |

Players travel between their island and the hub. The economy stays single and shared, which is what the track judges
("Games With Real Economies"). Roleplay roles (thief, police) would only make sense in the hub, and stay off until
they are redesigned so that nothing real can be taken.

Visiting another island: `/visit name`, with three trust levels: **Tamu** (look and buy), **Teman** (may help, for
example water the farm), **Blokir** (kept out). Buying at the source must be worth the walk (for example no 5% market
fee), or visiting adds nothing over the hub market.

## 2. NPC souls: the AI writes a program, the NPC only runs it

The AI never decides step by step. It writes a small program once; the NPC runs that program, and its sensors pick
which handler runs. This keeps AI calls rare and cheap, makes behaviour predictable, lets the server check every step
with the normal game rules, and lets anyone read what an NPC is doing and why.

### Creating a soul: two inputs

1. **The player's intent**, in free text, given when the soul is installed. Example: *"Panen gandum tiap pagi, jual
   ke Wati kalau harganya di atas 8, simpan 5 untuk roti."*
2. **Triggers chosen from a fixed list** the system offers (the AI never invents triggers):
   - schedule: every morning (06:00), noon (12:00), evening (18:00), night (19:00);
   - world: season changes, weather changes (rain, snow), night begins;
   - economy: a price crosses a threshold, stock runs low or full;
   - self: attacked, energy low, inventory full.

### Filtering, then compiling

1. **Filter the intent** before any AI call: reject what is not allowed (stealing, spamming chat, sending coin or items
   to someone else, anything that asks the model to ignore its rules). This is also the prompt-injection defence.
2. **Compile once.** One AI call turns the intent into one handler per chosen trigger. At run time the system only
   picks the matching handler; it does not call the AI. The AI is called again only when the player edits the intent,
   or for an event that has no handler.
3. **Check the program** (the AI's output is untrusted): it must match the program schema below and stay inside the
   limits; otherwise it is rejected with the reason. Only a program that passes becomes the bot.

### The program

Not general code. A JSON list of allowed actions with parameters, for example:

```json
{ "on": "morning", "do": [
  { "harvest": "all" },
  { "sell": "wheat", "to": "wati", "keep": 5, "minPrice": 8 },
  { "craft": "bread", "max": 2 } ] }
```

Allowed actions: gather, plant, water, harvest, craft, sell, buy, rest, eat, fight, flee, say (preset lines only).
Every step goes through the same server rules as a player: energy, node charges, daily caps, prices, positions.

Limits per soul: steps per handler, coin spent per day, energy, a minimum sell price (no fire sales), a daily quota of
actions, and a cooldown between AI calls. Emergencies are written into the program up front: *"attacked and energy
above 50%: fight; otherwise flee"*. A model call takes seconds; a fight cannot wait for one.

If the AI is unreachable, the soul keeps running its last approved program, or a plain default one.

### Paying for the AI

- **Coin**: the game's NEAR AI key compiles the program and charges coin per compile (a coin sink).
- **Bring your own key** (NEAR AI or another OpenAI-compatible provider): the browser calls the model directly with
  the player's key and sends the server only the compiled program, which the server checks like any other. Compiling
  only happens while the player is creating or editing the soul, so the key never reaches the server and the bot
  still runs while the player is offline.

### Keeping it honest

Each soul stores its intent, the approved program, the model used and a hash of the program. The player (and judges)
can read why a bot did something; the history shows which program ran.

Workers must cost something (a daily coin wage, energy) and have quotas, or they become farm bots that flood the
market and crash prices (the Axie Infinity lesson: rewards minted faster than they are spent).

### Supply chains

Some buildings need a supplier, for example a warung needs a steady supply of fish and wheat. When no player supplies
it, an NPC supplier fills in at a higher price, so nobody is locked out (the same dead end the wheat shortage caused
before village seeds).

## 3. Island upgrades and rarity

Rarity comes from upgrades: a higher island tier yields more, or better grades of, ore and minerals, so islands differ
and trading has a reason.

Decision: **upgrades are deterministic.** Pay the materials and coin, wait the build time, the upgrade succeeds.
Scarcity comes from cost and time, not luck. A chance-based upgrade on an asset that can be sold is a gambling
mechanic, and the project has a no-gambling rule.

If a chance element is ever added, all of these must hold:
- failure only spends the materials and never damages or downgrades the island;
- a pity rule guarantees success after a set number of failures;
- the odds are shown before the player commits;
- the randomness can be verified (for example derived from NEAR block randomness), so the server cannot cheat.

Stability: rare output is capped across the whole server per day (the per-item daily caps already exist), and the bonus
from a tier is a yield multiplier with diminishing returns, not unlimited new supply.

## 4. Arranging an island, checked before it is saved

Players place buildings on their own island (Kingshot-style: choose where the restaurant goes, add lamps, and so on).
A layout is saved only if it passes a validator. The validator lives in one shared file run by both the browser and
the server, like the village generator today (`client/js/world/village.js`, which already checks that every door,
stall and the farm gate can be reached from the spawn).

- The server checks every save again; the browser check is only for feedback.
- A refusal says why and marks the tiles ("the warung door is blocked by a fence", "this area has no lamp").
- Few rules, each one easy to explain: reachability, building size against the island tier, required space in front of
  doors, light coverage, a density limit.

## 5. The marketplace: schematics, not islands

Islands themselves are not sold. Players sell **schematics**: a saved, validated layout (and optionally its NPC worker
templates), as a use licence. Each time a schematic is applied to an island, its creator is paid a royalty by the
contract.

Why schematics and not islands:
- the island and everything on it stays with its owner, so there is no hoarding and no need for a land tax;
- building from a schematic needs the materials, so it creates demand for wood, ore and the rest;
- the market rewards good designers, not early land grabs;
- it can use the token and market contract that exist today.

Applying a schematic runs the validator for the buyer's island (size, tier, materials); worker templates go through the
same filtering and checks as any soul.

## Before the deadline (2026-11-14)

Only a small slice, chosen for the Agent NPC criterion and the Agent Economy track:

- one NPC worker on the player's land, with an intent, two or three triggers (morning, season change, attacked), the
  filtering and the program check, a coin wage and a daily quota;
- a panel that shows the intent, the approved program and the last actions it took, with their reasons.

Everything else (private island instances, `/visit`, upgrades, the layout editor and validator, schematics and
royalties, supply chains, votes on expansion) is after the deadline.

## Open questions

- Weighting votes on town expansion: by the amount pledged (on chain already) rather than one vote per account, so one
  person with many accounts cannot decide.
- How a player moves between island and hub (a gate, a boat, a map menu), and whether the hub is today's village
  core or a separate map.
- What exactly a schematic licence allows: one island, or every island the buyer owns.

## Sources

- Hypixel SkyBlock private islands and visiting: https://hypixelskyblock.minecraft.wiki/w/Player%27s_Island,
  https://hypixelskyblock.minecraft.wiki/w/Guesting
- BentoBox trust ranks and protection: https://docs.bentobox.world/en/latest/Glossary/,
  https://docs.bentobox.world/en/latest/gamemodes/BSkyBlock/Permissions,
  https://bentobox-world.readthedocs.io/en/latest/addons/Upgrades/
- SuperiorSkyblock levels, bank, missions, upgrades: https://wiki.bg-software.com/superiorskyblock
- GriefPrevention claims and trust: https://help.freakhosting.com/games/minecraft/claims-and-land-protection-griefprevention
- Axie Infinity token inflation: https://decrypt.co/92190/axie-infinity-making-big-changes-to-fix-its-ailing-play-to-earn-nft-economy
