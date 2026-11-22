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

## 1. Put your game files in `game/`

The player takes any mix of these and works out the rest by itself (it looks inside, not only at the names):

| File | Version | Notes |
| --- | --- | --- |
| `PlayhouseInstall2.0.0.exe`, `PlayhouseInstall2.0.3.exe`, `PlayhouseInstall2.0.6.exe` | the version in the name | the installers (Wise). The player reads the game's files straight out of them, nothing is run |
| `Playhouse Disney Preschool Time Online 2.0.6.zip` (or any zip with the game's `Data` folder) | 2.0.6 | the program and its data |
| `PackageBC2.0.3.zip`, `PackageBC2.0.6.zip` … | by name | the shared activities |
| `LP0316_lesson_0316_2.0.3.zip`, `LP0516_lesson_0516_2.0.6.zip` … | by name and lesson number | one lesson each (`LP02xx` = 2.0.0, `LP03xx` = 2.0.3, `LP05xx` = 2.0.6) |
| one big zip that holds several of the above | | the zips inside it must be stored **without compression** (the player cannot read a compressed zip inside a zip in place) |

- The page lists the versions it finds and the lessons of each one. The lesson you pick is the one the game starts with.
- A version needs the game program: an installer, or a zip with `DisneyPO.exe`. **Installers inside a big zip are compressed**, so put the standalone `PlayhouseInstall2.0.3.exe` next to the big zip
