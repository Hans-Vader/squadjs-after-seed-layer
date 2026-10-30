# AfterSeedLayer

A [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS) plugin that sets a fixed
**after-seed layer per weekday** as the next layer once a seed round has enough players, and hands
the choice back to the in-game layer vote if the seed round gets too full.

## Behaviour

- Only acts while the current layer is a **Seed** layer (`gamemode` `Seed`).
- Evaluates on every `UPDATED_SERVER_INFORMATION` event (~30s) using the server's player count
  (queue not included).
- Once the player count reaches `setThreshold` and no next layer is set yet (next layer is
  "To be voted"), it runs `AdminSetNextLayer <today's layer>`. The weekday is the server's local
  time. If today has a list of layers, one is picked at random.
- If the player count then rises **above** `clearThreshold` during the same seed round, it runs
  `AdminClearNextLayer`, so the layer vote decides instead. `clearThreshold: 0` turns this off.
- It never overrides or clears a next layer an admin set: right before setting it re-checks via RCON
  that the vote is still pending, and before clearing that `ShowNextMap` still returns what it did
  right after the plugin set its layer. The same layer with other factions counts as foreign, an
  identical one does not (see notes).
- At most one set and one clear per round. `ROUND_ENDED` freezes the state (the set layer is about
  to load), `NEW_GAME` starts over.
- If no layer is configured for today, it does nothing.

## Installation

Copy `after-seed-layer.js` into your SquadJS install at `squad-server/plugins/`, then add a block
to the `plugins` array in `config.json`:

```json
{
  "plugin": "AfterSeedLayer",
  "enabled": true,
  "setThreshold": 50,
  "clearThreshold": 80,
  "layers": {
    "monday": ["Harju_AAS_v2 BAF RGF+support"],
    "tuesday": ["Chora_RAAS_v1 USA PLA"],
    "wednesday": ["Narva_RAAS_v1 CAF+support IMF"],
    "thursday": ["Harju_AAS_v3 RGF PLA"],
    "friday": ["Mutaha_RAAS_v2 IMF USMC+support"],
    "saturday": [
      "AlBasrah_AAS_v3_CL VDV+support BAF+support",
      "Gorodok_RAAS_v1 USA RGF",
      "Fallujah_RAAS_v1 USMC PLA",
      "Yehorivka_RAAS_v2 AFU CAF"
    ],
    "sunday": [
      "BlackCoast_AAS_v1 AFU ADF",
      "Kokan_RAAS_v1 BAF TLF",
      "Mestia_RAAS_v1 CAF RGF",
      "Sanxian_RAAS_v1 USMC PLA"
    ]
  }
}
```

## Options

| Option | Default | Description |
|---|---|---|
| `setThreshold` | `50` | Player count (inclusive) at which the after-seed layer is set. |
| `clearThreshold` | `80` | Player count above which the plugin clears its own next layer again, so the vote takes over. `0` disables clearing; the layer is then set at any count from `setThreshold` up. |
| `layers` | *(see above)* | List of `AdminSetNextLayer` arguments per weekday (`monday` … `sunday`), passed to RCON verbatim. Each time the layer is set, one entry of today's list is picked at random. A single string instead of a list works too. A missing day or empty list means no after-seed layer on that day. |

## Notes & limitations

- Layer strings are not validated. If Squad rejects `AdminSetNextLayer` (typo, unknown faction) or
  RCON fails while setting, the plugin does not retry in the same seed round. A failed re-check
  before setting is retried on the next poll. After setting, it logs the `ShowNextMap` answer at
  verbose level 1, so a rejected layer shows up there.
- Reaction time is bounded by the ~30s server-information poll.
- State lives in memory: if SquadJS restarts mid-seed after the plugin set a layer, it will not
  clear that layer anymore.

## Testing

```sh
node test/verify.mjs
```

Self-contained, no SquadJS install needed: it stubs `BasePlugin`, mocks the server and RCON, and
fakes the weekday.

## License

[GPL-3.0](LICENSE)
