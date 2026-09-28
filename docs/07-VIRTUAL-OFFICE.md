# 07 · Virtual Office (Gather-style, two views)

A living office map, like Gather but more realistic. Every AI employee is a character who works at their desk when busy and walks to the lobby, coffee lounge or game room when idle. Click anyone to see **their screen (POV)** in real time or **chat** with them.

**Chosen look: Isometric 2.5D** (Magnific concept "Isometric 2.5D", Personal project): warm daylight, glass walls, oak desks, concrete floor, plants, city view, semi-realistic office characters with name tags and status dots. The Gather screenshot is the reference for readability (room signs, name tags). The HD top-down concept is only a secondary lightweight view.

## 1. Two views, one office

Both views draw the **same logical map**: the same rooms, desks, spots and paths. Only the art and camera differ, so all game logic is written once.

| | View A · Isometric 2.5D (**main view**) | View B · HD top-down (optional light view) |
|---|---|---|
| Camera | 2:1 isometric, 3D-rendered look | Straight down, like Gather |
| Feel | Most realistic and immersive | Clear, easy to scan, lighter on old phones |
| Art | Pre-rendered iso tiles/props + character sheets (4 diagonal directions) | HD top-down tiles (48–64 px) + character sheets (4 directions) |
| Effort | Higher (depth sorting, taller art) | Lower; comes almost free once the 3D art pipeline exists |

The office opens in **Isometric**. A toggle in the toolbar switches to `Top-down`; the choice is remembered per device. Top-down can be skipped entirely at first.

## 2. Tech

| Part | Choice | Why |
|---|---|---|
| Game engine | **Phaser 3** inside the Next.js dashboard (client-only component) | Built-in tilemaps (orthogonal **and** isometric), cameras, zoom/pan, sprites, animations, input |
| Map editor | **Tiled** (free) → exports JSON loaded by Phaser | Draw rooms, place desks and spots visually; one map file per view |
| Walking | A* pathfinding on the walkable grid (`easystarjs`) | Characters walk around furniture through doorways |
| Live data | Supabase Realtime → Zustand store → Phaser scene | Same store feeds the grid view, KPIs and badges |
| UI over the map | React (shadcn) panels on top of the canvas | Name tags, POV panel, chat, tooltips stay crisp and accessible |

## 3. Floor plan (both views)

```
┌──────────────┬─────────────────────────────┬───────────────┬─────────────┐
│  BOARDROOM   │        DEV TEAM             │    QA LAB     │  CEO OFFICE │
│ (COO plans,  │ Shopify · Webflow ·         │  QA Lead      │  (you)      │
│  kickoffs)   │ WordPress · Full-Stack      │  test bench   │             │
├──────────────┼─────────────────────────────┼───────────────┴─────────────┤
│ DESIGN       │   GROWTH & SALES            │   CONTENT ROOM               │
│ STUDIO       │ Pipeline · Prospecting ·    │ SEO ×2 · Social ×2           │
│ UI/UX ×2     │ Inbound · Job Scout         │                              │
│ Graphic ×2   │                             │                              │
├──────────────┼─────────────────────────────┼──────────┬─────────┬────────┤
│  OPS DESK    │  MULTIMEDIA STUDIO          │  COFFEE  │  GAME   │ LOBBY  │
│  COO · EA &  │  Video Editor: edit bay     │  LOUNGE  │  ROOM   │ recep- │
│  Reports ·   │  with timeline screens      │ espresso │ ping-   │ tion,  │
│  Client      │  Sound & Voice: vocal booth │ bar,     │ pong,   │ couches│
│  Success     │  (mic, acoustic foam)       │ sofas    │ foosball│        │
└──────────────┴─────────────────────────────┴──────────┴─────────┴────────┘
```
Rooms are Tiled object layers with a `room` property; each has a sign like Gather ("DEV TEAM", "QA LAB"…).

