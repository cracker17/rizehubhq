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
| Map data | `apps/dashboard/office/layout.json` over the painted background | Rooms, seats, idle spots and walking paths as coordinates on the picture |
| Walking | Shortest path on the layout's walk graph | Characters use corridors and doors, never walk through glass |
| Live data | Supabase Realtime → Zustand store → Phaser scene | Same store feeds the grid view, KPIs and badges |
| UI over the map | React (shadcn) panels on top of the canvas | Name tags, POV panel, chat, tooltips stay crisp and accessible |

## 3. Floor plan (the painted office)

The office is the approved reference picture (`assets/office/reference-office.png`), cleaned of people and
baked-in text (`public/office/office-bg.webp`, see `scripts/office/README.md`). Everything the logic needs is
coordinate data in **`apps/dashboard/office/layout.json`**, in pixels of the 1x reference picture:

| Key | What |
|---|---|
| `grid` | Affine picture ⇄ tile transform (tile x = down-right, tile y = down-left), so the iso facings still work |
| `rooms` | Dev Team, Design Studio, Growth & Sales, QA Lab, Boardroom, CEO Office, Reception, Coffee Corner, Lounge (fireplace), Game Hall, Gym — each with its sign position (HTML pill) |
| `desks` | Every desk seat (4 Dev, 2 Design, 2 Growth & Sales, 2 QA Lab, the Boardroom head seat, the CEO desk) with facing, `chair` (an animated office chair stands there) and either monitor quads (painted desks) or `desk` (the sprite desk whose monitors it uses) |
| `furniture` | Sprite desks and gym equipment (`public/office/furniture`), placed by their floor anchor; drawn in depth-sorted slices so people pass in front of and behind them |
| `doors` | Doors that swing open (with a sound) when someone walks through: glass doors of the Dev Team, Boardroom, Game Hall, Growth & Sales and the gym; the wooden front doors (they light the doorway) |
| `glassWalls` | Glass the scene draws itself (the gym front) |
| `occluders` | Pieces of the picture redrawn over people standing behind them: the Dev Team's glass front, the lounge sofa's back, the boardroom table |
| `assignments` | `web-dev → dev-1`, `designer → design-1` (nearest the Dev Team), `writer → sales-1`, `sales → sales-2`, `qa-lead → qa-1`, `coo → board-head`. An agent's own `agents.desk.id` overrides this, so a new hire gets a desk without a code change. Unassigned desks stay plain furniture. |
| `spots` | Idle spots: espresso bar, fireside chats, lounge sofas, ping-pong (pair), foosball (pair), arcade, reception, the gym (treadmill, dumbbells); boardroom seats; the CEO chair |
| `visits` | Where the COO stands when handing a desk a task |
| `graph` | Walking network (corridors, doors, aisles). Every seat and spot joins at its `via` node; tests check every pair is reachable |
| `wallScreens` | The Growth & Sales board (live sales pipeline) and the Boardroom TV (live: waiting for your approval, agents working, in review, open requests, tasks done per day for 7 days, QA pass rate) |

Around the picture:
- **Chairs** slide out and swivel towards the aisle when someone walks up or stands up, turn back to the desk as they sit, and fidget a little while they work.
- **Monitors** show what the agent is actually doing: the text / code / deliverable image from `agent_screens`, the current step and progress, in the app that fits the work (editor, doc, design canvas, CRM table, QA checklist).
- **Light** follows the Philippine clock (Asia/Manila): dawn, day, golden hour, dusk and night blend into each other and the lamps and fireplace glow brighter as it gets dark. The toolbar can pin day or night.
- **Music**: a quiet generative lo-fi loop (WebAudio, no files) with a mute button; doors whoosh and click. Sound starts after the first click (browser rule) and the choice is remembered.

## 4. Behaviour: status → what you see

| Agent state (from DB) | Where | Animation | Over the head |
|---|---|---|---|
| `working` | Own desk | Sitting, typing; monitor glows with a mini thumbnail of their POV | Green dot · name · short task label on hover |
| `working` + task in QA | Own desk | Leaning back, sipping coffee at desk | Hourglass "Waiting for QA" |
| QA reviewing | QA Lab bench | Inspecting a big screen | Green dot · "Reviewing: Madam Muse bundle page" |
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
| Web Developer | Typing fast, eyes on monitor, code scrolling on screen | Lean in to read, rub chin, sip coffee, glance at second monitor, crack knuckles, lean back thinking |
| Content Writer, Sales Agent | Typing in bursts, reading | Scroll with mouse, nod, take a note on paper, stretch arms, sip drink |
| Graphic Designer | Drawing on a pen tablet, zooming the artboard | Tilt head at the screen, hold up colour swatch, sketch on paper |
| COO | At the whiteboard writing/pointing, or at desk on a call | Walk to a colleague's desk and back (when planning), check tablet |
| QA | Leaning into the screen with the magnifier, clicking through pages | Tick a checklist, compare phone vs desktop, rub eyes, thumbs-up (on pass) |

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
- Every 60–120 s each idle agent may switch activity (weights: coffee 28%, sofa 18%, lobby 12%, ping-pong 10%, foosball 10%, chat with another idle agent 14%, gym 8%).
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

Painted pose sprites in the same art style as the office (generated with Magnific, one pose sheet per
character so each face and outfit stays consistent): stand, walk, stand (back), walk (back), seated typing
(back), holding coffee, sofa, and an action pose (ping-pong swing; pointing for the COO; waving for the CEO).
Front poses face down-left and back poses up-right; the scene mirrors them for the other two facings.

| Agent | Look |
|---|---|
| COO | Charcoal blazer, white blouse, tablet |
| Web Developer | Navy hoodie, jeans, headphones round the neck |
| Graphic Designer | Black bob, sage knit sweater, cream trousers |
| Content Writer | Curly hair, round glasses, mustard cardigan |
| Sales Agent | Light-blue shirt, sleeves rolled, headset |
| QA | Hair bun, round glasses, olive utility jacket, ID lanyard |
| You (CEO) | Dark-brown textured quiff, light stubble, stud earring, black turtleneck, charcoal trousers, white sneakers |

Motion on top of the poses (so nobody is ever frozen): two-frame walk cycle with bounce, breathing, typing
jiggle when seated, gesture hops (task done, QA pass/fail), stretch micro-actions, and a soft floor shadow.

## 10. Producing the art

See `scripts/office/README.md`: background cleanup (LaMa inpainting of the reference), pose sheets (Magnific),
sprite matting, and `public/office/manifest.json` (pose images + floor anchors per character).

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
