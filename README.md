# Playhouse Disney Preschool Time Online — Re-Educated!

Remember *Playhouse Disney Preschool Time Online*? The classic educational game from Disney Online and ImaginEngine?

Now you can revisit it right in your browser!

This project brings the original Windows game back to life using a JavaScript-powered x86 emulator. It supports versions **2.0.0, 2.0.3, and 2.0.6**, allowing you to play the original game without needing to install it on your computer.

Movies, sounds, activities, and other features are handled by the browser player, with optional Ruffle support for Flash content.

**Please note:** This project does not include the original game files. You'll need to supply your own installers and archives.

## What's Included?

The player supports three releases of *Playhouse Disney Preschool Time Online*:

| Version | Game files |
| --- | --- |
| **2.0.0** | Original game program and associated lesson archives |
| **2.0.3** | Updated game program, shared activities, and lesson archives |
| **2.0.6** | Updated game program, shared activities, and lesson archives |

Each version has its own program and associated data. The player automatically detects the versions and lessons available from the files you provide.

You can supply multiple versions and lessons at once, then select the version and lesson you want to play from the start screen.

---

Runs the original Windows program of *Playhouse Disney Preschool Time Online* (Disney Online / ImaginEngine, versions
2.0.0, 2.0.3 and 2.0.6) in a web browser. The game program (`DisneyPO.exe`) is executed by an x86 emulator written in
JavaScript, with replacement versions of the Windows, Miles sound, Bink video, Smacker video, MP3, network, printer and
Flash-control libraries. Nothing is converted or unpacked: the player reads your installers and zips directly, where they
lie, so every screen, movie and sound behaves as in the original program.

**This folder does not contain the game.** The installers and zips come from your own copy; you put them in the `game/`
folder and host them yourself.

## 1. Put your game files in `game/`

The player takes any mix of these and works out the rest by itself (it looks inside, not only at the names):