`map.json` (logical, shared by both views):
```json
{
  "grid": { "cols": 64, "rows": 40 },
  "rooms": { "dev": {"x":14,"y":0,"w":22,"h":12}, "qa_lab": {"x":36,"y":0,"w":12,"h":12}, "...": {} },
  "desks": { "shopify-dev": {"x":16,"y":4,"face":"up"}, "qa-lead": {"x":40,"y":5,"face":"up"}, "...": {} },
  "spots": {
    "coffee":      [{"x":30,"y":30,"pose":"hold_mug"}, {"x":32,"y":31,"pose":"sit_sofa"}],
    "lounge_sofa": [{"x":55,"y":33,"pose":"sit_sofa"}],
    "ping_pong":   [{"x":40,"y":30,"pose":"play","pair":1}, {"x":44,"y":30,"pose":"play","pair":1}],
    "foosball":    [{"x":41,"y":35,"pose":"play","pair":2}, {"x":43,"y":35,"pose":"play","pair":2}],
    "lobby":       [{"x":58,"y":34,"pose":"sit_couch"}, {"x":60,"y":30,"pose":"stand_phone"}],
    "boardroom":   [{"x":3,"y":3,"pose":"sit_meeting"}, "..."],
    "qa_bench":    [{"x":42,"y":8,"pose":"inspect"}]
  }
}
```

## 4. Behaviour: status → what you see

| Agent state (from DB) | Where | Animation | Over the head |
|---|---|---|---|
| `working` | Own desk | Sitting, typing; monitor glows with a mini thumbnail of their POV | Green dot · name · short task label on hover |
| `working` + task in QA | Own desk | Leaning back, sipping coffee at desk | Hourglass "Waiting for QA" |
| QA Lead reviewing | QA Lab bench | Inspecting a big screen | Green dot · "Reviewing: Madam Muse bundle page" |
| Planning (request in `planning`/`plan_review`) | **Boardroom**: COO + every agent named in the plan walk in | Sitting around the table, COO at the screen | Purple "Meeting: Madam Muse launch" label on the room |
| `waiting` (needs you) | Own desk | Standing, hand raised | Purple ✋ pulse; click = open the approval |
| `blocked` | Own desk | Head in hands | Red ⚠ + reason on hover |
| `idle` | Random break spot (see 5) | Coffee, sofa, ping-pong, foosball, chatting, phone in lobby | Amber dot · "On break" |
| `offline` / disabled | Own desk | Chair empty, monitor off | Grey dot |

Transitions are **walks**, not teleports: when a task is claimed, the character gets up from the lounge and walks back to the desk (typically 2–4 seconds). When the plan is approved, meeting attendees walk out of the boardroom to their desks.

## 4b. Human-like motion (nobody ever stands frozen)

Every character is always doing something natural, like a real person at work. Each state has a **main loop** plus **micro-actions** that play at random every 6–20 seconds (different timing per agent so the office never moves in sync).

**Working: role-specific main loop at the desk**

| Agent | Main working loop | Micro-actions (random) |
|---|---|---|
| Dev agents | Typing fast, eyes on monitor, code scrolling on screen | Lean in to read, rub chin, sip coffee, glance at second monitor, crack knuckles, lean back thinking |
| SEO writers, Social, EA, Pipeline, Job Scout, Client Success | Typing in bursts, reading | Scroll with mouse, nod, take a note on paper, stretch arms, sip drink |
| UI/UX & Graphic designers | Drawing on a pen tablet, zooming the artboard | Tilt head at the screen, hold up colour swatch, sketch on paper |
| Video Editor | Scrubbing a timeline with jog wheel/mouse, headphones on | Replay a clip (nods to rhythm), lean back to watch, drag clips |
| Sound & Voice Specialist | In the vocal booth: speaking into the mic with hand gestures, or at the mixer adjusting faders | Adjust headphones, lift a hand to listen closely, check waveform |
| COO | At the whiteboard writing/pointing, or at desk on a call | Walk to a colleague's desk and back (when planning), check tablet |
| QA Lead | Leaning into the screen with the magnifier, clicking through pages | Tick a checklist, compare phone vs desktop, rub eyes, thumbs-up (on pass) |

**Idle: activity loops**

| Activity | Main loop | Micro-actions |
|---|---|---|
| Coffee | Waits at the espresso machine, then sips standing at the bar | Blows on cup, chats with neighbour, checks phone |
| Lounge sofa | Sits back relaxed | Crosses legs, scrolls phone, laughs, stretches |
| Lobby | Sits on couch or stands at window | Reads a magazine, looks at the view, phone call pacing |
| Ping-pong / foosball | Real rallies with a partner (paired animation) | Celebrates a point, groans, high-five at the end |
| Chat | Two agents standing and talking | Hand gestures, laughing, nodding, pointing at a phone |

