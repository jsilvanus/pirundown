# PiRundown

**PiRundown** is the automated rundown walker, cue matching engine, and orchestration backbone for liturgical and live broadcast productions in the **Pi** ecosystem (PiGateway, PiCam, PiLight, PiProgram, PiVoice, PiTube).

It parses Rundown v2 YAML service documents, executes preflight data-fetching (via Varfetch), tracks real-time speech and audio telemetry from PiVoice, matches cues (phrase, fuzzy transcription, sound events, manual buttons), walks through items with a numbered presentational display model, and dispatches actions to hardware via PiGateway.

---

## Table of Contents

- [Core Capabilities](#core-capabilities)
- [Architecture & Integration](#architecture--integration)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Rundown v2 YAML Specification](#rundown-v2-yaml-specification)
  - [Document Metadata](#document-metadata)
  - [Connectors & Varfetch Integration](#connectors--varfetch-integration)
  - [Preflight Setup & Variables](#preflight-setup--variables)
  - [Rundown Items, Sections & Subitems](#rundown-items-sections--subitems)
  - [Cue Types & Conditions](#cue-types--conditions)
  - [Action Types & Alternation Engine](#action-types--alternation-engine)
- [Presentational Rundown Display Model](#presentational-rundown-display-model)
- [Pure Human Control Mode (Cue Engine Toggle)](#pure-human-control-mode-cue-engine-toggle)
- [CLI Reference](#cli-reference)
- [REST API Reference](#rest-api-reference)
- [Testing & Verification](#testing--verification)

---

## Core Capabilities

1. **Rundown Walker & State Engine**: Deterministic state machine advancing through liturgical items, hymns, readings, and blessings with support for Next, Prev, Goto, Skip, Reset, and Fire.
2. **Presentational Display System**: Generates a 1-based numbered cue sheet matching director screens; section headers have line numbers that automatically delegate firing to their first executable child item, and subitems get individual display lines.
3. **Multi-Condition Cue Engine**:
   - Exact and fuzzy speech recognition with Jaro-Winkler scoring and typo tolerance.
   - Sound state cues (`music_start`, `music_stop`, `speech_start`, `speech_stop`, `silence`).
   - Manual cues (operator push-button).
   - Composite rules (`all`, `any`) with cooldowns.
4. **Deterministic Action-Alternation**: Periodic camera cut alternations (e.g. cut between cam 1 and cam 2 every 10 seconds) gated by sound conditions (`speech`, `music`, `silence`, `any`).
5. **Dynamic Variable Store & Varfetch**: Lectionary integration and dynamic string interpolation (`{{ preacher }}`, `{{ hymn_1 }}`).
6. **Pure Human Control**: Instant operator override toggle to disable automatic cues while keeping manual triggers and walking active.

---

## Architecture & Integration

```
                 +-------------------+
                 |    PiVoice SSE    | (Transcripts, Speech & Music telemetry)
                 +---------+---------+
                           |
                           v
+------------------+  +----+------------------+  +-------------------+
|  Operator / UI   |->|      PiRundown        |->|     PiGateway     |
| (Web/CLI/Stream) |  |   (Walker & Cues)     |  |  (Hardware Hub)   |
+------------------+  +-----------------------+  +----+----+----+----+
                                                      |    |    |    |
                                                      v    v    v    v
                                                    ATEM  PTZ  DMX  HYMN
```

PiRundown is the **Walker and Cue Engine**. It does not speak directly to serial ports or VISCA cameras; instead, all device commands are routed to `PiGateway` via `/api/v1/actions/execute` with `actor: "rundown"`.

---

## Configuration & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PIRUNDOWN_PORT` | `3400` | HTTP service port |
| `PIRUNDOWN_HOST` | `0.0.0.0` | HTTP service bind address |
| `PIRUNDOWN_API_KEY` | *(none)* | Optional Bearer API key for mutating HTTP endpoints |
| `PIRUNDOWN_PIGATEWAY_URL` | `http://127.0.0.1:3100` | Base URL for PiGateway actions & authoritative rundown store |
| `PIRUNDOWN_PICAM_URL` | `http://127.0.0.1:3300` | Optional direct PiCam URL fallback |
| `PIRUNDOWN_PILIGHT_URL` | `http://127.0.0.1:3200` | Optional direct PiLight URL fallback |
| `PIRUNDOWN_PIPROGRAM_URL` | `http://127.0.0.1:3100` | Optional direct PiProgram URL fallback |
| `PIRUNDOWN_AUTO_CONNECT_GATEWAY` | `true` | When `true`, automatically pushes active rundown to gateway and listens to SSE |
| `PIRUNDOWN_DEFAULT_RUNDOWN_PATH` | *(none)* | Path to default YAML rundown to load automatically on server start |

---

## Rundown v2 YAML Specification

### Document Metadata

```yaml
version: 2
title: "Messu"
service: "Päiväjumalanpalvelus"
church: "Riihimäen Keskuskirkko"
date: "2026-11-01"
```

- `version`: Required. Must be `2` (integer).
- `title`: Required. Service title.
- `service`: Optional. Service type or subtitle.
- `church`: Optional. Parish or building name.
- `date`: Optional. ISO date string (`YYYY-MM-DD`).

---

### Connectors & Varfetch Integration

`connectors` configure external liturgical lectionaries or REST endpoints to dynamically populate variables before or during the service.

```yaml
connectors:
  kirkkovuosi:
    baseUrl: "https://api.example.org"
    auth:
      type: "bearer" # "none" | "bearer" | "api_key" | "basic" | "custom"
      token: "secret-token"
    headers:
      - key: "Accept-Language"
        value: "fi"
    requests:
      tanaan:
        method: "GET"
        path: "/api/v1/liturgy/today"
        mappings:
          - jsonPath: "$.holyDay.name"
            variable: "pyhan_nimi"
          - jsonPath: "$.texts.gospel.reference"
            variable: "evankeliumi_viite"
```

---

### Preflight Setup & Variables

Preflight runs immediately when the rundown is loaded. It seeds variables and can execute connector requests:

```yaml
preflight:
  fetch:
    - connector: "kirkkovuosi"
      request: "tanaan"
  variables:
    preacher: "Pastori Matti"
    cantor: "Kanttori Liisa"
    hymn_1: "332"
    hymn_2: "450"
    hymn_3: "228"
    cam_altar_preset: "1"
```

Variables are referenced anywhere in actions, strings, or cues using double braces: `{{ preacher }}`, `{{ hymn_1 }}`.

---

### Rundown Items, Sections & Subitems

The `rundown` section contains an array of items. PiRundown supports:
1. **Explicit sections**: Items with `section: "Section Name"` (auto-creates a section header).
2. **Subitems**: Items with nested `subitems: [...]`. Each subitem gets its own display line and fire pointer.
3. **Pure items**: Standard executable items.

```yaml
rundown:
  # Section: Johdanto (automatically creates Section Header Line)
  - id: "alkusoitto"
    title: "Alkusoitto (Preludi)"
    section: "Johdanto"
    notes: "Urkuri soittaa alkumusiikin."
    cue:
      type: "sound"
      event: "music_stop"
    actions:
      - cam: { id: 1, preset: "{{ cam_altar_preset }}" }
      - atem: { cut: 1 }

  - id: "alkusiunaus"
    title: "Alkusiunaus"
    section: "Johdanto"
    cue:
      type: "phrase"
      phrase: "Isän ja Pojan ja Pyhän Hengen nimeen"
    actions:
      - atem: { cut: 2 }

  # Parent item with subitems:
  - id: "sana"
    title: "Sanan liturgia"
    section: "Sana"
    subitems:
      - id: "ensimmainen_lukukappale"
        title: "1. lukukappale"
        cue:
          type: "fuzzy"
          phrase: "Tämä on Herran sana"
        actions:
          - atem: { cut: 1 }
      - id: "evankeliumi"
        title: "Evankeliumi"
        cue:
          type: "fuzzy"
          phrase: "Nouskaa kuulemaan pyhää evankeliumia"
        actions:
          - cam: { id: 2, preset: "lukupulpetti" }
          - atem: { cut: 2 }
```

---

### Cue Types & Conditions

Cues determine what triggers the automatic transition to the item or action execution.

#### 1. Exact Phrase Cue (`phrase`)
Matches an exact speech transcript phrase (case-insensitive by default).
```yaml
cue:
  type: "phrase"
  phrase: "Aamen"
  caseSensitive: false # default: false
  cooldown_ms: 2000 # default: 0
  mode: "next" # "next" | "skip" | "any"
```

#### 2. Fuzzy Speech Cue (`fuzzy`)
Uses Jaro-Winkler substring distance scoring. Handles transcription typos and speech recognition variants.
```yaml
cue:
  type: "fuzzy"
  phrase: "Herra olkoon teidän kanssanne"
  threshold: 0.85 # default: 0.8 (0.0 to 1.0)
  cooldown_ms: 3000
```

#### 3. Regular Expression Cue (`regex`)
Matches transcript against regex patterns.
```yaml
cue:
  type: "regex"
  pattern: "virsi\\s+(numero\\s+)?(332|kolmesataakaksikymmentäkaksi)"
  flags: "i"
```

#### 4. Sound Event Cue (`sound`)
Triggers from PiVoice acoustic telemetry:
- Events: `music_start`, `music_stop`, `speech_start`, `speech_stop`, `silence`
```yaml
cue:
  type: "sound"
  event: "music_stop"
  duration_ms: 1000 # Optional minimum duration filter
```

#### 5. Manual Cue (`manual`)
Pure manual trigger; requires operator button press or CLI/API fire command.
```yaml
cue:
  type: "manual"
```

#### 6. Composite Cues (`all` / `any`)
Combine multiple conditions.
```yaml
cue:
  type: "all"
  conditions:
    - type: "sound"
      event: "speech_start"
    - type: "fuzzy"
      phrase: "Rukoilkaamme"
```

---

### Action Types & Alternation Engine

Actions are executed when an item activates. Multiple actions run in sequential order.

#### ATEM Video Switcher (`atem`)
```yaml
actions:
  - atem: { cut: 1 } # Program cut to input 1
  - atem: { auto: true } # Auto transition (mix/wipe)
  - atem: { ftb: true } # Fade to black toggle
  - atem: { dsk: 1, state: "on" } # Downstream Keyer on/off/toggle
```

#### PTZ Camera (`cam`)
```yaml
actions:
  - cam: { id: 1, preset: 2 } # Recall preset 2 on camera 1
  - cam: { id: 2, preset: "altar" } # Preset by name or variable
  - cam: { id: 1, move: "left", speed: 5 } # Manual pan move
  - cam: { id: 1, zoom: "in", speed: 3 } # Zoom in
```

#### Hymn / Slide Projection (`pipgm`)
```yaml
actions:
  - pipgm: { hymn: 332 } # Set hymn number
  - pipgm: { slide: 1 } # Show slide 1
  - pipgm: { ftb: true } # Fade hymn display to black
```

#### Tally Light (`tally`)
```yaml
actions:
  - tally: { unit: 1, state: "pgm" } # "pgm" | "prv" | "off"
  - tally: { unit: 2, cue: "talent-ready" }
```

#### Variables (`var`)
Updates local and shared variables during the service:
```yaml
actions:
  - var:
      section: "Saarna"
      active_speaker: "Pastori Matti"
```

#### Varfetch Fetch (`fetch`)
```yaml
actions:
  - fetch:
      connector: "kirkkovuosi"
      request: "tanaan"
```

#### Delay (`delay`)
Pause execution before the next action runs:
```yaml
actions:
  - delay: { ms: 500 }
```

#### Action Shorthand Strings
For concise YAML documents:
```yaml
actions:
  - "cut:1"
  - "cam:1:preset:2"
  - "var:preacher=Pastori Matti"
  - "fetch:kirkkovuosi:tanaan"
```

#### Deterministic Action Alternation (`alternate`)
Cycles actions deterministically on a periodic interval. Pre-roll actions establish initial camera state, then alternation runs until the item ends or advances.

- `interval_sec` or `interval_ms`: Cycle frequency.
- `during`: Audio condition gating:
  - `"any"` (default): Cycles unconditionally.
  - `"speech"`: Cycles only during active speech (pauses when speaker stops).
  - `"music"`: Cycles only during music (pauses when music stops).
  - `"silence"`: Cycles only during silence.
- `cut`: Shorthand array of ATEM camera inputs to toggle between.
- `steps`: Array of arbitrary action arrays for complex multi-camera moves.

```yaml
- id: saarna
  title: Saarna
  section: Sana
  actions:
    # 1. Setup pre-roll actions
    - cam: { id: 1, preset: 1 }
    - cam: { id: 2, preset: 2 }
    - cut: 1

    # 2. Alternate every 10s between cam 1 and cam 2 ONLY during speech:
    - alternate:
        interval_sec: 10
        during: speech
        cut: [1, 2]

# Multi-step action cycle:
- id: ehtoollismusiikki
  title: Ehtoollismusiikki
  actions:
    - alternate:
        interval_sec: 15
        during: music
        steps:
          - [{ cut: 3 }]
          - [{ cam: { id: 1, preset: "kuori" } }, { cut: 1 }]
          - [{ cut: 2 }]
```

---

## Presentational Rundown Display Model

Display lines do not mirror raw YAML lines. `buildRundownDisplay()` compiles the rundown into a 1-based numbered presentation table:

```
Line  Type     Level  Title                       Actions / Cues
─────────────────────────────────────────────────────────────────────────────────
 1    section    0    ── Johdanto ──             -> delegates to Line 2
 2    item       1    Alkusoitto (Preludi)       [cut:1, cam:1:preset:1] (cue: sound.music_stop)
 3    item       1    Alkusiunaus                [cut:2] (cue: phrase "Isän ja Pojan...")
 4    section    0    ── Sana ──                 -> delegates to Line 5
 5    item       1    Sanan liturgia             -> delegates to Line 6
 6    subitem    2      1. lukukappale           [cut:1] (cue: fuzzy "Tämä on Herran sana")
 7    subitem    2      Evankeliumi              [cam:2:preset:2, cut:2]
```

- **Section Delegation**: Section headers have their own display line numbers for operator readability. Calling `fire(1)` on *Johdanto* automatically delegates to Line 2 (*Alkusoitto*).
- **Subitem Lines**: Subitems each receive a distinct line number, status tracking, and can be jumped to directly (`fire(7)`).

---

## Pure Human Control Mode (Cue Engine Toggle)

During rehearsals, technical adjustments, or unpredictable service timing, the director can toggle the cue engine **OFF**.
- When **OFF**, all speech matching, sound telemetry triggers, and composite auto-cues are suppressed.
- The operator retains 100% manual control to click **Next**, **Prev**, **Skip**, or **Fire** any line or item ID.
- Can be toggled at any moment via CLI (`pirundown cues toggle`) or HTTP POST `/api/v1/cues/toggle`.

---

## CLI Reference

`pirundown` includes a complete command-line interface:

```bash
# View live status and presentational display
pirundown status
pirundown display

# Load a new rundown YAML
pirundown load ./examples/sunday-mass.yaml

# Manual walker controls
pirundown next               # Step forward
pirundown prev               # Step backward
pirundown skip [id]          # Skip current item without executing actions
pirundown goto <id>          # Jump pointer directly to item ID
pirundown fire <line|id>     # Jump pointer AND execute actions for line or ID (e.g. pirundown fire 17)
pirundown reset              # Reset rundown to start

# Pure human control mode
pirundown cues               # Show cue engine state (ENABLED / OFF)
pirundown cues toggle        # Toggle cue engine on/off
pirundown cues on            # Enable automatic cues
pirundown cues off           # Disable automatic cues

# Variables & Varfetch
pirundown vars               # List active variables
pirundown set <key> <val>    # Set variable value

# Simulation & Testing
pirundown transcript "Aamen" # Simulate speech transcript
pirundown sound music_start  # Simulate acoustic telemetry event
```

### Global CLI Flags
- `--url <url>`: Override pirundown URL (default: `http://127.0.0.1:3400` or `PIRUNDOWN_URL`).
- `--key <token>`: Provide API Bearer key (`PIRUNDOWN_API_KEY`).
- `--json`: Output raw JSON responses for automation scripts.

---

## REST API Reference

All mutating endpoints respect `PIRUNDOWN_API_KEY` when configured (`Authorization: Bearer <token>`).

### Rundown Engine & Walker

| Method | Endpoint | Description | Request Body |
|---|---|---|---|
| `GET` | `/health` | Health check | — |
| `GET` | `/api/v1/status` | Rundown engine snapshot, lines, current line, sound & alternation state | — |
| `GET` | `/api/v1/rundown` | Full rundown display and current status | — |
| `POST` | `/api/v1/rundown/load` | Load rundown from YAML string or file path | `{"yaml": "..."}` or `{"path": "..."}` |
| `POST` | `/api/v1/rundown/reset` | Reset pointer to start | — |
| `POST` | `/api/v1/rundown/next` | Advance to next item and execute actions | — |
| `POST` | `/api/v1/rundown/previous` | Step back to previous item | — |
| `POST` | `/api/v1/rundown/skip` | Skip current or specified item | `{"id": "..."}` (optional) |
| `POST` | `/api/v1/rundown/goto/:id` | Move pointer to item ID without executing | — |
| `POST` | `/api/v1/rundown/fire` | Fire specific display line number or item ID | `{"line": 17}` or `{"id": "saarna"}` |
| `POST` | `/api/v1/rundown/fire/:id` | Fire specific item ID | — |

### Cue Engine Control

| Method | Endpoint | Description | Request Body |
|---|---|---|---|
| `GET` | `/api/v1/cues` | Check if cue engine is enabled | — |
| `POST` | `/api/v1/cues/toggle` | Toggle cue engine on/off | `{"enabled": boolean}` (optional) |
| `POST` | `/api/v1/cues/enable` | Enable automatic cue matching | — |
| `POST` | `/api/v1/cues/disable` | Disable automatic cue matching (pure human control) | — |

### Variables & Connectors

| Method | Endpoint | Description | Request Body |
|---|---|---|---|
| `GET` | `/api/v1/variables` | Get all variables | — |
| `POST` | `/api/v1/variables/set` | Set variable value | `{"name": "preacher", "value": "Matti", "ttlMs": 60000}` |
| `POST` | `/api/v1/variables/fetch` | Trigger ad-hoc connector request | `{"connector": "kirkkovuosi", "request": "tanaan"}` |

### Real-Time Events & Telemetry

| Method | Endpoint | Description | Request Body |
|---|---|---|---|
| `GET` | `/api/v1/events` | Server-Sent Events (SSE) stream for rundown state & triggers | — |
| `POST` | `/api/v1/test/transcript` | Ingest speech transcript text | `{"text": "Isän ja Pojan nimeen"}` |
| `POST` | `/api/v1/test/sound` | Ingest acoustic event (`music_start`, `music_stop`, etc.) | `{"event": "music_start"}` |

---

## Testing & Verification

Run the full automated test suite:

```bash
npm --prefix d:\pirundown test
```

The test suite covers:
- **`alternation.test.ts`**: Deterministic cyclic camera switching with sound gates (`speech`, `music`, `silence`, `any`) and automatic lifecycle cleanup.
- **`rundown-engine.test.ts`**: Walker progression, line firing, section header redirection, subitems, and cue engine toggle overrides.
- **`cue-matcher.test.ts` & `jaro-winkler.test.ts`**: Exact phrases, fuzzy tolerance scoring, regex, sound events, and cooldowns.
- **`schema.test.ts`**: Zod validation of Rundown v2 specifications and connectors.
- **`variable-store.test.ts`**: TTL expiry, string interpolation, and Varfetch integrations.
- **`action-dispatcher.test.ts`**: ATEM cuts, PTZ camera presets, and PiGateway dispatching with actor stamping.