| File | Version | Notes |
| --- | --- | --- |
| `PlayhouseInstall2.0.0.exe`, `PlayhouseInstall2.0.3.exe`, `PlayhouseInstall2.0.6.exe` | the version in the name | the installers (Wise). The player reads the game's files straight out of them, nothing is run |
| `Playhouse Disney Preschool Time Online 2.0.6.zip` (or any zip with the game's `Data` folder) | 2.0.6 | the program and its data |
| `PackageBC2.0.3.zip`, `PackageBC2.0.6.zip` … | by name | the shared activities |
| `LP0316_lesson_0316_2.0.3.zip`, `LP0516_lesson_0516_2.0.6.zip` … | by name and lesson number | one lesson each (`LP02xx` = 2.0.0, `LP03xx` = 2.0.3, `LP05xx` = 2.0.6) |
| one big zip that holds several of the above | | the zips inside it must be stored **without compression** (the player cannot read a compressed zip inside a zip in place) |

* The page lists the versions it finds and the lessons of each one. The lesson you pick is the one the game starts with.
* A version needs the game program: an installer, or a zip with `DisneyPO.exe`. **Installers inside a big zip are compressed**, so put
  the standalone `PlayhouseInstall2.0.3.exe` next to the big zip instead.
* The archives are **not** downloaded as a whole. The player asks the server for the pieces the game reads (HTTP Range
  requests), so the game starts after a few megabytes, not after 3.6 GB.
* Which files are used: `serve.py` (section 2) lists the `.zip` and `.exe` files in `game/` by itself, so on your own computer
  you only have to drop the files in. On another web server the player has no way to list a folder: either write a
  `game/files.json` (a JSON array: `["PlayhouseInstall2.0.3.exe", "Big zip.zip"]`, or objects like
  `{"name": "…", "url": "https://other.host/…", "size": 123}`; `files.json.example` shows it), or use the usual names from the table
  (`PlayhouseInstall2.0.6.exe`, `PlayhouseInstallABC2.0.6.exe`, `Playhouse Disney Preschool Time Online 2.0.6.zip`, `PackageBC2.0.6.zip` … for each version).
* The `PlayhouseInstallABC…` installers and the `…-DC.exe` copies are not needed: a version's program comes from its plain
  installer or its zip, and the shared activities from `PackageBC`. An installer with exactly the same contents as another one
  is skipped, and an installer the player cannot read is passed over (the start card mentions it only when that version has
  no other program).
* More lessons can be added later as extra zips (for example `LP0516_lesson_0516_2.0.6.zip`): put them into `game/` and, if you use
  a `files.json`, add them to it.
* You can also use the **Use my own files…** button on the page (or drop files on it) to play from files on your own
  computer. They are read in place by the browser, not uploaded anywhere.

## 2. Try it on your own computer

```
python3 serve.py            # then open http://localhost:8000/ and press Start
```

(On Windows `py serve.py` or `python serve.py` does the same.) The window that runs it says how many files it found in `game/`.

`serve.py` is an ordinary static server that also answers Range requests (Python's built-in `http.server` does not).
Opening `index.html` straight from the disk (`file://`) does not work: the page needs a web server.

## 3. Host it

Upload the whole folder (including `game/`) to any web server or static host. Requirements:

* **HTTP Range requests** must work for the files in `game/` (nginx, Apache, Caddy, IIS, S3/CloudFront and most CDNs do this
  by default). If they do not, the player shows a message saying so.
* Files must be sent **uncompressed** (no `Content-Encoding: gzip` on `.zip`/`.exe`), or byte ranges will not line up.
* Use **https** (or `http://localhost`). Sound, saving and full screen need a secure context in current browsers.
* The game files may live on another host: use `index.html?base=https://files.example.com/pto/` and let that host answer
  CORS requests (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Range`,
  `Access-Control-Expose-Headers: Content-Length, Content-Range`).
* If you add Ruffle (below), the server must send `.wasm` files as `application/wasm`.

## 4. Flash movies (optional: add Ruffle)

Parts of the game (for example the Little Einsteins movies of 2.0.0) are Flash movies. This player does not contain a Flash
player. It works with **[Ruffle](https://ruffle.rs)** (open source, MIT / Apache-2.0 licence) when you put it next to the page:

1. Download Ruffle's **self-hosted web build** from <https://ruffle.rs/downloads> (the zip called "selfhosted").
2. Unpack it into a folder called `ruffle/` next to `index.html`, so that `ruffle/ruffle.js` exists, with the two `.wasm` files
   beside it (about 30 MB in all). (Or keep it anywhere and open the page with `?ruffle=https://…/ruffle.js`.)

Tested with Ruffle 0.8.0. The page only uses Ruffle's documented web API, so newer builds should work as well.

With Ruffle the movie is shown over the game screen while the game waits for it, for the movie's real length, and a **Skip movie**
button is shown. Ruffle is loaded in the background when the game starts (long before the first movie), its own pop-up boxes are
switched off, and the **Sound** button also controls the movies. On a computer whose browser has no hardware graphics
acceleration Ruffle can be slow. Without Ruffle, or with `?ruffle=off`, the game's movie parts are skipped after a moment and the game carries
on (the page says so once). The start card says which of the two applies.

**Two kinds of Flash in the game.** Most are *movies* (the intros): the game watches how far the movie has got and carries on when it
is over; **Skip movie** (or **Esc**) says "it is over". Some are *applications* (in 2.0.3, for example, the day and night menus and the
read-along books; the other versions have them too): the game puts one on screen and then does nothing but wait for its own **Back**
button, which it draws over the application. Ruffle's picture covers that button, so the page shows its own: the button reads **Back**
for an application, and pressing it (or Esc) does what the game's button does and the game carries on. If the game has not closed the
window 2.5 seconds after a skip, the page hides Ruffle's picture anyway so that the game's own screen is what you see.

**Files that an application loads.** An application often loads more files by a relative address (a menu that loads its games, a book
that loads its pages). The original Flash control found them in the game's folders. Ruffle only knows this web page's server, so the page
gives each application a base address of its own (`flashfiles/…`), answers Ruffle's requests for such addresses itself, and gets the
files from the game's data (the zips and installers, wherever the file is in them). Nothing is copied to disk.

**If a Flash screen stays white or does not work:** open the page with `?debug`, get to that screen, press **Copy log** and keep the
text. Its section "Flash movies" says, with times, what the game asked for (movie or application, which file, the movie's size),
what Ruffle did with it (started or not, what it reports about the file), every file the movie asked for and whether the game's data
had it, what Ruffle wrote on the console (including the graphics renderer it chose), and what Skip/Back did.

**If a movie is white although the log shows it started:** Ruffle chooses its graphics backend itself (it uses the graphics card where the
browser offers it), and a driver or browser can draw some movies wrongly. Open the page with `?flashrenderer=canvas` (the plainest one,
drawn without the graphics card) or `?flashrenderer=webgl`, `?flashrenderer=wgpu-webgl` or `?flashrenderer=webgpu` to make Ruffle use
that one instead of its own choice, for example `http://localhost:8000/?debug&flashrenderer=canvas`. The log says which one Ruffle
ended up with.

The interactive Flash applications that 2.0.6 starts through the control's own calls (they talk to the game while they run, and the game
asks them for a result) are not connected yet. They are skipped in both cases, and the page says so.

## 5. Videos for the Sing-Along room (optional)

The Sing-Along room (the TV in the Backyard; the game calls the room "Video") used to load its videos from Disney's servers, which are gone, so
in the original game it is empty. The player can give it videos of your own:

1. Put video files in the `videos/` folder next to `index.html`: `.mp4` (H.264 video with AAC sound plays in every browser) or `.webm`.
   `.m4v`, `.ogv`, `.mov` and `.mkv` are tried as well and play if your browser knows what is inside them.
2. Reload the page (Ctrl+F5). `serve.py` lists the folder for the page by itself (the window that runs it says how many videos it found).
   A web server that cannot list a folder needs a file `videos/videos.json` instead: `["01 - Hot Potato.mp4", "02 - The Wheels on the Bus.mp4"]`,
   or `[{"file": "hot-potato.mp4", "title": "Hot Potato"}]` to choose the name that is shown on the button.
3. Start the game and click the TV in the Backyard. Every video is a button on the TV's screen, with a frame of the video as its picture and its
   name on it; the button lights up under the mouse. A click plays that video on the TV's screen with the browser's own video player (its own
   play / pause, volume and seek controls). When the video ends, the game goes on, as it did when its Flash player had played the video to the
   end. The game's red **X** under the TV stops it.

More about it:

* **Order and names.** The buttons are in the order of the file names, numbers by their value ("2 …" before "10 …"). A number and a dash at the
  start of a file name ("01 - ") only puts the video in its place and is not shown. The more videos, the smaller the buttons: up to 4 videos
  give buttons of 240 × 180 (in the game's 800 × 600 picture), up to 9 give 160 × 120, up to 16 give 120 × 90, up to 25 give 96 × 72 and up to
  36 give 80 × 60. No more than **36** videos fit on the TV; the rest are left out, and the start card says how many.
* **Videos…** on the page, or dropping video files on the page, adds videos from anywhere on your computer. They are not copied: the browser
  reads them in place, and they stay only until the page is closed. They show up the next time the room is opened.
* **A video that the browser cannot play** (an MP4 with another kind of video than H.264, an old Flash `.flv`, …) shows a message on the TV, and
  after a few seconds the game is told that the video is over, so that the room does not get stuck. Such a file can be converted:
  `ffmpeg -i in.flv -c:v libx264 -c:a aac out.mp4`.
* **No videos.** When the room opens with an empty list, one of four spoken clips (`sounds/NOVIDEOS1.mp3` … `NOVIDEOS4.mp3`) is played, picked
  at random but never the same one twice in a row. Clips named `NOVIDEOS5.mp3` … `NOVIDEOS8.mp3` that you put in `sounds/` are used as well.
  The **Sound** button mutes it.
* **How it works.** The room asks a Disney server for a list of its videos and for a picture of each button, and plays a clicked video with a
  small Flash movie (`stub.swf`) that streamed it from that server. The player's stand-in for the server answers those two requests from your
  videos (the button pictures are made by the page: a plain card with the name at first, then a frame of the video), and the page shows the
  video instead of the Flash movie. Nothing is sent over the internet.
* **If the room is empty or a video does not play:** open the page with `?debug`, open the room, press **Copy log**; its section
  "Sing-Along room" says how many videos the page found (and where), what the game was given, what it asked for, which video was played and
  how it ended.
* **Hosting:** upload `videos/` and `sounds/` with the rest. The videos need a server that answers Range requests (they are needed to play
  and to skip about in a video); the file types must be sent with their video types (`video/mp4`, `video/webm`).

## Using it

* Mouse or touch works as in the original. The game uses just two keys: **Esc** skips the intro ("Press Escape to Skip"; while a Flash
  movie or application is on screen the page also takes Esc as **Skip movie** / **Back**) and the
  **space bar** is tapped in Little Einsteins' Blast Off. It has no text entry of its own (the nickname is typed on the start card, see below). In full screen the player asks Chrome and Edge to hand the
  game a short press of Esc (holding Esc then leaves full screen); that one part could not be tried out here. Other browsers keep Esc
  for leaving full screen, so leave it first.
  On phones and tablets buttons for **Esc** and **Space** appear below the picture, next to a **Keyboard** button that brings up the
  on-screen keyboard.
* The game's **Print** button opens a print view on the page: **Print** sends the picture to your printer (or "Save as PDF"),
  **Save picture** downloads it as a PNG, **Close** (or Esc) returns to the game.
* **Full screen**, **Sound** and **Sync** buttons sit below the picture. The game pauses while the tab is hidden.
* **Sound and picture in step.** Sound needs a moment to reach the speakers; the page measures that delay and holds the picture
  back by the same amount, so a picture and its sound arrive together. **Sync** opens a slider for the cases the browser cannot
  know about: if the sound still comes after what you see (Bluetooth speakers and some TVs), move it to the right; if the mouse
  feels slow, move it to the left. The setting is kept in the browser. `?avoffset=120` in the address sets it for one visit.
* Players and settings are kept in the browser (IndexedDB), per site and per browser. **Clear saved data** removes them, and the nickname (below) too.
* **Nickname.** The start card has an optional **Nickname** box. The game shows that name where it would otherwise say "Player" (for
  example "Good Job, Nick!"). It is a **local nickname only**: it is kept in this browser on this computer (in the page's `localStorage`),
  it is **not saved online**, and nothing about it is sent over the internet: the player's built-in stand-in for Disney's server gives it
  to the game, and the game never reaches a real server. The box remembers it for your next visit. It is one name for the whole browser (it does not
  create separate players or separate saves: what the game saves is kept as before). Up to 12 characters: letters, digits, spaces and `'` `.` `-`;
  accents are dropped ("Zoë" becomes "Zoe"), other characters are dropped too, and a name with nothing left counts as no nickname. To remove it, empty the
  box (it is forgotten at once), or use **Clear saved data** while playing. Enter in the box starts the game. A nickname is given to the game when it starts, so a
  changed name shows from the next start on.
* Address options: `?base=URL` (game folder), `?edition=2.0.3&lesson=LP0316` (pre-select a version and lesson), `?ruffle=URL` or
  `?ruffle=off` (see above), `?debug` (frame rate, CPU use, download counters, the picture delay, how many pictures the native drawing routine did, the
  game's own log and the key messages it gets, a **Copy log** button, and the stall recorder described below; `?debug&hle=off` turns the native drawing routine off,
  `?debug&threads=coop` makes the game's threads wait for each other again instead of taking turns, both to compare), `?fixeddate=2009-11-15` (the date the game sees;
  by default it sees today's date), `?avoffset=MS` (see above).
* Slow downloads and short hold-ups of the computer do not disturb the game: its clock stands still while the page waits for a
  file, and a hold-up is taken off its clock, so animations and video clips do not race to catch up. A voice or a sound effect is
  never cut by a hold-up: if the computer is held up while one plays, it waits and goes on where it stopped (see "Voices that were cut off" below).
* The game's online features talk to a built-in stand-in for Disney's server, which says "nothing to report" to almost everything.
  Nothing is sent over the internet. It does answer two things: the game's **session check** (right after it starts, and then every four
  minutes, the game asks the server whether its session is still good, and it stops with "Session Terminated – Please log out and try again"
  when three checks in a row go unanswered, that is, about eight minutes after it started; the stand-in says "yes, still good"), and,
  when you have given a nickname, the question "who is the player" (the answer is the nickname, as the player's first name).

## What is in this folder

```
index.html, main.js     the page: screen, mouse/keyboard, sound start button, version, lesson and nickname choice, Flash layer, print view
worker.js               runs the emulator in a Web Worker, reads the game files with Range requests, saves players
videos.js               the Sing-Along room's videos on the page's side: the list, the button pictures, the player on the TV, the sound of the empty room
audio-worklet.js        plays the game's sound through Web Audio (short fixed queue that never throws a voice away, measures how late the sound is)
emu/*.js                the emulator: x86 compiler (to JavaScript), Windows / Miles / Bink / Smacker / MP3 / network / printer / Flash-control
                        stand-ins, server.js (the stand-in for Disney's server), the readers for zips and Wise installers, and hle.js
                        (the game's picture-drawing routine, run natively)
serve.py                local test server with Range support
game/                   your installers and zips go here (and files.json)
ruffle/                 optional: Ruffle's self-hosted web build
videos/                 optional: your videos for the Sing-Along room (section 5)
sounds/                 the four spoken clips the Sing-Along room plays when it has no videos
LICENSES.txt            licences and credits for the parts this player is built from
```

To update the player, unpack the new files over the old ones: `game/`, `ruffle/` and `videos/` hold your own files and are not part of the update.
Then reload the page with Ctrl+F5 (or Shift+Reload) so that the browser does not keep the old scripts. The players and settings that the game
saved in the browser, and the nickname, stay as they are.

## Status and limits

* Tested in Chromium: start-up, the sign-in and lesson screens, Bink video with sound, MP3 voices and music, Smacker video (2.0.0),
  activities in all three versions, the saving of players, printing (the print view), mouse, touch and the keyboard (Esc, space bar).
  Not every activity of every lesson has been played through; the emulator runs the game's own code, so what works in one
  activity usually works in the others, but gaps in rarely used Windows functions can still show up. If something stops, the red
  panel has a **Copy details** button; keep the text, it names the function involved.
* **Session check and nickname.** The cause of "Session Terminated" was found in the game's own code, and the stand-in's answer was tried on all
  three game programs (2.0.0, 2.0.3, 2.0.6) with the game's check interval set to two seconds instead of four minutes: with the earlier stand-in
  (which answered every request with nothing) the game's count of failed checks rose by one at each check and reached three, the number at which it
  stops; with the present one the game made eleven checks in half a minute and the count stayed at zero. The nickname was checked where the
  game keeps it: the string for the player's first name (the one that holds "Player" otherwise) holds the nickname in all three programs. The real
  four-minute rhythm was run through once, on 2.0.3, for just over nine minutes of game time: the game made its three checks (right after it started and
  after four and eight minutes; the third is where it used to stop), the count stayed at zero and the game kept running. The screens that show the name
  were not all looked at.
* **Sing-Along videos.** The room's side was worked out from the game's own code (2.0.0 and 2.0.3 have the same code for the room, with the same server
  addresses and file names) and tried in the real game with stand-in videos (2.0.3: 5, 9, 16 and 36 buttons, 2.0.0: 16): the game accepted the list and the pictures of the
  buttons, drew them on the TV's screen (the grids fill the screen exactly), lit up the button under the mouse, showed its own
  "Check Back Soon" button where a picture was missing, started its video window when a button was clicked (with the right video), kept asking
  whether the video was over until it was told so, closed the window then and showed its buttons again. The page's side (the list from `videos/`,
  the pictures made from a frame of each video, the player on the TV's screen, the end of a video, a video the browser cannot play, adding by the
  button and by dropping, the sound of the empty room) was tried in headless Chromium with WebM clips. **Not tried:** MP4 (H.264) playback (that
  Chromium has no H.264 decoder; Chrome, Edge and Opera have one), Firefox and Safari, videos of real size and length, and getting to the room by
  clicking the TV in the Backyard with the mouse (in the tests the game was told to open the room itself). The game opens its window for a video
  at the top left of its screen and never moves it, so the page puts the video where the TV's black screen is (161, 78, 480 × 360 in the game's
  800 × 600 picture) instead. If a video does not appear where it should, `?debug` → **Copy log** shows what the page and the game did.
* **Flash** is the part tested least. The game's side (how it starts a movie and decides it is over) was worked out from the game
  itself. With Ruffle 0.8.0 the twelve movies of 2.0.0 (Little Einsteins, Stanley) were played in the page with picture and sound,
  and the real game was played through its first two movies: Ruffle starts a movie within a fraction of a second, **Skip movie**
  ends it at once, a movie ends after its real length, the game carries on after it, and a hidden browser tab pauses the movie
  together with the game. The movies in lessons that were not among the files tested here have not been tried. The *applications*
  (see "Flash movies") were tried only with stand-ins made for the test: the real 2.0.3 game was made to run its own application loop on
  a small Flash file, that loop never ended by itself, and **Back** ended it within a frame; the page loaded a second file out of the
  game's data for it through Ruffle. The real applications' files (the day / night menus, the read-along books) were not available
  here, so how Ruffle copes with them is not known; the Flash section of **Copy log** is there for that. The interactive Flash
  applications of 2.0.6 are not connected yet: they are skipped.
* **Drawing speed.** The game puts every picture on the screen with one routine of its own that blends it in, pixel by pixel. The routine is
  written for the processor's MMX instructions, which the emulator does not offer, so the game falls back to a plain per-pixel loop, and that
  is slow when it is emulated. In scenes with big moving pictures (for example *Letter and Number Hide and Seek*, the first activity of every
  2.0.6 lesson) that one routine used almost all of the emulator's time and the game lagged. The player now recognises the routine by its code
  (it is the same in 2.0.3 and 2.0.6; 2.0.0 does not have it) and does the same work as ordinary JavaScript, about 17 times faster, with
  identical pixels: a test compares the two on random pictures, and 29,541 real calls were checked against the game's own routine in the running
  game without a single difference. Pictures the routine does not handle (stretched ones, a few special blend modes) still go to the game's code.
  If the routine is not found (another build of the game), the game does the work itself, only slower. `?debug` shows the number of native pictures.
  A second routine is done natively in the same way: the **colour-key copy** of one 16-bit picture into another, which the game uses for
  pictures that have no alpha channel and just a colour that stands for "see-through". The drawers of the Bear lesson's cabinet game
  (*Letter and Number Hide and Seek* in 2.0.3) are big, mostly see-through pictures drawn that way, and the emulated loop (seven or eight
  instructions for every pixel, a large part of every frame in that scene) made every frame slow. All three versions (2.0.0, 2.0.3, 2.0.6)
  have this routine; the native copy was checked against the game's own on 4,500 random copies without a difference.
* **A moving mouse no longer holds the game up.** Every movement of the mouse used to be queued as a message of its own, and the game takes
  one message per frame. In a scene whose frames take longer than the time between two mouse moves the queue never ran empty, and the player
  only gave the game's picture to the page when the queue was empty: the screen froze while the mouse moved (about 12 seconds in the cabinet
  game, until the game had worked through the old moves) and the game answered where the mouse had been, not where it is. As on Windows,
  a mouse move now replaces one the game has not taken yet, and a game that finds a message at every look into its queue still comes back to
  the player once per frame.
* **The game's threads take turns.** The game has a few threads of its own (one keeps its network connection going in the background, for
  example). Windows lets threads take turns; the emulator used to let a thread run until it waited for something, so a thread that
  worked for a long time without waiting could keep the thread that draws the game from running at all (the picture would stand still
  with the processor at 100 %). The emulator now hands the processor on after every slice of work, as Windows does. This turned out not to
  be the cause of the stall in the Bear lesson's cabinet game (a stall report from that scene shows the thread that draws the game
  working the whole time and the other thread waiting; the causes were the two items above), but the change stays: it is how Windows
  behaves.
* **Voices that were cut off (the "Today is ..." line).** Two different things could cut a voice short; the player now guards against both.
  1. *A wrong number in the sound file itself.* This is what cut Bear's "Today is ..." voice (`Bear/P0100_BEA_TOD_01150.wav`). The header of the file
     says that it holds 42,496 samples; its data holds 167,660 (7.6 s). The original game evidently does not go by that number, the earlier player
     did, and so it stopped the voice after 1.9 s and the scene went on. (In the video of the cut the voice lasts about 1.9 s.) Now a number in the header that is more than one block away from what the data holds is not believed, all of the data is played, and
     `?debug` says so with a `NOTE:` line (see below). The first log of a real run with v1.8 showed it: `voice ends: ... (7.6 s of 7.6 s)`.
  2. *The player being held up while a voice plays.* When a scene starts, the game starts its voice and loads the scene's big pictures at the same
     time. If the emulator is held up then (a garbage collection, a busy computer, a long piece of work), the game's clock goes on but its sound
     cannot be made, and the earlier player skipped the sound that had been missed: a long voice lost its middle while the game still ended it on
     time. In a test, a hold-up of 1.2 s just after a voice of 10 s began took about 2.2 s out of it. This is **not** what cut the Bear voice (the
     log of the real run shows no hold-up while it played), but it can do the same to any long voice. Now a sound that the game plays through its
     sound library goes on where it stopped: for the game a voice simply takes a little longer. The page's sound player does not throw a voice or a
     sound effect away either (it keeps up to about 1.5 s of such sound waiting; if there is more, the oldest goes after all); music that repeats can
     still be skipped over a hold-up. If the page itself was held up (the computer is busy with something else) a voice that arrives late is
     played whole and runs up to 1 % fast until it has caught up, which cannot be heard, so it can be a little behind the picture for a while. The
     sound of a video clip still skips together with its pictures.
     This was tried in Chromium with the real player and the real game (2.0.6), with a stand-in for the voice (a ten-second tone file with a click
     every second and an end marker): a hold-up of 1.2 s put in just after the voice began made the earlier player lose 2.2 s of it, the present
     one played all of it, with a pause as long as the hold-up; a page held up for 0.6 s cost the earlier player 0.56 s of it, the present one
     nothing.
  If a voice is still cut, `?debug` says what happened to it.
* **Sound notes in the log (`?debug`).** For every voice of 1.5 s or more the log has lines starting with `[sound]`: `voice starts: <file> (<seconds> s)`,
  `voice ends: <file> (<heard> s of <total> s)`, `voice stopped by the game: ...` when the game itself ended it early, `the game was busy for <N> ms while
  "<file>" played: the sound waited and went on, nothing was skipped` (hold-ups of 150 ms and more), and `NOTE:` lines when a sound file is shorter than
  its header says ("is cut short") or its header counts the samples wrongly ("says that it holds N samples, but its data holds M": the player then plays all of the data). **Copy log** has a section of its own for them
  (the end of the log used to push them out), and the line of figures at the top shows how long the sound fell behind the game in all.
* **Stall recorder (`?debug`).** When the game goes on for 0.4 s or more without coming back to its message loop (no "game tick"), the page
  gets no new pictures from it. In `?debug` the player then notes what the game is doing: which blocks of its code run most often (counted on one slice of work in three, so as to slow the game down less), what
  called them, which Windows / DirectDraw / sound / video functions it calls and how often, which thread works, and what the drawing routine does.
  One short report per stall is written to the log (lines starting with `[stall]`; stalls shorter than 0.7 s are not reported), and a long
  stall is reported again every five seconds. **Copy log** puts the statistics, these notes and the end of the log on the clipboard, which is
  what to send with a bug report. While the game works for a long time without a tick the page keeps showing the pictures the game has
  drawn so far (about 30 a second) and keeps the sound going.
* A short pause when a new scene starts (about one to one and a half seconds for the big ones such as Hide and Seek, on the test machine) is the
  browser's JavaScript engine meeting the game's code for the first time and unpacking the scene's large pictures. It happens once per scene and
  visit.
* Text drawn through Windows uses the browser's Arial / Liberation Sans, so letter shapes can differ slightly from Windows.
* Only Chromium (Chrome / Edge) was tried. The page uses only standard web features (Web Workers, OffscreenCanvas,
  AudioWorklet, IndexedDB) that current Firefox and Safari (16.4 or newer) also provide; if something misbehaves there, try
  Chrome or Edge first.
* The 2.0.6 "Post Card" theme shows an empty picture with the files tested here (its image files were not in the zips supplied).

## Troubleshooting

| Message | What to check |
| --- | --- |
| "No game files were found" | the file names in `game/` and `files.json`, and that the folder is reachable at that address |
| "The files found do not make up a complete game yet" | a version needs an installer or a zip with `DisneyPO.exe`; the notes on the card say what is missing |
| "The web server does not support HTTP Range requests" | use `serve.py`, or enable range requests / turn off compression on your server |
| "… is compressed inside … and cannot be read in place" | a zip or installer inside a big zip is compressed; put it next to the big zip as its own file |
| Red panel with "error in the emulator" | press **Copy details** and keep the text |
| "Session Terminated – Please log out and try again" about eight minutes after the game started | older files of this player did not answer the game's session check; copy the new player files over the old ones (your `game/` and `ruffle/` folders stay as they are) and reload with Ctrl+F5 |
| The nickname is not shown | it is given to the game when the game starts: set it on the start card before pressing **Start**; only some screens show a name (for example "Good Job, …!") |
| A movie part is skipped | see "Flash movies" above: Ruffle must be in `ruffle/` |
| The Sing-Along room (the TV in the Backyard) has no videos | put video files in `videos/` and reload with Ctrl+F5; the start card says how many the page found; see section 5. With none, the room only plays a spoken clip |
| A button in the Sing-Along room says "Check Back Soon" | the game did not get a picture for that button (it uses its own plain one); the video still plays when it is clicked. Copy the log (`?debug`) if it happens for every button |
| "This browser cannot play …" on the TV | the file's video or sound is of a kind the browser does not know; convert it to MP4 (H.264 + AAC), see section 5 |
| A Flash screen stays white, or **Skip movie** / **Back** does nothing | open the page with `?debug`, reproduce it, press **Copy log**; the "Flash movies" section says what happened (see "Flash movies"); a white movie may also draw correctly with `?flashrenderer=canvas` |
| A voice (for example the "Today is ..." line) is cut off or has a gap | open the page with `?debug`, play to that point and press **Copy log**; the "sound" section says what happened to that voice: `voice ends: ... (X s of Y s)` with X below Y means that the game ended it early (a line `voice stopped by the game` is there too) or that the file is shorter than it should be (a `NOTE:` line); `the game was busy for N ms` lines mean that the computer was held up while it played (the voice waits and goes on, it is not cut). Keep that section for a report |
| No sound | check the **Sound** button and the system volume (browsers only allow sound after a click, which is what **Start** is for) |
| Sound is late or early compared with the picture | open **Sync** and move the slider |