**State changes are always acted out:** getting up from the chair, pushing it in, walking (natural walk cycle with slight speed variation), sitting down, and settling in before typing. Finishing a task plays a small "done" gesture (stretch, fist pump) before walking to a break spot. A QA fail plays a head-scratch; a pass plays a nod. A raised hand (needs you) alternates with looking toward the CEO office.

**Implementation:** each character is a small state machine (`walk → arrive → settle → main loop ⇄ micro-action`), driven by `agents.status`/`idle_activity` from the database, with local randomness only for micro-action timing (so it never needs extra server calls). The 3D pipeline (§10) produces every clip above as a sprite animation; required clips per character: walk ×4 directions, sit-down, stand-up, type, read/scroll, drink, stretch, talk-gesture, raise-hand, head-scratch, celebrate, plus the role-specific loops.

## 5. Idle life (random but shared)

The **worker** decides idle activities so every screen shows the same office:
- Every 60–120 s each idle agent may switch activity (weights: coffee 30%, sofa 20%, lobby 15%, ping-pong 10%, foosball 10%, chat with another idle agent 15%).
- Paired activities (ping-pong, foosball, chat) need two idle agents; the worker pairs them, otherwise picks a solo spot.
- Spot capacity is respected; nobody stands on the same tile.
- Writes `agents.idle_activity` (+ `idle_spot`) → Realtime → characters walk there.
- Night mode (after 20:00 Manila, if quiet): idle agents sit in the lobby; lights dim.

## 6. POV: see what an agent is working on

Click a character (or walk your CEO avatar next to their desk) → the **POV panel** slides in: a big "monitor" showing that agent's screen, updating live.

| Agent is doing | Monitor shows (app frame) | Source |
|---|---|---|
| Writing code (dev agents) | **Editor**: file name tab + code streaming in, diff highlights | `agent_screens.content` from file-write tool calls |
| Checking a site / theme preview | **Browser**: address bar + screenshot, refreshed each step | Playwright screenshot → Supabase Storage → `image_url` |
| Writing articles, emails, captions, proposals | **Doc**: text appearing paragraph by paragraph | Draft text from tool calls / streamed output |
| Lead Finder research | **Leads**: table filling in (company, platform, signal, score) | `rizehub_refs` + lead notes |
| Job hunting | **Job board**: listings with fit scores, draft on the right | `job_opportunities` |
| Reports | **Report**: charts from RizeHub + summary being written | RizeHub `preview_url` screenshot + notes |
| QA | **Review**: checklist ticking pass/fail, evidence screenshots | `qa_reviews.checks` as they are written |
| Planning (COO) | **Whiteboard**: task cards and arrows forming | Plan JSON as it is built |
| Video editing | **Edit timeline**: clips on tracks, current frame preview, render progress | Frame grabs + edit steps from the video tools |
| Voice / sound work | **Audio workstation**: waveform, script line being voiced, play button for the latest take | Generated audio file URL + script text |
| Idle | Screensaver with the RizeHub logo | none |

Under the monitor: **step log** ("Reading brand.md → Writing bundle-hero.liquid → Taking mobile screenshot → Fixing CTA overflow"), progress bar, elapsed time, cost so far, and buttons **Chat · Pause · Open task · Open approval**.

How it's fed: the runner's `onStepFinish` (05) updates one row per agent in `agent_screens` (app, title, trimmed content, screenshot URL, one-line step note, progress). Realtime pushes it to the panel, so there is no video streaming and it stays light.

Safety: the screen feed passes the same redaction as logs (tokens, emails of third parties, keys removed); screenshots come only from staging/unpublished previews.

## 7. Chat with any agent

Chat tab in the same panel (also `/ask <agent> <question>` in Telegram).

- **"What are you doing?"** → answered in character from live state: task, progress, last steps, blockers, what's next. Example: *"Building the Madam Muse bundle hero section. About 60% done. Mobile CTA was overflowing at 375px, I just fixed it and I'm taking new screenshots before sending it to QA. Should be ready in about 10 minutes."*
- **Questions about their work** ("why did you pick that headline?") → answered from the task log and output.
- **Instructions** ("do the mobile version first", "pause and help with the Vinyl report") → the agent confirms, and the message becomes a request to the COO (normal approval flow). The chat shows a link to that request.
- Uses the cheap/fast `light` model role (see 14); it reads state and never interrupts the running task.
- Stored in `agent_messages`; each agent keeps its chat history.

## 8. You in the office (CEO avatar)

- Your character sits in the CEO Office. Move with click-to-walk or WASD/arrow keys; the camera follows.
- Walk near a desk → a small popover (name, task, progress) appears; press `E` or click to open the POV panel.
- Walk into the Boardroom during a planning meeting → the plan approval opens right there.
- Optional: "Spectator mode" (no avatar, just pan and zoom), which is the default on phones.

## 9. Characters

One consistent character style (semi-realistic, friendly office workers), each role with a signature look so you recognise them instantly:

| Agent | Look |
|---|---|
| COO | Blazer, tablet in hand |
| EA & Report Desk | Headset, folders |
| Client Success | Lanyard badge, welcoming smile |
| Pipeline Desk | Rolled-up sleeves, clipboard |
| Social Prospecting | Binoculars on desk, cap |
| Social + Inbound | Phone in hand |
| Job Scout | Backpack, map pins |
| Shopify / Webflow / WordPress / Full-Stack | Headphones; green / indigo / navy / hoodie outfits |
| UI/UX ×2 | Beret, stylus |
| Graphic ×2 | Paint-splash apron |
| Social Media ×2 | Trendy jacket, ring light on desk |
| SEO Writer ×2 | Glasses, stack of books |
| QA Lead | Lab coat, magnifier |
| Video Editor | Beanie, clapperboard on desk; works in the edit bay |
| Sound & Voice Specialist | Big studio headphones; records in the vocal booth (mic + pop filter) |
| You (CEO) | Your likeness: short dark-brown textured quiff, light stubble, small stud earring, black ribbed turtleneck, charcoal trousers, white sneakers (concept: Magnific "CEO character sheet") |

**Animations per character:** see §4b for the full clip list (main loops, micro-actions and transitions), plus role-specific loops.

## 10. Producing the art (consistent across both views)

Recommended pipeline so the same characters work in both views:

1. **Design each character** as a turnaround image (Magnific image generation, one base style, per-role outfit prompts).
2. **Make them 3D:** Magnific `models3d_generate` from the turnaround → `models3d_rig` → `models3d_animate` (walk, sit, type, drink, play…).
3. **Render sprite sheets in Blender** (free) from the 2:1 isometric camera (main view), with transparent background. Add a top-down camera later for the optional view; the same 3D models keep characters identical in both.
4. **Office furniture/props:** generate or model the key props (desks with monitors, espresso bar, sofas, ping-pong, foosball, plants), render them from both cameras, and assemble in Tiled.
5. Match the concept: warm daylight, glass partitions, oak desks, concrete floor, rugs and plants, and a city skyline through the windows (a painted background layer behind the floor).

Budget for art: most of the effort in this milestone is art, not code. Start with placeholder shapes and names (the logic works with coloured circles), and swap in the real art when it's ready.

## 11. Performance & mobile

- 30 fps cap; pause rendering when the tab is hidden; only animate characters on screen.
- Texture atlases per view; lazy-load the isometric assets only when that view is chosen.
- Phones: spectator mode, pinch-zoom/pan, tap = POV panel as a bottom sheet. The Grid view (06) stays available as a lightweight fallback.

## 12. Build phases

| Phase | What | Result |
|---|---|---|
| **A1** | Isometric Tiled map with simple placeholder blocks for furniture; characters as coloured figures with names; status → position (desk vs lounge) with walking and depth sorting | The office works with live data |
| **A2** | POV panel (`agent_screens`) + chat (`agent_messages`) | You can see and ask what anyone is doing |
| **A3** | Real isometric art from the 3D pipeline: characters with animations, furniture, room signs, daylight/night lighting, city view | Looks like the chosen concept |
| **A4** | Boardroom meetings, QA Lab reviews, paired idle games, CEO avatar, ambient animations (coffee steam, screen glow) | Feels alive |
| **B1** (optional) | Top-down view from the same logical map + top-down renders of the same 3D models | Lighter view / phone fallback |
